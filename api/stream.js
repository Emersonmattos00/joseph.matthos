/* ============================================================
   api/stream.js — Resolve URL de áudio com verificação de permissão
   ------------------------------------------------------------
   GET /api/stream?albumId=X&trackIndex=Y
   GET /api/stream?albumId=X&trackIndex=Y&debug=1

   Fluxo:
     1. Busca a faixa no banco
     2. Verifica permissão:
        a) premium / anual                → libera
        b) aluguel de faixa ativo         → libera
     3. SEM acesso → retorna previewUrl (público) + previewStart
     4. COM acesso → retorna fullUrl ASSINADA (expira em TTL configurável)

   🛡️ SEGURANÇA
   ------------------------------------------------------------
   - Cache-Control: private, no-store (nunca cachear)
   - Vary: Cookie, Authorization (resposta muda por usuário)
   - Referrer-Policy: no-referrer (não vaza URL assinada)
   - X-Content-Type-Options: nosniff
   - URLs assinadas NUNCA vão para CDN/browser cache
   - TTL configurável via env, com clamp entre 60s e 3600s

   🔧 CORREÇÕES APLICADAS
   ------------------------------------------------------------
   1. Inclui `preview_start` no SELECT e na resposta (previewStart)
   2. Remove `scope=eq.track` (coluna inexistente no schema)
   3. Remove verificação de aluguel de álbum (não suportado no schema)
   4. TTL padrão elevado para 1800s (30 min) — cobre músicas longas
   5. Modo `?debug=1` devolve estado completo da faixa (sem URLs)
   6. Respostas de erro estruturadas (code + message)
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

// ─────────────────────────────────────────────────────────────
// TTL da URL assinada
// ------------------------------------------------------------
// Default: 30 minutos (1800s) — cobre músicas longas + pausas
// Mínimo:  1 minuto  (60s)   — evita configuração absurda
// Máximo:  1 hora    (3600s) — evita link quase permanente
//
// Env opcional:
//   SIGNED_URL_TTL_SEC=1800
// ─────────────────────────────────────────────────────────────
const DEFAULT_SIGNED_URL_TTL_SEC = 1800;
const MIN_SIGNED_URL_TTL_SEC = 60;
const MAX_SIGNED_URL_TTL_SEC = 3600;

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
  const debug = String(req.query?.debug || '') === '1';

  if (!albumId || !Number.isInteger(trackIndex) || trackIndex < 0) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Parâmetros inválidos.',
      code: 'INVALID_PARAMS'
    });
  }

  // ── 1) Buscar a faixa
  let track = null;
  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/tracks?album_id=eq.${encodeURIComponent(albumId)}` +
      `&track_index=eq.${trackIndex}` +
      `&select=id,album_id,track_index,title,` +
      `full_path,preview_path,preview_start,preview_duration,` +
      `published,for_sale,price_cents` +
      `&limit=1`,
      { method: 'GET' }
    );

    if (!r.response.ok) {
      console.error('[stream] Supabase erro:', r.response.status, r.body);
      return sendJson(res, 502, {
        ok: false,
        error: 'Serviço indisponível.',
        code: 'DB_ERROR'
      });
    }

    if (!Array.isArray(r.body) || !r.body[0]) {
      return sendJson(res, 404, {
        ok: false,
        error: 'Faixa não encontrada.',
        code: 'TRACK_NOT_FOUND'
      });
    }

    track = r.body[0];
  } catch (err) {
    console.error('[stream] erro ao buscar faixa:', err.message);
    return sendJson(res, 502, {
      ok: false,
      error: 'Serviço indisponível.',
      code: 'DB_ERROR'
    });
  }

  // ── Modo debug: devolve estado sem URLs assinadas
  if (debug) {
    return respond(res, method, {
      ok: true,
      debug: true,
      track: {
        id: track.id,
        albumId: track.album_id,
        trackIndex: track.track_index,
        title: track.title,
        published: !!track.published,
        forSale: !!track.for_sale,
        priceCents: Number(track.price_cents) || 0,
        hasPreviewPath: !!track.preview_path,
        hasFullPath: !!track.full_path,
        previewPath: track.preview_path || null,
        fullPath: track.full_path || null,
        previewStart: Number(track.preview_start) || 0,
        previewDuration: Number(track.preview_duration) || 30
      }
    });
  }

  // ── 2) Preview é sempre público
  const previewUrl = track.preview_path
    ? buildPublicUrl(PREVIEW_BUCKET, track.preview_path)
    : null;

  const previewStart = Number(track.preview_start) || 0;
  const previewDuration = Number(track.preview_duration) || 30;

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
        // 3.2) Aluguel de FAIXA ativo?
        // ⚠️  rentals NÃO tem coluna `scope` nem `album_id` no schema.
        //     Só verificamos por track_id.
        const nowIso = new Date().toISOString();

        const trackRental = await supabaseAdminRequest(
          `/rest/v1/rentals?user_id=eq.${encodeURIComponent(user.id)}` +
          `&track_id=eq.${encodeURIComponent(track.id)}` +
          `&status=eq.active` +
          `&expires_at=gt.${encodeURIComponent(nowIso)}` +
          `&select=id,expires_at` +
          `&order=expires_at.desc` +
          `&limit=1`,
          { method: 'GET' }
        );

        if (
          trackRental.response.ok &&
          Array.isArray(trackRental.body) &&
          trackRental.body[0]
        ) {
          unlocked = true;
          reason = 'track_rental_active';
          rentalExpiresAt = trackRental.body[0].expires_at || null;
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
      previewStart,
      previewDuration,
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
      previewStart,
      previewDuration,
      fullUrl: null,
      expiresIn: null,
      rentalExpiresAt,
      warning: 'Áudio completo não cadastrado.',
      code: 'FULL_PATH_MISSING'
    });
  }

  const ttl = getSignedUrlTtl();
  const signedUrl = await createSignedUrl(PREMIUM_BUCKET, track.full_path, ttl);

  if (!signedUrl) {
    return sendJson(res, 502, {
      ok: false,
      error: 'Falha ao gerar URL de áudio.',
      code: 'SIGN_FAILED'
    });
  }

  return respond(res, method, {
    ok: true,
    unlocked: true,
    reason,
    previewUrl,
    previewStart,
    previewDuration,
    fullUrl: signedUrl,
    expiresIn: ttl,
    rentalExpiresAt
  });
};

// ─────────────────────────────────────────────────────────────
// TTL configurável com clamp
// ─────────────────────────────────────────────────────────────
function getSignedUrlTtl() {
  const raw = Number(process.env.SIGNED_URL_TTL_SEC);

  if (!Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_SIGNED_URL_TTL_SEC;
  }

  if (raw < MIN_SIGNED_URL_TTL_SEC) {
    console.warn(
      `[stream] SIGNED_URL_TTL_SEC=${raw} abaixo do mínimo (${MIN_SIGNED_URL_TTL_SEC}); usando ${MIN_SIGNED_URL_TTL_SEC}`
    );
    return MIN_SIGNED_URL_TTL_SEC;
  }

  if (raw > MAX_SIGNED_URL_TTL_SEC) {
    console.warn(
      `[stream] SIGNED_URL_TTL_SEC=${raw} acima do máximo (${MAX_SIGNED_URL_TTL_SEC}); usando ${MAX_SIGNED_URL_TTL_SEC}`
    );
    return MAX_SIGNED_URL_TTL_SEC;
  }

  return raw;
}

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
