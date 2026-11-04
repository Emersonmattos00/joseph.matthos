/* ============================================================
   api/stream.js — Entrega de áudio (Versão Final para Testes)
   ------------------------------------------------------------
   IMPORTANTE:
   - Rate limit DESATIVADO temporariamente (checkStreamRateLimit
     do _cache.js retorna { success: true } e o stream.js NÃO
     chama mais a função para evitar dependência circular).
   - Fallback: usa stream_key quando preview não está preenchido.
   - cleanKey remove prefixos comuns (josephmatthos/, audio/...).
   - Verifica published/status/album e aluguel com startsAt.
   - Suporta format=json para renovação do player.
   ============================================================ */

'use strict';

const { eq, and, gt, lte, or } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, albums, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser, clientIp, ALLOWED_ORIGINS } = require('./_lib');
const { getPlaybackUrl } = require('./_storage');

const CDN_BASE = process.env.CDN_BASE_URL || 'https://josephmatthos-cdn.emerson-mattos00.workers.dev';
const PLAYBACK_TTL = 3600;

function sendError(res, status, error, message) {
  return res.status(status).json({
    ok: false,
    error,
    ...(message ? { message } : {}),
  });
}

function validUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function corsHeadersFor(req, res) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return;

  if (!ALLOWED_ORIGINS.size) {
    console.warn('[stream] ALLOWED_ORIGINS não configurado — bloqueando CORS.');
    return;
  }
  for (const allowed of ALLOWED_ORIGINS) {
    if (origin === allowed.replace(/\/+$/, '')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      return;
    }
  }
}

module.exports = async function stream(req, res) {
  corsHeadersFor(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'Método não permitido.');
  }

  try {
    // ── 1. Validação do trackId ──
    const trackId = String(req.query?.trackId || '').trim();
    if (!validUuid(trackId)) {
      return sendError(res, 400, 'Identificador de faixa inválido.');
    }

    // ── 2. Rate limit: DESATIVADO (apenas log) ──
    const ip = clientIp(req);
    console.log('[stream] Requisição:', { ip, trackId });

    // ── 3. Busca da faixa ──
    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return sendError(res, 404, 'Faixa não encontrada.');

    if (track.published !== true || track.status !== 'PUBLISHED') {
      return sendError(res, 404, 'Faixa não disponível.');
    }

    if (track.albumId) {
      const [albumRow] = await db.select({ id: albums.id, published: albums.published })
        .from(albums).where(eq(albums.id, track.albumId)).limit(1);
      if (!albumRow || albumRow.published !== true) {
        return sendError(res, 404, 'Álbum não disponível.');
      }
    }

    // ── 4. Identificação do usuário ──
    const user = await getAuthUser(req);
    const now = new Date();
    const nowIso = now.toISOString();

    let accessLevel = 'preview';

    // ── 5. Verificação de Premium ──
    if (user?.id) {
      try {
        const [sub] = await db.select().from(subscriptions)
          .where(and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.status, 'ACTIVE'),
            lte(subscriptions.currentPeriodStart, nowIso),
            gt(subscriptions.currentPeriodEnd, nowIso)
          )).limit(1);
        if (sub) accessLevel = 'full';
      } catch (err) {
        console.error('[stream] Erro ao checar assinatura:', err.message);
        return sendError(res, 503, 'Não foi possível verificar sua assinatura.');
      }
    }

    // ── 6. Verificação de aluguel ──
    if (user?.id && accessLevel !== 'full') {
      try {
        const rentalTarget = track.albumId
          ? or(eq(rentals.trackId, track.id), eq(rentals.albumId, track.albumId))
          : eq(rentals.trackId, track.id);

        const [rent] = await db.select().from(rentals)
          .where(and(
            eq(rentals.userId, user.id),
            eq(rentals.status, 'ACTIVE'),
            lte(rentals.startsAt, nowIso),
            gt(rentals.expiresAt, nowIso),
            rentalTarget
          )).limit(1);
        if (rent) accessLevel = 'full';
      } catch (err) {
        console.error('[stream] Erro ao checar aluguel:', err.message);
        return sendError(res, 503, 'Não foi possível verificar seu aluguel.');
      }
    }

    // ── 7. Seleção do arquivo ──
    let b2Key;
    let isFull = false;

    if (accessLevel === 'full') {
      b2Key = track.streamKey || track.fullPath || track.previewKey || track.previewPath;
      isFull = true;
    } else {
      b2Key = track.previewKey || track.previewPath || track.streamKey || track.fullPath;
    }

    if (!b2Key) {
      return sendError(res, 404, 'Arquivo de áudio não configurado.');
    }

    // ── 8. Normalização do caminho ──
    const cleanKey = String(b2Key)
      .replace(/^\/+/, '')
      .replace(/^(josephmatthos|audio|music|tracks)\//i, '');

    // ── 9. Resposta ──
    const wantsJson = String(req.query?.format || '').toLowerCase() === 'json';

    if (isFull) {
      let signedUrl;
      try {
        signedUrl = await getPlaybackUrl(cleanKey, true);
      } catch (err) {
        console.error('[stream] Falha ao gerar URL assinada:', err.message);
        return sendError(res, 503, 'Serviço de áudio temporariamente indisponível.');
      }

      console.log('[stream] Full:', { trackId, source: 'full' });

      if (wantsJson) {
        return res.status(200).json({
          ok: true,
          audioUrl: signedUrl,
          expiresIn: PLAYBACK_TTL,
          source: 'full',
        });
      }
      return res.redirect(302, signedUrl);
    }

    // Preview
    const cdnUrl = `${CDN_BASE}/${cleanKey}`;
    console.log('[stream] Preview:', { trackId, source: 'preview' });

    if (wantsJson) {
      return res.status(200).json({
        ok: true,
        audioUrl: cdnUrl,
        expiresIn: PLAYBACK_TTL,
        source: 'preview',
      });
    }
    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] Erro:', { code: error.code, message: error.message });
    if (!res.headersSent) {
      return sendError(res, 503, 'Não foi possível disponibilizar o áudio neste momento.');
    }
  }
};