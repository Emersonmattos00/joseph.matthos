/* ============================================================
   api/stream.js — Resolve URL de áudio com verificação de permissão
   ------------------------------------------------------------
   GET /api/stream?albumId=X&trackIndex=Y

   Fluxo:
     1. Busca a faixa no banco
     2. Verifica permissão:
        a) premium / anual                → libera
        b) aluguel de álbum ativo         → libera
        c) aluguel de faixa ativo         → libera
     3. SEM acesso → retorna previewUrl (público)
     4. COM acesso → retorna fullUrl ASSINADA (expira em 10 min)

   🛡️ SEGURANÇA
   ------------------------------------------------------------
   - Cache-Control: private, no-store (nunca cachear)
   - Vary: Cookie, Authorization (resposta muda por usuário)
   - Referrer-Policy: no-referrer (não vaza URL assinada)
   - X-Content-Type-Options: nosniff
   - URLs assinadas NUNCA vão para CDN/browser cache
   ============================================================ */

'use strict';

const {
  sendJson,
  methodNotAllowed,
  getAuthUser,
  getPlanForUser,
  supabaseAdminRequest,
  getConfig
} = require('./_lib');

const SIGNED_URL_TTL_SEC = 600;
const PREMIUM_BUCKET = 'audio-premium';
const PREVIEW_BUCKET = 'audio-preview';

module.exports = async function handler(req, res) {
  // ── Headers de segurança e cache (CRÍTICO — sempre antes de tudo)
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('Vary', 'Cookie, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Allow', 'GET, HEAD');

  const method = (req.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    return methodNotAllowed(res, 'GET, HEAD');
  }

  const albumId = String(req.query?.albumId || '').trim();
  const trackIndex = Number(req.query?.trackIndex);

  if (!albumId || !Number.isInteger(trackIndex) || trackIndex < 0) {
    return sendJson(res, 400, { ok: false, error: 'Parâmetros inválidos.' });
  }

  // ── 1) Buscar a faixa
  let track = null;
  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/tracks?album_id=eq.${encodeURIComponent(albumId)}` +
      `&track_index=eq.${trackIndex}` +
      `&select=id,album_id,track_index,title,full_path,preview_path,preview_duration` +
      `&limit=1`,
      { method: 'GET' }
    );

    if (!r.response.ok || !Array.isArray(r.body) || !r.body[0]) {
      return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
    }
    track = r.body[0];
  } catch (err) {
    console.error('[stream] erro ao buscar faixa:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }

  // ── 2) Preview é sempre público
  const previewUrl = track.preview_path
    ? buildPublicUrl(PREVIEW_BUCKET, track.preview_path)
    : null;

  // ── 3) Verificar permissão
  let unlocked = false;
  let reason = 'not_authenticated';
  let rentalExpiresAt = null;

  try {
    const user = await getAuthUser(req);

    if (user && user.id) {
      reason = 'free_plan';

      // 3.1) Premium?
      const plan = await getPlanForUser(user.id);
      if (plan === 'premium' || plan === 'anual') {
        unlocked = true;
        reason = 'premium';
      } else {
        const nowIso = new Date().toISOString();

        // 3.2) Aluguel de ÁLBUM ativo?
        const albumRental = await supabaseAdminRequest(
          `/rest/v1/rentals?user_id=eq.${encodeURIComponent(user.id)}` +
          `&album_id=eq.${encodeURIComponent(albumId)}` +
          `&scope=eq.album` +
          `&status=eq.active` +
          `&expires_at=gt.${encodeURIComponent(nowIso)}` +
          `&select=id,expires_at` +
          `&order=expires_at.desc` +
          `&limit=1`,
          { method: 'GET' }
        );

        if (albumRental.response.ok
            && Array.isArray(albumRental.body)
            && albumRental.body[0]) {
          unlocked = true;
          reason = 'album_rental_active';
          rentalExpiresAt = albumRental.body[0].expires_at || null;
        } else {
          // 3.3) Aluguel de FAIXA ativo?
          const trackRental = await supabaseAdminRequest(
            `/rest/v1/rentals?user_id=eq.${encodeURIComponent(user.id)}` +
            `&track_id=eq.${track.id}` +
            `&scope=eq.track` +
            `&status=eq.active` +
            `&expires_at=gt.${encodeURIComponent(nowIso)}` +
            `&select=id,expires_at` +
            `&order=expires_at.desc` +
            `&limit=1`,
            { method: 'GET' }
          );

          if (trackRental.response.ok
              && Array.isArray(trackRental.body)
              && trackRental.body[0]) {
            unlocked = true;
            reason = 'track_rental_active';
            rentalExpiresAt = trackRental.body[0].expires_at || null;
          }
        }
      }
    }
  } catch (err) {
    console.warn('[stream] erro ao verificar permissão:', err.message);
  }

  // ── 4) Sem acesso → só preview
  if (!unlocked) {
    return respond(res, method, {
      ok: true,
      unlocked: false,
      reason,
      previewUrl,
      previewDuration: track.preview_duration || 30,
      fullUrl: null,
      expiresIn: null,
      rentalExpiresAt: null
    });
  }

  // ── 5) Com acesso → URL assinada
  if (!track.full_path) {
    return respond(res, method, {
      ok: true,
      unlocked: true,
      reason,
      previewUrl,
      previewDuration: track.preview_duration || 30,
      fullUrl: null,
      expiresIn: null,
      rentalExpiresAt,
      warning: 'Áudio completo não cadastrado.'
    });
  }

  const signedUrl = await createSignedUrl(PREMIUM_BUCKET, track.full_path, SIGNED_URL_TTL_SEC);

  if (!signedUrl) {
    return sendJson(res, 502, { ok: false, error: 'Falha ao gerar URL de áudio.' });
  }

  return respond(res, method, {
    ok: true,
    unlocked: true,
    reason,
    previewUrl,
    previewDuration: track.preview_duration || 30,
    fullUrl: signedUrl,
    expiresIn: SIGNED_URL_TTL_SEC,
    rentalExpiresAt
  });
};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function buildPublicUrl(bucket, path) {
  const { url } = getConfig();
  const clean = String(path).replace(/^\/+/, '');
  return `${url}/storage/v1/object/public/${bucket}/${clean}`;
}

async function createSignedUrl(bucket, path, expiresInSec) {
  const { url } = getConfig();
  const adminKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!adminKey) return null;

  const clean = String(path).replace(/^\/+/, '');

  try {
    const r = await fetch(
      `${url}/storage/v1/object/sign/${bucket}/${clean}`,
      {
        method: 'POST',
        headers: {
          apikey: adminKey,
          Authorization: `Bearer ${adminKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ expiresIn: expiresInSec })
      }
    );

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[stream] sign failed:', r.status, text.slice(0, 200));
      return null;
    }

    const json = await r.json();
    if (!json.signedURL) return null;

    const rel = String(json.signedURL).replace(/^\/+/, '');
    return `${url}/storage/v1/${rel}`;
  } catch (err) {
    console.error('[stream] sign error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Resposta genérica (trata HEAD)
// ─────────────────────────────────────────────────────────────
function respond(res, method, payload) {
  if (method === 'HEAD') {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end();
  }
  return sendJson(res, 200, payload);
}
