'use strict';

/* ============================================================
   api/stream.js — Entrega segura de áudio (Versão Final)
   ------------------------------------------------------------
   - Validação de status (tracks.status === 'PUBLISHED')
   - Autorização Premium / Aluguel (com startsAt e expiresAt)
   - Rate limit diferenciado (429 excesso / 503 indisponível)
   - URL assinada do B2 para áudio completo
   - CDN pública para prévias
   - CORS restrito a ALLOWED_ORIGINS
   - Proteção contra chaves inválidas
   ============================================================ */

const { eq, and, gt, lte, or } = require('drizzle-orm');

const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');

const { getAuthUser, clientIp, ALLOWED_ORIGINS } = require('./_lib');
const { checkStreamRateLimit } = require('./_cache');
const { getPlaybackUrl } = require('./_storage');

const CDN_BASE = 'https://pub-9eaf26fd8c784a62bae2457a45edc7d2.r2.dev';
// S-05: CDN da prévia por env (fallback ao domínio público atual)
const CDN_BASE = String(process.env.R2_PUBLIC_BASE_URL || 'https://pub-9eaf26fd8c784a62bae2457a45edc7d2.r2.dev')
  .replace(/\/+$/, '');

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
@@ -199,30 +201,31 @@
    /* 9. Áudio completo → URL assinada do B2 */
    if (accessLevel === 'full') {
      try {
        const signedUrl = await getPlaybackUrl(cleanKey, true);
        // S-05: getPlaybackUrl aceita apenas a chave (TTL estendido via B-04 do _storage v5)
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

    /* 10. Prévia → CDN pública */
    if (!CDN_BASE || !CDN_BASE.startsWith('https://')) {
      return sendError(res, 503, 'CDN_UNAVAILABLE');
    }

    const cdnUrl = `${CDN_BASE}/${encodeObjectKey(cleanKey)}`;
    return res.redirect(302, cdnUrl);

  } catch (error) {
    console.error('[stream] Erro interno:', error.code || error.message);
    if (!res.headersSent) {
      return sendError(res, 500, 'INTERNAL_STREAM_ERROR');
    }
  }
};
