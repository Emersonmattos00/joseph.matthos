'use strict';

/* ============================================================
   api/stream.js — Entrega segura de áudio (FIX da auditoria
   de 27/11/2026, sobre a reescrita 302)
   ------------------------------------------------------------
   Mantém: entrega via 302 (F-04), autorização Premium/Aluguel,
   rate limit diferenciado, CORS restrito a ALLOWED_ORIGINS.

   Corrige (P0):
   S1  Parâmetro: o frontend chama /api/stream?trackId=… (site.js
       L1867/L1939, player.js L1065). A reescrita lia req.query.id —
       toda chamada virava INVALID_TRACK_ID. Agora: trackId
       (primário) com fallback ?id para compatibilidade.
   S2  Rate limit: _cache.checkStreamRateLimit devolve
       { success, reason } — a reescrita testava .ok (sempre
       undefined → 429 eterno). Padrão restaurado do stream antigo:
       success===false → 503 (indisponível/IP ausente) ou 429 (excesso).
   S3  Nível de acesso decidido NO SERVIDOR (como no stream antigo):
       usuário Premium ou aluguel ativo → áudio completo mesmo sem
       ?type=full (o frontend nunca envia type). ?type=full|download
       continua aceito como pedido explícito (403 se não autorizado).
       Também restaura o fallback track.streamKey || track.fullPath.
   S4  CDN de prévia: removido o fallback hardcoded
       pub-9eaf…@r2.dev (vazamento de identificador do bucket e
       comportamento silencioso sem env). Sem R2_PUBLIC_BASE_URL
       → 503 CDN_UNAVAILABLE explícito.
   ============================================================ */

const { eq, and, gt, lte } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, rentals, subscriptions } = require('../src/schema.js');
const { getAuthUser, clientIp, ALLOWED_ORIGINS } = require('./_lib');
const { checkStreamRateLimit } = require('./_cache');
const { getPlaybackUrl } = require('./_storage');

// CDN pública de prévias — SEMPRE via env (S4). Sem valor → 503.
const CDN_BASE = String(process.env.R2_PUBLIC_BASE_URL || '')
  .trim()
  .replace(/\/+$/, '');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeObjectKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function sendError(res, status, code, message = '') {
  res.setHeader('Content-Type', 'application/json');
  return res.status(status).json({ ok: false, error: code, message: message || code });
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  // ALLOWED_ORIGINS é um Set (de _lib.js) — usar .has(), não .includes (S5)
  if (origin && ALLOWED_ORIGINS && ALLOWED_ORIGINS.size && ALLOWED_ORIGINS.has(origin)) {
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

  /* 1. IP do cliente (padrão do stream antigo: 503 se ausente) */
  const ip = clientIp(req);
  if (!ip) {
    return sendError(res, 503, 'CLIENT_IP_UNAVAILABLE',
      'Não foi possível identificar a origem da requisição.');
  }

  /* 2. Rate limit — contrato real de _cache: { success, reason } (S2) */
  const rl = await checkStreamRateLimit(ip);
  if (!rl || rl.success === false) {
    if (rl?.reason === 'rate_limit_unavailable' || rl?.reason === 'missing_or_invalid_ip') {
      return sendError(res, 503, 'RATE_LIMIT_UNAVAILABLE',
        'Serviço temporariamente indisponível.');
    }
    return sendError(res, 429, 'RATE_LIMIT_EXCEEDED',
      'Muitas requisições. Tente novamente mais tarde.');
  }

  /* 3. ID da faixa — trackId é o contrato do frontend (S1) */
  const trackId = String(req.query?.trackId || req.query?.id || '').trim();
  if (!trackId || !UUID_RE.test(trackId)) {
    return sendError(res, 400, 'INVALID_TRACK_ID');
  }

  /* 4. Busca da faixa (dentro de try — falha de DB responde JSON, não 500 cru) */
  let track;
  try {
    [track] = await db.select({
      id: tracks.id,
      albumId: tracks.albumId,
      title: tracks.title,
      fullPath: tracks.fullPath,
      previewPath: tracks.previewPath,
      streamKey: tracks.streamKey,
      status: tracks.status
    }).from(tracks).where(eq(tracks.id, trackId)).limit(1);
  } catch (dbErr) {
    console.error('[stream] erro de banco na busca da faixa:', dbErr.code || dbErr.message);
    return sendError(res, 500, 'INTERNAL_STREAM_ERROR');
  }

  if (!track || track.status !== 'PUBLISHED') {
    return sendError(res, 404, 'TRACK_NOT_FOUND');
  }

  /* 5. Autorização decidida no servidor (S3).
     Pedidos explícitos ?type=full|download exigem acesso;
     sem type, serve o melhor nível autorizado (comportamento antigo). */
  const explicitFull = ['full', 'download'].includes(String(req.query?.type || '').trim());

  let accessLevel = 'preview';
  try {
    const user = await getAuthUser(req).catch(() => null);
    if (user) {
      const [sub] = await db.select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(
          eq(subscriptions.userId, user.id),
          eq(subscriptions.status, 'ACTIVE'),
          lte(subscriptions.currentPeriodStart, new Date().toISOString()),
          gt(subscriptions.currentPeriodEnd, new Date().toISOString())
        )).limit(1);

      if (!sub) {
        const [rental] = await db.select({ id: rentals.id })
          .from(rentals)
          .where(and(
            eq(rentals.userId, user.id),
            eq(rentals.trackId, trackId),
            eq(rentals.status, 'ACTIVE'),
            lte(rentals.startsAt, new Date().toISOString()),
            gt(rentals.expiresAt, new Date().toISOString())
          )).limit(1);
        if (rental) accessLevel = 'full';
      } else {
        accessLevel = 'full';
      }
    }
  } catch (authErr) {
    console.error('[stream] falha ao autorizar acesso:', authErr.code || authErr.message);
    // Fail-closed para pedidos explícitos; prévia pública segue disponível.
  }

  if (explicitFull && accessLevel !== 'full') {
    return sendError(res, 403, 'PREMIUM_REQUIRED',
      'Assine o Premium ou alugue esta faixa.');
  }

  /* 6. Entrega (302 — F-04) */
  try {
    if (accessLevel === 'full') {
      const objectKey = track.streamKey || track.fullPath; // S3: fallback antigo
      if (!objectKey) return sendError(res, 404, 'FULL_AUDIO_NOT_AVAILABLE');

      const signedUrl = await getPlaybackUrl(objectKey);
      if (typeof signedUrl !== 'string' || !signedUrl.startsWith('https://')) {
        throw new Error('URL assinada inválida.');
      }
      return res.redirect(302, signedUrl);
    }

    // Prévia → CDN pública (env obrigatória — S4)
    if (!CDN_BASE || !CDN_BASE.startsWith('https://')) {
      console.error('[stream] R2_PUBLIC_BASE_URL ausente/inválida para prévias.');
      return sendError(res, 503, 'CDN_UNAVAILABLE',
        'Serviço de áudio temporariamente indisponível.');
    }
    const previewKey = track.previewPath;
    if (!previewKey) return sendError(res, 404, 'PREVIEW_NOT_AVAILABLE');

    return res.redirect(302, `${CDN_BASE}/${encodeObjectKey(previewKey)}`);
  } catch (storageErr) {
    console.error('[stream] falha na entrega:', storageErr.message);
    if (!res.headersSent) {
      return sendError(res, 503, 'AUDIO_STORAGE_UNAVAILABLE',
        'Serviço de áudio temporariamente indisponível.');
    }
  }
};
