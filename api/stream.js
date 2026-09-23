/* ============================================================
   api/stream.js — Resolve URL de áudio com verificação de permissão
   ------------------------------------------------------------
   GET /api/stream?albumId=X&trackIndex=Y
   GET /api/stream?albumId=X&trackIndex=Y&debug=1

   Fluxo:
     1. Busca a faixa no banco
     2. Verifica permissão:
        a) premium / anual                → libera
        b) aluguel de ÁLBUM ativo         → libera
        c) aluguel de FAIXA ativo         → libera
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

   🔧 RECURSOS
   ------------------------------------------------------------
   1. preview_start / preview_duration no SELECT e na resposta
   2. Suporte a aluguel de ÁLBUM (scope='album') e FAIXA (scope='track')
   3. TTL padrão 1800s (30 min)
   4. Modo `?debug=1` — estado completo sem URLs
   5. Erros estruturados (code + message)
   6. encodePath() — path codificado por segmento
   7. normalizeSignedUrl() — aceita /object/sign/... ou URL absoluta
   8. objectExists() — HEAD no Storage antes de gerar signed URL
   9. source: 'preview' | 'full' | null
  10. mimeType inferido pela extensão
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

const DEFAULT_SIGNED_URL_TTL_SEC = 1800;
const MIN_SIGNED_URL_TTL_SEC = 60;
const MAX_SIGNED_URL_TTL_SEC = 3600;

const PREMIUM_BUCKET = 'audio-premium';
const PREVIEW_BUCKET = 'audio-preview';

const EXISTS_CACHE_TTL_MS = 60_000;
const _existsCache = new Map();

const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff'
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('Vary', 'Cookie, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Allow', 'GET, HEAD');

  const method = String(req.method || 'GET').toUpperCase();

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

  // ── 1) Buscar faixa
  let track;
  try {
    const query =
      `/rest/v1/tracks?album_id=eq.${encodeURIComponent(albumId)}` +
      `&track_index=eq.${trackIndex}` +
      `&select=id,album_id,track_index,title,` +
      `full_path,preview_path,preview_start,preview_duration,` +
      `published,for_sale,price_cents` +
      `&limit=1`;

    const result = await supabaseAdminRequest(query, { method: 'GET' });

    if (!result.response.ok) {
      console.error('[stream] Supabase erro:', result.response.status, result.body);
      return sendJson(res, 502, {
        ok: false,
        error: 'Serviço indisponível.',
        code: 'DB_ERROR'
      });
    }

    if (!Array.isArray(result.body) || !result.body[0]) {
      return sendJson(res, 404, {
        ok: false,
        error: 'Faixa não encontrada.',
        code: 'TRACK_NOT_FOUND'
      });
    }

    track = result.body[0];
  } catch (err) {
    console.error('[stream] erro ao buscar faixa:', err);
    return sendJson(res, 502, {
      ok: false,
      error: 'Serviço indisponível.',
      code: 'DB_ERROR'
    });
  }

  const previewStart = Math.max(0, Number(track.preview_start) || 0);
  const previewDuration = Math.max(1, Number(track.preview_duration) || 30);
  const previewMime = guessMime(track.preview_path);
  const fullMime = guessMime(track.full_path);

  // ── Debug
  if (debug) {
    const [previewExists, fullExists] = await Promise.all([
      track.preview_path ? objectExists(PREVIEW_BUCKET, track.preview_path) : false,
      track.full_path ? objectExists(PREMIUM_BUCKET, track.full_path) : false
    ]);

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
        previewPath: track.preview_path || null,
        previewExists,
        previewMime,
        previewStart,
        previewDuration,
        fullPath: track.full_path || null,
        fullExists,
        fullMime
      }
    });
  }

  // ── 2) Preview
  let previewUrl = null;
  if (track.preview_path) {
    const ok = await objectExists(PREVIEW_BUCKET, track.preview_path);
    if (ok) {
      previewUrl = buildPublicUrl(PREVIEW_BUCKET, track.preview_path);
    } else {
      console.warn('[stream] preview_path não existe:', track.preview_path);
    }
  }

  // ── 3) Permissão
  let unlocked = false;
  let reason = 'not_authenticated';
  let rentalExpiresAt = null;

  try {
    const user = await getAuthUser(req);

    if (user?.id) {
      reason = 'free_plan';

      const plan = await getPlanForUser(user.id);
      if (plan === 'premium' || plan === 'anual') {
        unlocked = true;
        reason = 'premium';
      } else {
        const now = new Date().toISOString();

        // 3.1) Aluguel de ÁLBUM ativo?
        const albumRental = await supabaseAdminRequest(
          `/rest/v1/rentals` +
          `?user_id=eq.${encodeURIComponent(user.id)}` +
          `&album_id=eq.${encodeURIComponent(albumId)}` +
          `&scope=eq.album` +
          `&status=eq.active` +
          `&expires_at=gt.${encodeURIComponent(now)}` +
          `&select=id,expires_at` +
          `&order=expires_at.desc` +
          `&limit=1`,
          { method: 'GET' }
        );

        if (
          albumRental.response.ok &&
          Array.isArray(albumRental.body) &&
          albumRental.body[0]
        ) {
          unlocked = true;
          reason = 'album_rental_active';
          rentalExpiresAt = albumRental.body[0].expires_at || null;
        } else {
          // 3.2) Aluguel de FAIXA ativo?
          const trackRental = await supabaseAdminRequest(
            `/rest/v1/rentals` +
            `?user_id=eq.${encodeURIComponent(user.id)}` +
            `&track_id=eq.${encodeURIComponent(track.id)}` +
            `&scope=eq.track` +
            `&status=eq.active` +
            `&expires_at=gt.${encodeURIComponent(now)}` +
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
    }
  } catch (err) {
    console.warn('[stream] erro ao verificar permissão:', err.message);
  }

  // ── 4) Sem acesso → só preview
  if (!unlocked) {
    return respond(res, method, {
      ok: true,
      unlocked: false,
      source: previewUrl ? 'preview' : null,
      reason,
      previewUrl,
      previewStart,
      previewDuration,
      previewMime,
      fullUrl: null,
      fullMime: null,
      expiresIn: null,
      rentalExpiresAt: null,
      warning: previewUrl
        ? null
        : (track.preview_path
            ? 'Arquivo de prévia não encontrado.'
            : 'Prévia não cadastrada.')
    });
  }

  // ── 5) Autorizado, mas sem full_path
  if (!track.full_path) {
    return respond(res, method, {
      ok: true,
      unlocked: true,
      source: previewUrl ? 'preview' : null,
      reason,
      previewUrl,
      previewStart,
      previewDuration,
      previewMime,
      fullUrl: null,
      fullMime: null,
      expiresIn: null,
      rentalExpiresAt,
      warning: 'Áudio completo não cadastrado.',
      code: 'FULL_PATH_MISSING'
    });
  }

  // ── 6) Autorizado, mas arquivo sumiu
  const fullExists = await objectExists(PREMIUM_BUCKET, track.full_path);
  if (!fullExists) {
    console.error('[stream] full_path não existe:', track.full_path);
    return respond(res, method, {
      ok: true,
      unlocked: true,
      source: previewUrl ? 'preview' : null,
      reason,
      previewUrl,
      previewStart,
      previewDuration,
      previewMime,
      fullUrl: null,
      fullMime: null,
      expiresIn: null,
      rentalExpiresAt,
      warning: 'Áudio completo não encontrado no Storage.',
      code: 'FULL_FILE_MISSING'
    });
  }

  // ── 7) Gera URL assinada
  const ttl = getSignedUrlTtl();

  let fullUrl;
  try {
    fullUrl = await createSignedUrl(PREMIUM_BUCKET, track.full_path, ttl);
  } catch (err) {
    console.error('[stream] erro ao criar URL assinada:', err);
    fullUrl = null;
  }

  if (!fullUrl) {
    return sendJson(res, 502, {
      ok: false,
      error: 'Falha ao gerar URL de áudio.',
      code: 'SIGNED_URL_ERROR'
    });
  }

  return respond(res, method, {
    ok: true,
    unlocked: true,
    source: 'full',
    reason,
    previewUrl,
    previewStart,
    previewDuration,
    previewMime,
    fullUrl,
    fullMime,
    expiresIn: ttl,
    rentalExpiresAt
  });
};

// ─────────────────────────────────────────────────────────────
// Helpers (iguais à versão anterior)
// ─────────────────────────────────────────────────────────────
function getSignedUrlTtl() {
  const raw = Number(process.env.SIGNED_URL_TTL_SEC);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SIGNED_URL_TTL_SEC;
  if (raw < MIN_SIGNED_URL_TTL_SEC) return MIN_SIGNED_URL_TTL_SEC;
  if (raw > MAX_SIGNED_URL_TTL_SEC) return MAX_SIGNED_URL_TTL_SEC;
  return raw;
}

function encodePath(path) {
  return String(path || '')
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function buildPublicUrl(bucket, path) {
  const { url } = getConfig();
  const clean = encodePath(path);
  return `${url}/storage/v1/object/public/${encodeURIComponent(bucket)}/${clean}`;
}

function normalizeSignedUrl(signedURL, baseUrl) {
  const raw = String(signedURL || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/storage/v1/')) return baseUrl + raw;
  const clean = raw.replace(/^\/+/, '');
  return `${baseUrl}/storage/v1/${clean}`;
}

async function createSignedUrl(bucket, path, expiresInSec) {
  const { url } = getConfig();
  const adminKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!adminKey) {
    console.error('[stream] SUPABASE_SERVICE_ROLE_KEY ausente');
    return null;
  }

  const clean = encodePath(path);
  const endpoint =
    `${url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${clean}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: expiresInSec })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('[stream] Storage sign:', response.status, body.slice(0, 500));
      return null;
    }

    const data = await response.json();
    if (!data?.signedURL) return null;

    return normalizeSignedUrl(data.signedURL, url);
  } catch (err) {
    console.error('[stream] erro de rede:', err.message);
    return null;
  }
}

async function objectExists(bucket, path) {
  if (!bucket || !path) return false;

  const key = `${bucket}/${path}`;
  const now = Date.now();
  const cached = _existsCache.get(key);

  if (cached && (now - cached.checkedAt) < EXISTS_CACHE_TTL_MS) {
    return cached.exists;
  }

  const { url } = getConfig();
  const adminKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!adminKey) return false;

  const clean = encodePath(path);
  const endpoint =
    `${url}/storage/v1/object/${encodeURIComponent(bucket)}/${clean}`;

  try {
    const r = await fetch(endpoint, {
      method: 'HEAD',
      headers: {
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`
      }
    });

    const exists = r.ok;
    _existsCache.set(key, { exists, checkedAt: now });
    return exists;
  } catch (err) {
    console.warn('[stream] objectExists falhou:', bucket, path, err.message);
    return false;
  }
}

function guessMime(path) {
  if (!path) return null;
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function respond(res, method, payload) {
  if (method === 'HEAD') {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end();
  }
  return sendJson(res, 200, payload);
}
