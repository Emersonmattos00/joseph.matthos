'use strict';

/* ============================================================
   api/stream.js — Entrega segura de áudio (v2 — auditada)
   ------------------------------------------------------------
   Correções da auditoria etapa 2:
   P1.1 CDN_BASE via env (R2_PUBLIC_BASE_URL ou CDN_BASE_URL),
        validada como HTTPS.
   P1.2 Contrato duplo:
        - default: 302 para a URL assinada (player <audio src>)
        - ?format=json (ou Accept: application/json): 200 com
          { ok, audioUrl, expiresAt } para renewSignedUrl() em
          site.js.
   P1.3 IP: usa clientIp() (já documentado como dependente de
        proxy confiável em _lib.js).
   Mantém: validação de status, autorização premium/aluguel,
   rate limit, CORS restrito, bloqueio de chaves inválidas.
   ============================================================ */

const { eq, and, gt, lte, or } = require('drizzle-orm');

const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');

const { getAuthUser, clientIp, ALLOWED_ORIGINS } = require('./_lib');
const { checkStreamRateLimit } = require('./_cache');
const { getPlaybackUrl, createSignedDownloadUrl } = require('./_storage');

const CDN_BASE = (() => {
  const raw = String(
    process.env.CDN_BASE_URL ||
    process.env.R2_PUBLIC_BASE_URL ||
    ''
  ).trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return '';
    return u.origin;
  } catch {
    return '';
  }
})();

const SIGNED_TTL_SEC = 300;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendError(res, status, error, message) {
  return res.status(status).json({
    ok: false,
    error,
    ...(message ? { message } : {})
  });
}

function encodeObjectKey(key) {
  return String(key)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function wantsJson(req) {
  if (String(req.query?.format || '').toLowerCase() === 'json') return true;
  const accept = String(req.headers?.accept || '').toLowerCase();
  return accept.includes('application/json');
}

module.exports = async (req, res) => {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') {
    if (!getAllowedOrigin(req)) {
      return sendError(res, 403, 'ORIGIN_NOT_ALLOWED');
    }
    const origin = req.headers.origin;
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED');
  }

  if (!getAllowedOrigin(req)) {
    return sendError(res, 403, 'ORIGIN_NOT_ALLOWED');
  }

  const origin = req.headers.origin;
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);

  try {
    const ip = clientIp(req);
    if (!ip) {
      return sendError(res, 503, 'CLIENT_IP_UNAVAILABLE',
        'Não foi possível identificar a origem da requisição.');
    }

    const rl = await checkStreamRateLimit(ip);
    if (!rl || rl.success === false) {
      if (rl?.reason === 'rate_limit_unavailable' || rl?.reason === 'missing_or_invalid_ip') {
        return sendError(res, 503, 'RATE_LIMIT_UNAVAILABLE',
          'Serviço temporariamente indisponível.');
      }
      return sendError(res, 429, 'RATE_LIMIT_EXCEEDED',
        'Muitas requisições. Tente novamente mais tarde.');
    }

    const trackId = String(req.query?.trackId || '').trim();
    if (!UUID_RE.test(trackId)) {
      return sendError(res, 400, 'INVALID_TRACK_ID');
    }

    const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
    if (!track) return sendError(res, 404, 'TRACK_NOT_FOUND');

    if (track.status !== 'PUBLISHED') {
      return sendError(res, 404, 'TRACK_NOT_AVAILABLE');
    }

    let user = null;
    try {
      user = await getAuthUser(req);
    } catch (authErr) {
      console.error('[stream] Falha ao identificar usuário:', authErr.message);
      return sendError(res, 503, 'AUTH_UNAVAILABLE',
        'Autenticação temporariamente indisponível.');
    }

    let accessLevel = 'preview';

    if (user) {
      const now = new Date().toISOString();

      try {
        const [sub] = await db
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.status, 'ACTIVE'),
            gt(subscriptions.currentPeriodEnd, now)
          ))
          .limit(1);
        if (sub) accessLevel = 'full';
      } catch (subErr) {
        console.error('[stream] Falha ao consultar assinatura:', subErr.message);
        return sendError(res, 503, 'SUBSCRIPTION_LOOKUP_FAILED');
      }

      if (accessLevel !== 'full') {
        try {
          const conditions = [
            eq(rentals.userId, user.id),
            eq(rentals.status, 'ACTIVE'),
            lte(rentals.startsAt, now),
            gt(rentals.expiresAt, now)
          ];
          const target = track.albumId
            ? or(eq(rentals.trackId, track.id), eq(rentals.albumId, track.albumId))
            : eq(rentals.trackId, track.id);
          conditions.push(target);

          const [rental] = await db
            .select({ id: rentals.id })
            .from(rentals)
            .where(and(...conditions))
            .limit(1);
          if (rental) accessLevel = 'full';
        } catch (rentalErr) {
          console.error('[stream] Falha ao consultar aluguel:', rentalErr.message);
          return sendError(res, 503, 'RENTAL_LOOKUP_FAILED');
        }
      }
    }

    const objectKey = accessLevel === 'full'
      ? (track.streamKey || track.fullPath)
      : (track.previewKey || track.previewPath);

    if (!objectKey || typeof objectKey !== 'string') {
      if (accessLevel === 'preview') {
        return sendError(res, 403, 'PREVIEW_UNAVAILABLE',
          'A prévia não está disponível para esta faixa.');
      }
      return sendError(res, 404, 'AUDIO_NOT_CONFIGURED',
        'Arquivo de áudio não configurado.');
    }

    const cleanKey = objectKey.replace(/^\/+/, '');
    if (!cleanKey || cleanKey.split('/').some(seg => seg === '.' || seg === '..')) {
      return sendError(res, 500, 'INVALID_STORAGE_KEY');
    }

    const asJson = wantsJson(req);

    if (accessLevel === 'full') {
      try {
        if (asJson) {
          const { url, expiresIn } = await createSignedDownloadUrl(cleanKey, SIGNED_TTL_SEC, null);
          if (typeof url !== 'string' || !url.startsWith('https://')) {
            throw new Error('URL assinada inválida.');
          }
          return res.status(200).json({
            ok: true,
            audioUrl: url,
            expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
            expiresIn,
          });
        }
        const signedUrl = await getPlaybackUrl(cleanKey);
        if (typeof signedUrl !== 'string' || !signedUrl.startsWith('https://')) {
          throw new Error('URL assinada inválida.');
        }
        return res.redirect(302, signedUrl);
      } catch (storageErr) {
        console.error('[stream] Falha ao assinar áudio:', storageErr.message);
        return sendError(res, 503, 'AUDIO_STORAGE_UNAVAILABLE',
          'Serviço de áudio temporariamente indisponível.');
      }
    }

    if (!CDN_BASE) {
      return sendError(res, 503, 'CDN_UNAVAILABLE');
    }

    const cdnUrl = `${CDN_BASE}/${encodeObjectKey(cleanKey)}`;

    if (asJson) {
      return res.status(200).json({
        ok: true,
        audioUrl: cdnUrl,
        expiresAt: null,
        expiresIn: null,
      });
    }

    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] Erro interno:', error.code || error.message);
    if (!res.headersSent) {
      return sendError(res, 500, 'INTERNAL_STREAM_ERROR');
    }
  }
};
