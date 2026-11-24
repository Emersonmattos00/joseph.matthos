'use strict';

/* ============================================================
   api/stream.js — Entrega segura de áudio (v3 — integrada)
   ------------------------------------------------------------
   - Mantém a estrutura funcional da versão original.
   - Premium e aluguel com validade.
   - Rate limit: 429 / 503.
   - Áudio completo por URL assinada do R2 privado.
   - Prévia pela CDN pública.
   - Redirecionamento 302 para players tradicionais.
   - Resposta JSON para o player renovar URLs.
   - Validação de chaves e prefixos de armazenamento.
   - Compatibilidade com premium/ via _storage.js.
   - CORS restrito a ALLOWED_ORIGINS.
   ============================================================ */

const { eq, and, gt, lte, or } = require('drizzle-orm');

const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');

const {
  getAuthUser,
  clientIp,
  ALLOWED_ORIGINS
} = require('./_lib');

const { checkStreamRateLimit } = require('./_cache');

const {
  getPlaybackUrl,
  createSignedDownloadUrl,
  validateObjectKey,
  inferKindFromKey
} = require('./_storage');

const SIGNED_TTL_SEC = 300;

const CDN_BASE = (() => {
  const raw = String(
    process.env.CDN_BASE_URL ||
    process.env.R2_PUBLIC_BASE_URL ||
    ''
  ).trim().replace(/\/+$/, '');

  if (!raw) return '';

  try {
    const url = new URL(raw);

    if (url.protocol !== 'https:') return '';
    if (url.username || url.password) return '';
    if (url.search || url.hash) return '';
    if (url.pathname !== '/' && url.pathname !== '') return '';

    return url.origin;
  } catch {
    return '';
  }
})();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ─── Helpers ─────────────────────────────────────────── */

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
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function getAllowedOrigin(req) {
  const origin = req.headers.origin;

  if (!origin) return true;

  return ALLOWED_ORIGINS.has(origin);
}

function wantsJson(req) {
  if (
    String(req.query?.format || '').toLowerCase() === 'json'
  ) {
    return true;
  }

  const accept = String(
    req.headers?.accept || ''
  ).toLowerCase();

  return accept.includes('application/json');
}

function normalizeStorageKey(value) {
  if (typeof value !== 'string') return null;

  const key = value.replace(/^\/+/, '');

  if (!key) return null;

  validateObjectKey(key);

  return key;
}

function logStorageProblem(message, details = {}) {
  console.error('[stream] ' + message, details);
}

/* ─── Handler ────────────────────────────────────────── */

module.exports = async (req, res) => {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    if (!getAllowedOrigin(req)) {
      return sendError(res, 403, 'ORIGIN_NOT_ALLOWED');
    }

    const origin = req.headers.origin;

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, OPTIONS'
    );

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, Range, Accept'
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
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  try {
    /* 1. IP e rate limit */

    const ip = clientIp(req);

    if (!ip) {
      return sendError(
        res,
        503,
        'CLIENT_IP_UNAVAILABLE',
        'Não foi possível identificar a origem da requisição.'
      );
    }

    const rl = await checkStreamRateLimit(ip);

    if (!rl || rl.success === false) {
      if (
        rl?.reason === 'rate_limit_unavailable' ||
        rl?.reason === 'missing_or_invalid_ip'
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

    /* 2. Validação do ID */

    const trackId = String(
      req.query?.trackId || ''
    ).trim();

    if (!UUID_RE.test(trackId)) {
      return sendError(res, 400, 'INVALID_TRACK_ID');
    }

    /* 3. Busca da faixa */

    const [track] = await db
      .select()
      .from(tracks)
      .where(eq(tracks.id, trackId))
      .limit(1);

    if (!track) {
      return sendError(res, 404, 'TRACK_NOT_FOUND');
    }

    /* 4. Status oficial */

    if (track.status !== 'PUBLISHED') {
      return sendError(res, 404, 'TRACK_NOT_AVAILABLE');
    }

    /* 5. Usuário */

    let user = null;

    try {
      user = await getAuthUser(req);
    } catch (authErr) {
      console.error(
        '[stream] Falha ao identificar usuário:',
        authErr.message
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

      /* 6. Assinatura ativa */

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

        if (sub) {
          accessLevel = 'full';
        }
      } catch (subErr) {
        console.error(
          '[stream] Falha ao consultar assinatura:',
          subErr.message
        );

        return sendError(
          res,
          503,
          'SUBSCRIPTION_LOOKUP_FAILED'
        );
      }

      /* 7. Aluguel ativo */

      if (accessLevel !== 'full') {
        try {
          const conditions = [
            eq(rentals.userId, user.id),
            eq(rentals.status, 'ACTIVE'),
            lte(rentals.startsAt, now),
            gt(rentals.expiresAt, now)
          ];

          const target = track.albumId
            ? or(
                eq(rentals.trackId, track.id),
                eq(rentals.albumId, track.albumId)
              )
            : eq(rentals.trackId, track.id);

          conditions.push(target);

          const [rental] = await db
            .select({ id: rentals.id })
            .from(rentals)
            .where(and(...conditions))
            .limit(1);

          if (rental) {
            accessLevel = 'full';
          }
        } catch (rentalErr) {
          console.error(
            '[stream] Falha ao consultar aluguel:',
            rentalErr.message
          );

          return sendError(
            res,
            503,
            'RENTAL_LOOKUP_FAILED'
          );
        }
      }
    }

    /* 8. Seleção da chave correta */

    const objectKey = accessLevel === 'full'
      ? (track.streamKey || track.fullPath)
      : (track.previewKey || track.previewPath);

    if (!objectKey || typeof objectKey !== 'string') {
      if (accessLevel === 'preview') {
        return sendError(
          res,
          403,
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

    /* 9. Validação da chave e do tipo */

    let cleanKey;
    let storageKind;

    try {
      cleanKey = normalizeStorageKey(objectKey);

      if (!cleanKey) {
        throw new Error('Chave vazia.');
      }

      storageKind = inferKindFromKey(cleanKey);

    } catch (keyErr) {
      logStorageProblem(
        'Chave de armazenamento inválida.',
        {
          trackId,
          accessLevel,
          code: keyErr.code || 'INVALID_STORAGE_KEY',
          reason: keyErr.message
        }
      );

      return sendError(
        res,
        500,
        'INVALID_STORAGE_KEY',
        'A chave do arquivo está inválida ou não corresponde a um prefixo configurado no armazenamento.'
      );
    }

    const expectedKind = accessLevel === 'full'
      ? 'audio-full'
      : 'audio-preview';

    if (storageKind !== expectedKind) {
      logStorageProblem(
        'Tipo de objeto incompatível com o acesso.',
        {
          trackId,
          accessLevel,
          expectedKind,
          actualKind: storageKind
        }
      );

      return sendError(
        res,
        500,
        'INVALID_STORAGE_KEY',
        'O arquivo cadastrado não corresponde ao tipo de áudio esperado.'
      );
    }

    const asJson = wantsJson(req);

    /* 10. Áudio completo — bucket privado */

    if (accessLevel === 'full') {
      try {
        if (asJson) {
          const signed = await createSignedDownloadUrl(
            cleanKey,
            SIGNED_TTL_SEC,
            null
          );

          if (
            !signed ||
            typeof signed.url !== 'string' ||
            !signed.url.startsWith('https://')
          ) {
            throw new Error('URL assinada inválida.');
          }

          const expiresIn = Number(signed.expiresIn);

          if (
            !Number.isInteger(expiresIn) ||
            expiresIn < 1 ||
            expiresIn > 3600
          ) {
            throw new Error('Prazo de URL assinada inválido.');
          }

          return res.status(200).json({
            ok: true,
            audioUrl: signed.url,
            expiresAt: new Date(
              Date.now() + expiresIn * 1000
            ).toISOString(),
            expiresIn
          });
        }

        // Preserva o redirecionamento da versão funcional.
        const signedUrl = await getPlaybackUrl(cleanKey);

        if (
          typeof signedUrl !== 'string' ||
          !signedUrl.startsWith('https://')
        ) {
          throw new Error('URL assinada inválida.');
        }

        return res.redirect(302, signedUrl);

      } catch (storageErr) {
        logStorageProblem(
          'Falha ao assinar áudio completo.',
          {
            trackId,
            code: storageErr.code || storageErr.name || 'STORAGE_ERROR',
            message: storageErr.message
          }
        );

        if (
          storageErr.code === 'INVALID_KEY_PREFIX' ||
          storageErr.code === 'INVALID_KIND' ||
          storageErr.code === 'INVALID_PATH' ||
          storageErr.code === 'QUARANTINE_FORBIDDEN'
        ) {
          return sendError(
            res,
            500,
            'INVALID_STORAGE_KEY',
            'A chave do áudio não corresponde à configuração do armazenamento.'
          );
        }

        return sendError(
          res,
          503,
          'AUDIO_STORAGE_UNAVAILABLE',
          'Serviço de áudio temporariamente indisponível.'
        );
      }
    }

    /* 11. Prévia — CDN pública */

    if (!CDN_BASE) {
      return sendError(res, 503, 'CDN_UNAVAILABLE');
    }

    const cdnUrl =
      `${CDN_BASE}/${encodeObjectKey(cleanKey)}`;

    if (asJson) {
      return res.status(200).json({
        ok: true,
        audioUrl: cdnUrl,
        expiresAt: null,
        expiresIn: null
      });
    }

    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error(
      '[stream] Erro interno:',
      error.code || error.message
    );

    if (!res.headersSent) {
      return sendError(
        res,
        500,
        'INTERNAL_STREAM_ERROR'
      );
    }
  }
};
