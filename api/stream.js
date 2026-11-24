
'use strict';

/* ============================================================
   api/stream.js — Entrega segura de áudio
   ------------------------------------------------------------
   - Prévia: entrega pelo domínio público do R2/CDN.
   - Áudio completo: redireciona para URL GET assinada do R2.
   - JSON: fornece URL assinada e prazo para renovação do player.
   - Verifica assinatura Premium ou aluguel vigente.
   - Valida o tipo/prefixo do objeto antes de expor a URL.
   ============================================================ */

const { eq, and, gt, lte, or } = require('drizzle-orm');

const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');

const { getAuthUser, clientIp, ALLOWED_ORIGINS } = require('./_lib');
const { checkStreamRateLimit } = require('./_cache');

const {
  getPlaybackUrl,
  createSignedDownloadUrl,
  validateObjectKey,
  inferKindFromKey,
} = require('./_storage');

const CDN_BASE = (() => {
  const raw = String(
    process.env.R2_PUBLIC_BASE_URL || process.env.CDN_BASE_URL || ''
  ).trim().replace(/\/+$/, '');

  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    if (url.search || url.hash) return '';
    return url.origin;
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
    ...(message ? { message } : {}),
  });
}

function encodeObjectKey(key) {
  return String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function wantsJson(req) {
  if (String(req.query?.format || '').toLowerCase() === 'json') {
    return true;
  }

  const accept = String(req.headers?.accept || '').toLowerCase();
  return accept.includes('application/json');
}

function getTrackObjectKey(track, accessLevel) {
  return accessLevel === 'full'
    ? (track.streamKey || track.fullPath)
    : (track.previewKey || track.previewPath);
}

function validateTrackObjectKey(key, accessLevel) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('AUDIO_KEY_MISSING');
  }

  // Validação centralizada do storage.
  validateObjectKey(key);

  const kind = inferKindFromKey(key);
  const expectedKind = accessLevel === 'full'
    ? 'audio-full'
    : 'audio-preview';

  if (kind !== expectedKind) {
    const error = new Error('AUDIO_KEY_KIND_MISMATCH');
    error.code = 'AUDIO_KEY_KIND_MISMATCH';
    throw error;
  }

  return key;
}

module.exports = async (req, res) => {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  if (req.method === 'OPTIONS') {
    if (!getAllowedOrigin(req)) {
      return sendError(res, 403, 'ORIGIN_NOT_ALLOWED');
    }

    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Range'
    );
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
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  try {
    // Rate limit antes de consultar banco/storage.
    const ip = clientIp(req);

    if (!ip) {
      return sendError(
        res,
        503,
        'CLIENT_IP_UNAVAILABLE',
        'Não foi possível identificar a origem da requisição.'
      );
    }

    const rateLimit = await checkStreamRateLimit(ip);

    if (!rateLimit || rateLimit.success === false) {
      if (
        rateLimit?.reason === 'rate_limit_unavailable' ||
        rateLimit?.reason === 'missing_or_invalid_ip'
      ) {
        return sendError(
          res,
          503,
          'RATE_LIMIT_UNAVAILABLE',
          'Serviço temporariamente indisponível.'
        );
      }

      return sendError(
        res,
        429,
        'RATE_LIMIT_EXCEEDED',
        'Muitas requisições. Tente novamente mais tarde.'
      );
    }

    const trackId = String(req.query?.trackId || '').trim();

    if (!UUID_RE.test(trackId)) {
      return sendError(res, 400, 'INVALID_TRACK_ID');
    }

    const [track] = await db
      .select()
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);

    if (!track) {
      return sendError(res, 404, 'TRACK_NOT_FOUND');
    }

    if (track.status !== 'PUBLISHED') {
      return sendError(res, 404, 'TRACK_NOT_AVAILABLE');
    }

    let user = null;

    try {
      user = await getAuthUser(req);
    } catch (authError) {
      console.error(
        '[stream] Falha ao identificar usuário:',
        authError.message
      );

      return sendError(
        res,
        503,
        'AUTH_UNAVAILABLE',
        'Autenticação temporariamente indisponível.'
      );
    }

    let accessLevel = 'preview';

    if (user) {
      const now = new Date().toISOString();

      // Primeiro verifica assinatura Premium vigente.
      try {
        const [subscription] = await db
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(and(
            eq(subscriptions.userId, user.id),
            eq(subscriptions.status, 'ACTIVE'),
            gt(subscriptions.currentPeriodEnd, now)
          ))
          .limit(1);

        if (subscription) {
          accessLevel = 'full';
        }
      } catch (subscriptionError) {
        console.error(
          '[stream] Falha ao consultar assinatura:',
          subscriptionError.message
        );

        return sendError(res, 503, 'SUBSCRIPTION_LOOKUP_FAILED');
      }

      // Sem Premium, verifica aluguel da faixa ou do álbum.
      if (accessLevel !== 'full') {
        try {
          const conditions = [
            eq(rentals.userId, user.id),
            eq(rentals.status, 'ACTIVE'),
            lte(rentals.startsAt, now),
            gt(rentals.expiresAt, now),
          ];

          const rentalTarget = track.albumId
            ? or(
                eq(rentals.trackId, track.id),
                eq(rentals.albumId, track.albumId)
              )
            : eq(rentals.trackId, track.id);

          conditions.push(rentalTarget);

          const [rental] = await db
            .select({ id: rentals.id })
            .from(rentals)
            .where(and(...conditions))
            .limit(1);

          if (rental) {
            accessLevel = 'full';
          }
        } catch (rentalError) {
          console.error(
            '[stream] Falha ao consultar aluguel:',
            rentalError.message
          );

          return sendError(res, 503, 'RENTAL_LOOKUP_FAILED');
        }
      }
    }

    const rawKey = getTrackObjectKey(track, accessLevel);

    if (!rawKey) {
      if (accessLevel === 'preview') {
        return sendError(
          res,
          404,
          'PREVIEW_UNAVAILABLE',
          'A prévia não está disponível para esta faixa.'
        );
      }

      return sendError(
        res,
        404,
        'AUDIO_NOT_CONFIGURED',
        'Arquivo de áudio não configurado.'
      );
    }

    let objectKey;

    try {
      objectKey = validateTrackObjectKey(rawKey, accessLevel);
    } catch (keyError) {
      console.error(
        '[stream] Chave de áudio inválida:',
        keyError.code || keyError.message
      );

      return sendError(res, 500, 'INVALID_STORAGE_KEY');
    }

    const asJson = wantsJson(req);

    // Áudio completo: bucket privado e URL assinada.
    if (accessLevel === 'full') {
      try {
        if (asJson) {
          const signed = await createSignedDownloadUrl(
            objectKey,
            SIGNED_TTL_SEC,
            null
          );

          if (
            typeof signed?.url !== 'string' ||
            !signed.url.startsWith('https://')
          ) {
            throw new Error('SIGNED_URL_INVALID');
          }

          const expiresIn = Number(signed.expiresIn) || SIGNED_TTL_SEC;

          return res.status(200).json({
            ok: true,
            audioUrl: signed.url,
            expiresAt: new Date(
              Date.now() + expiresIn * 1000
            ).toISOString(),
            expiresIn,
          });
        }

        const signedUrl = await getPlaybackUrl(objectKey);

        if (
          typeof signedUrl !== 'string' ||
          !signedUrl.startsWith('https://')
        ) {
          throw new Error('SIGNED_URL_INVALID');
        }

        // O navegador passa a requisitar o áudio diretamente ao R2.
        return res.redirect(302, signedUrl);
      } catch (storageError) {
        console.error(
          '[stream] Falha ao assinar áudio:',
          storageError.code || storageError.message
        );

        return sendError(
          res,
          503,
          'AUDIO_STORAGE_UNAVAILABLE',
          'Serviço de áudio temporariamente indisponível.'
        );
      }
    }

    // Prévia pública: somente chave classificada como audio-preview.
    if (!CDN_BASE) {
      return sendError(res, 503, 'CDN_UNAVAILABLE');
    }

    const previewUrl = `${CDN_BASE}/${encodeObjectKey(objectKey)}`;

    if (asJson) {
      return res.status(200).json({
        ok: true,
        audioUrl: previewUrl,
        expiresAt: null,
        expiresIn: null,
      });
    }

    return res.redirect(302, previewUrl);

  } catch (error) {
    console.error(
      '[stream] Erro interno:',
      error.code || error.message
    );

    if (!res.headersSent) {
      return sendError(res, 500, 'INTERNAL_STREAM_ERROR');
    }
  }
};
