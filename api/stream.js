/* ============================================================
   api/stream.js — Entrega de áudio (Versão Final Auditada)
   ------------------------------------------------------------
   Correções aplicadas (auditoria stream 4):
   - RATE_LIMIT_UNAVAILABLE / RATE_LIMIT_ERROR → 503 (não 429)
   - IP ausente/unknown → 503 (não compartilha chave 'unknown')
   - Rate limit por hash SHA-256 do IP (privacidade no Redis)
   - X-Request-Id no header de resposta
   - X-Content-Type-Options: nosniff

   FONTE DE VERDADE DE PUBLICAÇÃO:
     - `tracks.status = 'PUBLISHED'` é a regra.
     - `tracks.published` (boolean) é legado do schema antigo.
       Se os dois divergirem, o status vence.
     - TODO (schema): sincronizar published=status='PUBLISHED'
       em migração e remover a coluna booleana quando todos os
       consumidores usarem `status`.

   DECISÃO `locked` (Opção C):
     - locked NÃO afeta autorização.
     - Só assinatura/aluguel libera full.
     - Para mudar, ver comentário no bloco de seleção.

   PREMISSAS CONFIRMADAS (auditoria 4):
     - ALLOWED_ORIGINS é Set<string>
     - getAuthUser(req) retorna null em sessão inválida
     - checkAndIncrement(name, max, windowMs, opts) existe
       e retorna { limited, retryAfter, reason? }
     - Timestamps das colunas de assinatura/aluguel são
       mode: 'string' (comparáveis com ISO)
     - getPlaybackUrl(key, signed) assina com TTL de 300s

   PENDÊNCIA (não bloqueante):
     - Confirmar no Worker da CDN se encodeStorageKey não
       causa dupla decodificação em %XX.
   ============================================================ */

'use strict';

const crypto = require('crypto');
const { eq, and, gt, lte, or } = require('drizzle-orm');
const { db } = require('./_db');
const {
  tracks,
  albums,
  rentals,
  subscriptions
} = require('../src/schema.js');
const {
  getAuthUser,
  clientIp,
  checkAndIncrement,
  ALLOWED_ORIGINS
} = require('./_lib');
const { getPlaybackUrl } = require('./_storage');

const CDN_BASE =
  process.env.CDN_BASE_URL ||
  'https://josephmatthos-cdn.emerson-mattos00.workers.dev';

// Coerente com o TTL da URL assinada do B2 (300s).
const PLAYBACK_TTL = 300;

// Rate limit: 60 req/min por IP (hash).
const STREAM_RATE_MAX = 60;
const STREAM_RATE_WINDOW_MS = 60 * 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function sendError(res, status, error) {
  return res.status(status).json({ ok: false, error });
}

function encodeStorageKey(key) {
  return String(key)
    .replace(/^\/+/, '')
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return null;
  }
}

function applyCors(req, res) {
  const origin = normalizeOrigin(req.headers.origin);
  if (!origin) return;
  if (!ALLOWED_ORIGINS || !ALLOWED_ORIGINS.size) return;

  const allowed = [...ALLOWED_ORIGINS]
    .map(normalizeOrigin)
    .filter(Boolean);

  if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

function hashIp(ip) {
  return crypto
    .createHash('sha256')
    .update(String(ip))
    .digest('hex')
    .slice(0, 32);
}

module.exports = async function stream(req, res) {
  const requestId = crypto.randomBytes(6).toString('hex');

  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    if (res.getHeader('Access-Control-Allow-Origin')) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      return res.status(204).end();
    }
    return res.status(405).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return sendError(res, 405, 'Método não permitido.');
  }

  try {
    /* ── 1. Identificação do IP ── */
    const ip = clientIp(req);

    if (!ip || ip === 'unknown') {
      console.error('[stream] ip-ausente:', requestId);
      return sendError(
        res,
        503,
        'Não foi possível identificar a conexão.'
      );
    }

    /* ── 2. Rate limit (por hash do IP) ── */
    const ipHash = hashIp(ip);

    let limit;
    try {
      limit = await checkAndIncrement(
        `stream:${ipHash}`,
        STREAM_RATE_MAX,
        STREAM_RATE_WINDOW_MS,
        { failClosed: process.env.NODE_ENV === 'production' }
      );
    } catch (err) {
      console.error('[stream] rate-limit:', requestId, err?.code || err?.name);
      return sendError(res, 503, 'Serviço temporariamente indisponível.');
    }

    // Falha do Redis ≠ excesso de requisições.
    if (
      limit?.reason === 'RATE_LIMIT_UNAVAILABLE' ||
      limit?.reason === 'RATE_LIMIT_ERROR'
    ) {
      console.error(
        '[stream] rate-limit indisponível:',
        requestId,
        limit.reason
      );
      res.setHeader('Retry-After', String(limit.retryAfter || 60));
      return sendError(res, 503, 'Serviço temporariamente indisponível.');
    }

    if (limit?.limited) {
      res.setHeader('Retry-After', String(limit.retryAfter || 60));
      return sendError(res, 429, 'Muitas requisições.');
    }

    /* ── 3. Validação do trackId ── */
    const rawTrackId =
      typeof req.query?.trackId === 'string' ? req.query.trackId : '';

    const trackId = rawTrackId.trim();

    if (!validUuid(trackId)) {
      return sendError(res, 400, 'Identificador de faixa inválido.');
    }

    /* ── 4. Faixa publicada (status é a fonte de verdade) ── */
    const [track] = await db
      .select()
      .from(tracks)
      .where(
        and(
          eq(tracks.id, trackId),
          eq(tracks.status, 'PUBLISHED')
        )
      )
      .limit(1);

    if (!track) {
      return sendError(res, 404, 'Faixa não encontrada.');
    }

    /* ── 5. Álbum publicado (se houver) ── */
    if (track.albumId) {
      const [albumRow] = await db
        .select({ id: albums.id, published: albums.published })
        .from(albums)
        .where(
          and(
            eq(albums.id, track.albumId),
            eq(albums.published, true)
          )
        )
        .limit(1);

      if (!albumRow) {
        return sendError(res, 404, 'Faixa não encontrada.');
      }
    }

    /* ── 6. Usuário ── */
    const user = await getAuthUser(req);
    const nowIso = new Date().toISOString();

    let accessLevel = 'preview';
    let authCheckFailed = false;

    /* ── 7. Assinatura ativa e vigente ── */
    if (user?.id) {
      try {
        const [sub] = await db
          .select()
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, user.id),
              eq(subscriptions.status, 'ACTIVE'),
              lte(subscriptions.currentPeriodStart, nowIso),
              gt(subscriptions.currentPeriodEnd, nowIso)
            )
          )
          .limit(1);

        if (sub) accessLevel = 'full';
      } catch (err) {
        console.error('[stream] assinatura:', requestId, err?.code || err?.name);
        authCheckFailed = true;
      }
    }

    /* ── 8. Aluguel ativo e vigente ── */
    if (user?.id && accessLevel !== 'full' && !authCheckFailed) {
      try {
        const rentalTarget = track.albumId
          ? or(
              eq(rentals.trackId, track.id),
              eq(rentals.albumId, track.albumId)
            )
          : eq(rentals.trackId, track.id);

        const [rent] = await db
          .select()
          .from(rentals)
          .where(
            and(
              eq(rentals.userId, user.id),
              eq(rentals.status, 'ACTIVE'),
              lte(rentals.startsAt, nowIso),
              gt(rentals.expiresAt, nowIso),
              rentalTarget
            )
          )
          .limit(1);

        if (rent) accessLevel = 'full';
      } catch (err) {
        console.error('[stream] aluguel:', requestId, err?.code || err?.name);
        authCheckFailed = true;
      }
    }

    /* ── 9. Falha de autorização → 503 ── */
    if (authCheckFailed) {
      return sendError(
        res,
        503,
        'Não foi possível verificar seu acesso. Tente novamente.'
      );
    }

    /* ── 10. Seleção rígida do arquivo ──
       DECISÃO Opção C: `locked` NÃO afeta autorização.
       Para Opção A: if (track.locked === false) accessLevel = 'full';
       Para Opção B: if (track.locked === false && user?.id) accessLevel = 'full';
    */
    const isFull = accessLevel === 'full';

    const originalKey = isFull
      ? (track.streamKey || track.fullPath)
      : (track.previewKey || track.previewPath);

    if (!originalKey) {
      if (!isFull) {
        return sendError(
          res,
          403,
          'Prévia indisponível. Assine ou alugue para ouvir a faixa completa.'
        );
      }
      return sendError(
        res,
        404,
        'Arquivo de áudio completo não configurado.'
      );
    }

    /* ── 11. Resposta ── */
    const wantsJson =
      String(req.query?.format || '').toLowerCase() === 'json';

    if (isFull) {
      let signedUrl;
      try {
        signedUrl = await getPlaybackUrl(originalKey, true);
      } catch (err) {
        console.error('[stream] signed-url:', requestId, err?.code || err?.name);
        return sendError(res, 503, 'Serviço de áudio indisponível.');
      }

      if (wantsJson) {
        return res.status(200).json({
          ok: true,
          audioUrl: signedUrl,
          expiresIn: PLAYBACK_TTL,
          source: 'full'
        });
      }
      return res.redirect(302, signedUrl);
    }

    const cleanKey = encodeStorageKey(originalKey);
    const cdnUrl = `${CDN_BASE.replace(/\/+$/, '')}/${cleanKey}`;

    if (wantsJson) {
      return res.status(200).json({
        ok: true,
        audioUrl: cdnUrl,
        expiresIn: null,
        source: 'preview'
      });
    }
    return res.redirect(302, cdnUrl);
  } catch (error) {
    console.error('[stream] erro:', requestId, error?.code || error?.name);

    if (!res.headersSent) {
      return sendError(res, 503, 'Não foi possível disponibilizar o áudio.');
    }
  }
};