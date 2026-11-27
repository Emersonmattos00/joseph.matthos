'use strict';

/* ============================================================
   api/stream.js — Entrega segura de áudio (Versão Final - R2)
   ------------------------------------------------------------
   - Validação de status (tracks.status === 'PUBLISHED')
   - Autorização Premium / Aluguel (com startsAt e expiresAt)
   - Rate limit diferenciado (429 excesso / 503 indisponível)
   - URL assinada do R2 para áudio completo
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

// Configuração da CDN pública (vem do .env ou usa o padrão do R2)
const CDN_BASE = String(
  process.env.R2_PUBLIC_BASE_URL || 'https://pub-9eaf26fd8c784a62bae2457a45edc7d2.r2.dev'
).replace(/\/+$/, '');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Helper para codificar a chave do objeto na URL
function encodeObjectKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

// Helper para enviar erros padronizados
function sendError(res, status, code, message = '') {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ ok: false, error: code, message: message || code });
}

// Helper para configurar CORS
function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
}

module.exports = async (req, res) => {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendError(res, 405, 'METHOD_NOT_ALLOWED');
  }

  try {
    const trackId = req.query?.id;
    if (!trackId || !UUID_RE.test(trackId)) {
      return sendError(res, 400, 'INVALID_TRACK_ID');
    }

    const trackKey = req.query?.type || 'preview';
    const isFull = trackKey === 'full' || trackKey === 'download';

    // Rate limit por IP
    const ip = clientIp(req);
    const rateLimit = await checkStreamRateLimit(ip);
    if (rateLimit && !rateLimit.ok) {
      return sendError(res, rateLimit.status || 429, 'RATE_LIMIT_EXCEEDED');
    }

    // Busca a faixa no banco
    const [track] = await db.select({
      id: tracks.id,
      albumId: tracks.albumId,
      title: tracks.title,
      fullPath: tracks.fullPath,
      previewPath: tracks.previewPath,
      status: tracks.status
    }).from(tracks).where(eq(tracks.id, trackId)).limit(1);

    if (!track || track.status !== 'PUBLISHED') {
      return sendError(res, 404, 'TRACK_NOT_FOUND');
    }

    const cleanKey = isFull ? track.fullPath : track.previewPath;
    if (!cleanKey) {
      return sendError(res, 404, isFull ? 'FULL_AUDIO_NOT_AVAILABLE' : 'PREVIEW_NOT_AVAILABLE');
    }

    // Verifica autorização para áudio completo
    let accessLevel = 'preview';
    if (isFull) {
      const user = await getAuthUser(req).catch(() => null);
      if (!user) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Faça login para ouvir o áudio completo.');
      }

      // Verifica assinatura premium ativa
      const [sub] = await db.select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.status, 'ACTIVE'),
          lte(subscriptions.currentPeriodStart, new Date().toISOString()),
          gt(subscriptions.currentPeriodEnd, new Date().toISOString())
        )).limit(1);

      if (sub) {
        accessLevel = 'full';
      } else {
        // Verifica aluguel ativo da faixa
        const [rental] = await db.select({ id: rentals.id })
          .from(rentals)
          .where(and(
            eq(rentals.userId, user.id),
            eq(rentals.trackId, trackId),
            eq(rentals.status, 'ACTIVE'),
            lte(rentals.startsAt, new Date().toISOString()),
            gt(rentals.expiresAt, new Date().toISOString())
          )).limit(1);

        if (rental) {
          accessLevel = 'full';
        } else {
          return sendError(res, 403, 'PREMIUM_REQUIRED', 'Assine o Premium ou alugue esta faixa.');
        }
      }
    }

    /* ─── AQUI ESTÁ A LÓGICA DE ENTREGA ─── */
    
    if (accessLevel === 'full') {
      // Áudio Completo → URL assinada do R2 (bucket privado)
      try {
        const signedUrl = await getPlaybackUrl(cleanKey);
        if (typeof signedUrl !== 'string' || !signedUrl.startsWith('https://')) {
          throw new Error('URL assinada inválida.');
        }
        return res.redirect(302, signedUrl);
      } catch (storageErr) {
        console.error('[stream] Falha ao assinar áudio completo:', storageErr.message);
        return sendError(res, 503, 'AUDIO_STORAGE_UNAVAILABLE', 'Serviço de áudio temporariamente indisponível.');
      }
    }

    // Prévia → CDN pública
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
