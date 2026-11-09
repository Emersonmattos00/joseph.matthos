/* ============================================================
   api/stream.js — Entrega segura de áudio (Versão Final)
   ------------------------------------------------------------
   - Validação de publicação e status
   - Autorização Premium / Aluguel (com fallback seguro)
   - Rate limit com tratamento diferenciado (429 vs 503)
   - URLs temporárias para áudio completo (B2)
   - CDN pública para prévias
   - Proteção contra chaves inválidas
   - Diagnóstico JSON sem vazar URL
   ============================================================ */

'use strict';

const { eq, and, gt, lte, or } = require('drizzle-orm');

const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');

const { getAuthUser } = require('./_lib');
const { checkStreamRateLimit } = require('./_cache');
const { getPlaybackUrl } = require('./_storage');

const CDN_BASE = String(
  process.env.CDN_BASE_URL ||
  'https://josephmatthos-cdn.emerson-mattos00.workers.dev'
).trim().replace(/\/+$/, '');

const MAX_TRACK_ID_LENGTH = 128;

/* ─── Respostas ──────────────────────────────────────────── */

function json(res, status, data) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(status).json(data);
}

function setHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

/* ─── Normalizadores ─────────────────────────────────────── */

function normalizeTrackId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value).trim();
  if (!id || id.length > MAX_TRACK_ID_LENGTH) return null;
  return id;
}

function normalizeStorageKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('?') ||
    key.includes('#') ||
    key.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    return null;
  }
  return key;
}

function getClientIp(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  return String(
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    'unknown'
  ).slice(0, 128);
}

/* ─── Autorizações ───────────────────────────────────────── */

async function hasActiveSubscription(userId, now) {
  const [subscription] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(
      eq(subscriptions.userId, userId),
      eq(subscriptions.status, 'ACTIVE'),
      gt(subscriptions.currentPeriodEnd, now)
    ))
    .limit(1);

  return Boolean(subscription);
}

async function hasActiveRental(userId, track, now) {
  const conditions = [
    eq(rentals.userId, userId),
    eq(rentals.status, 'ACTIVE'),
    lte(rentals.startsAt, now),
    gt(rentals.expiresAt, now)
  ];

  const trackOrAlbum = track.albumId
    ? or(eq(rentals.trackId, track.id), eq(rentals.albumId, track.albumId))
    : eq(rentals.trackId, track.id);

  conditions.push(trackOrAlbum);

  const [rental] = await db
    .select({ id: rentals.id })
    .from(rentals)
    .where(and(...conditions))
    .limit(1);

  return Boolean(rental);
}

async function getAccessLevel(user, track, now) {
  if (!user?.id) return 'preview';

  try {
    if (await hasActiveSubscription(user.id, now)) return 'full';
  } catch (error) {
    console.error('[stream] Erro ao consultar assinatura:', error.message);
    return 'preview';
  }

  try {
    if (await hasActiveRental(user.id, track, now)) return 'full';
  } catch (error) {
    console.error('[stream] Erro ao consultar aluguel:', error.message);
    return 'preview';
  }

  return 'preview';
}

/* ─── Diagnóstico ────────────────────────────────────────── */

function diagnosticResponse(res, status, data) {
  return json(res, status, { ok: status >= 200 && status < 300, ...data });
}

/* ─── Handler principal ──────────────────────────────────── */

module.exports = async function streamHandler(req, res) {
  setHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'Método não permitido.' });
  }

  try {
    const trackId = normalizeTrackId(req.query?.trackId);
    const diagnostic = req.query?.format === 'json';

    if (!trackId) {
      return diagnostic
        ? diagnosticResponse(res, 400, { error: 'trackId obrigatório.' })
        : json(res, 400, { error: 'trackId obrigatório.' });
    }

    // ── 1. Rate limit (com diferenciação de motivo)
    const ip = getClientIp(req);
    const rateLimit = await checkStreamRateLimit(ip);

    if (!rateLimit.success) {
      if (rateLimit.reason === 'rate_limit_exceeded') {
        return diagnostic
          ? diagnosticResponse(res, 429, { error: 'Muitas requisições.' })
          : json(res, 429, { error: 'Muitas requisições. Aguarde um momento.' });
      }
      if (rateLimit.reason === 'missing_or_invalid_ip') {
        return diagnostic
          ? diagnosticResponse(res, 503, { error: 'IP não identificado.' })
          : json(res, 503, { error: 'Não foi possível identificar sua conexão.' });
      }
      // rate_limit_unavailable (Redis caiu em produção)
      return diagnostic
        ? diagnosticResponse(res, 503, { error: 'Rate limit indisponível.' })
        : json(res, 503, { error: 'Serviço temporariamente indisponível.' });
    }

    // ── 2. Busca da faixa
    const [track] = await db
      .select({
        id: tracks.id,
        albumId: tracks.albumId,
        status: tracks.status,
        published: tracks.published,
        streamKey: tracks.streamKey,
        previewKey: tracks.previewKey,
        fullPath: tracks.fullPath,
        previewPath: tracks.previewPath
      })
      .from(tracks)
      .where(and(
        eq(tracks.id, trackId),
        eq(tracks.status, 'PUBLISHED'),
        eq(tracks.published, true)
      ))
      .limit(1);

    if (!track) {
      return diagnostic
        ? diagnosticResponse(res, 404, { error: 'Faixa não encontrada ou não publicada.' })
        : json(res, 404, { error: 'Faixa não encontrada ou não publicada.' });
    }

    // ── 3. Identificação do usuário (falha fechada)
    let user = null;
    try {
      user = await getAuthUser(req);
    } catch (error) {
      console.error('[stream] Erro de autenticação:', error.message);
      return diagnostic
        ? diagnosticResponse(res, 503, { error: 'Falha ao verificar sessão.' })
        : json(res, 503, { error: 'Autenticação temporariamente indisponível.' });
    }

    const now = new Date().toISOString();

    // ── 4. Nível de acesso
    const accessLevel = await getAccessLevel(user, track, now);

    // ── 5. Seleção da chave de armazenamento
    const rawKey = accessLevel === 'full'
      ? (track.streamKey || track.fullPath)
      : (track.previewKey || track.previewPath);

    if (!rawKey) {
      return diagnostic
        ? diagnosticResponse(res, 403, { error: 'Prévia indisponível.', accessLevel })
        : json(res, 403, {
            error: 'Prévia indisponível.',
            message: 'Alugue ou assine para ouvir o áudio completo.'
          });
    }

    const key = normalizeStorageKey(rawKey);
    if (!key) {
      console.error('[stream] Chave de armazenamento inválida:', track.id);
      return diagnostic
        ? diagnosticResponse(res, 500, { error: 'Configuração de áudio inválida.' })
        : json(res, 500, { error: 'Configuração de áudio inválida.' });
    }

    // ── 6. Diagnóstico sem revelar URL
    if (diagnostic) {
      return diagnosticResponse(res, 200, {
        accessLevel,
        message: 'Acesso ao áudio autorizado.'
      });
    }

    // ── 7. Áudio completo → URL assinada do B2
    if (accessLevel === 'full') {
      try {
        const signedUrl = await getPlaybackUrl(key, true);

        if (typeof signedUrl !== 'string' || !signedUrl.startsWith('https://')) {
          throw new Error('URL assinada inválida.');
        }

        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.redirect(302, signedUrl);
      } catch (error) {
        console.error('[stream] Falha ao gerar URL assinada:', error.message);
        return json(res, 503, { error: 'Serviço de áudio temporariamente indisponível.' });
      }
    }

    // ── 8. Prévia → CDN pública
    if (!CDN_BASE || !CDN_BASE.startsWith('https://')) {
      return json(res, 503, { error: 'CDN de prévias indisponível.' });
    }

    const encodedKey = key.split('/').map(encodeURIComponent).join('/');
    const cdnUrl = `${CDN_BASE}/${encodedKey}`;

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] Erro interno:', error);
    if (res.headersSent) return;
    return json(res, 500, { error: 'Erro interno ao entregar áudio.' });
  }
};