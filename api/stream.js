/* ============================================================
   api/stream.js — Resolve URL de áudio com verificação de permissão
   ------------------------------------------------------------
   GET /api/stream?albumId=X&trackIndex=Y

   Fluxo:
     1. Busca a faixa no banco
     2. Verifica se o usuário tem acesso (premium ou aluguel ativo)
     3. SEM acesso → retorna previewUrl (público)
     4. COM acesso → retorna fullUrl ASSINADA (expira em 10 min)
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

const SIGNED_URL_TTL_SEC = 600;          // 10 min
const PREMIUM_BUCKET = 'audio-premium';
const PREVIEW_BUCKET = 'audio-preview';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed(res, 'GET, HEAD');
  }

  const albumId = String(req.query?.albumId || '').trim();
  const trackIndexRaw = req.query?.trackIndex;
  const trackIndex = Number(trackIndexRaw);

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

  // ── 2) Preview é sempre público (path relativo no bucket público)
  const previewUrl = track.preview_path
    ? buildPublicUrl(PREVIEW_BUCKET, track.preview_path)
    : null;

  // ── 3) Verificar permissão
  let unlocked = false;
  let reason = 'not_authenticated';

  try {
    const user = await getAuthUser(req);

    if (user && user.id) {
      reason = 'free_plan';

      const plan = await getPlanForUser(user.id);
      if (plan === 'premium' || plan === 'anual') {
        unlocked = true;
        reason = 'premium';
      } else {
        // Verifica aluguel ativo
        const trackKey = `${albumId}:${trackIndex}`;
        const nowIso = new Date().toISOString();

        const r = await supabaseAdminRequest(
          `/rest/v1/rentals?user_id=eq.${encodeURIComponent(user.id)}` +
          `&track_key=eq.${encodeURIComponent(trackKey)}` +
          `&status=eq.active` +
          `&expires_at=gt.${encodeURIComponent(nowIso)}` +
          `&select=id&limit=1`,
          { method: 'GET' }
        );

        if (r.response.ok && Array.isArray(r.body) && r.body.length > 0) {
          unlocked = true;
          reason = 'rental_active';
        }
      }
    }
  } catch (err) {
    console.warn('[stream] erro ao verificar permissão:', err.message);
    // fail-safe: mantém unlocked=false
  }

  // ── 4) Sem acesso → só preview
  if (!unlocked) {
    return sendJson(res, 200, {
      ok: true,
      unlocked: false,
      reason,
      previewUrl,
      previewDuration: track.preview_duration || 30,
      fullUrl: null,
      expiresIn: null
    });
  }

  // ── 5) Com acesso → URL assinada
  if (!track.full_path) {
    return sendJson(res, 200, {
      ok: true,
      unlocked: true,
      reason,
      previewUrl,
      previewDuration: track.preview_duration || 30,
      fullUrl: null,
      expiresIn: null,
      warning: 'Áudio completo não cadastrado.'
    });
  }

  const signedUrl = await createSignedUrl(PREMIUM_BUCKET, track.full_path, SIGNED_URL_TTL_SEC);

  if (!signedUrl) {
    return sendJson(res, 502, { ok: false, error: 'Falha ao gerar URL de áudio.' });
  }

  return sendJson(res, 200, {
    ok: true,
    unlocked: true,
    reason,
    previewUrl,
    previewDuration: track.preview_duration || 30,
    fullUrl: signedUrl,
    expiresIn: SIGNED_URL_TTL_SEC
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

    // signedURL vem como "/object/sign/bucket/path?token=..."
    const rel = String(json.signedURL).replace(/^\/+/, '');
    return `${url}/storage/v1/${rel}`;
  } catch (err) {
    console.error('[stream] sign error:', err.message);
    return null;
  }
}