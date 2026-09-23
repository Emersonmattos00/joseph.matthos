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
   7. encodePath() — path codificado por segmento (espaços/acentos)
   8. normalizeSignedUrl() — aceita /object/sign/... ou URL absoluta
   9. objectExists() — HEAD no Storage antes de gerar signed URL
  10. source: 'preview' | 'full' | null — frontend sabe o que toca
  11. mimeType inferido pela extensão do arquivo
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

// Cache em memória: path → { exists: bool, checkedAt: ms }
// Evita HEAD a cada requisição em faixas populares.
// TTL curto para não atrapalhar uploads recentes.
const EXISTS_CACHE_TTL_MS = 60_000;
const _existsCache = new Map();

// ─────────────────────────────────────────────────────────────
// MIME por extensão (para diagnóstico)
// ─────────────────────────────────────────────────────────────
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

  const previewStart = Number(track.preview_start) || 0;
  const previewDuration = Number(track.preview_duration) || 30;
  const previewMime = guessMime(track.preview_path);
  const fullMime = guessMime(track.full_path);

  // ── Modo debug: devolve estado sem URLs assinadas
  if (debug) {
    const [previewExists, fullExists] = await Promise.all([
      track.preview_path
        ? objectExists(PREVIEW_BUCKET, track.preview_path)
        : Promise.resolve(false),
      track.full_path
        ? objectExists(PREMIUM_BUCKET, track.full_path)
        : Promise.resolve(false)
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

  // ── 2) Preview: valida existência antes de expor URL
  let previewUrl = null;
  if (track.preview_path) {
    const ok = await objectExists(PREVIEW_BUCKET, track.preview_path);
    if (ok) {
      previewUrl = buildPublicUrl(PREVIEW_BUCKET, track.preview_path);
    } else {
      console.warn(
        '[stream] preview_path não existe no Storage:',
        PREVIEW_BUCKET + '/' + track.preview_path
      );
    }
  }

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
    const source = previewUrl ? 'preview' : null;

    return respond(res, method, {
      ok: true,
      unlocked: false,
      source,
      reason,
      previewUrl,
      previewStart,
      previewDuration,
      previewMime,
      fullUrl: null,
      fullMime: null,
      expiresIn: null,
      rentalExpiresAt: null,

      // Diagnóstico explícito
      warning: previewUrl
        ? null
        : (track.preview_path
            ? 'Arquivo de prévia não encontrado no Storage.'
            : 'Prévia não cadastrada.')
    });
  }

  // ── 5) Com acesso → URL assinada
  if (!track.full_path) {
    const source = previewUrl ? 'preview' : null;
    return respond(res, method, {
      ok: true,
      unlocked: true,
      source,
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

  const fullExists = await objectExists(PREMIUM_BUCKET, track.full_path);
  if (!fullExists) {
    console.error(
      '[stream] full_path não existe no Storage:',
      PREMIUM_BUCKET + '/' + track.full_path
    );

    // Cai para preview como fallback (usuário pagou mas arquivo sumiu)
    const source = previewUrl ? 'preview' : null;

    return respond(res, method, {
      ok: true,
      unlocked: true,
      source,
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
    source: 'full',
    reason,
    previewUrl,
    previewStart,
    previewDuration,
    previewMime,
    fullUrl: signedUrl,
    fullMime,
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
// Path encoding — PROBLEMA 2
// ------------------------------------------------------------
// Codifica cada segmento do path separadamente, preservando "/".
// Isso evita quebrar nomes com espaços, acentos, #, ?, etc.
// ─────────────────────────────────────────────────────────────
function encodePath(path) {
  return String(path || '')
    .replace(/^\/+/, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

// ─────────────────────────────────────────────────────────────
// Public URL builder
// ─────────────────────────────────────────────────────────────
function buildPublicUrl(bucket, path) {
  const { url } = getConfig();
  const clean = encodePath(path);
  return `${url}/storage/v1/object/public/${bucket}/${clean}`;
}

// ─────────────────────────────────────────────────────────────
// Signed URL — PROBLEMA 3
// ------------------------------------------------------------
// O Supabase pode devolver:
//   a) "/object/sign/bucket/file.mp3?token=..."       (relativo)
//   b) "/storage/v1/object/sign/bucket/file.mp3?..."  (já prefixado)
//   c) "https://xxx.supabase.co/storage/v1/object/..." (absoluto)
//
// normalizeSignedUrl() cobre todos os casos sem duplicar prefixo.
// ─────────────────────────────────────────────────────────────
function normalizeSignedUrl(signedURL, baseUrl) {
  const raw = String(signedURL || '').trim();
  if (!raw) return null;

  // (c) URL absoluta — devolve como está
  if (/^https?:\/\//i.test(raw)) return raw;

  // (b) já vem com /storage/v1/
  if (raw.startsWith('/storage/v1/')) {
    return baseUrl + raw;
  }

  // (a) relativo: /object/sign/...
  const clean = raw.replace(/^\/+/, '');
  return `${baseUrl}/storage/v1/${clean}`;
}

async function createSignedUrl(bucket, path, expiresInSec) {
  const { url } = getConfig();
  const adminKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!adminKey) return null;

  const clean = encodePath(path);
  const endpoint = `${url}/storage/v1/object/sign/${bucket}/${clean}`;

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: adminKey,
        Authorization: `Bearer ${adminKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: expiresInSec })
    });

    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[stream] sign failed:', r.status, text.slice(0, 200));
      return null;
    }

    const json = await r.json();
    if (!json.signedURL) return null;

    return normalizeSignedUrl(json.signedURL, url);
  } catch (err) {
    console.error('[stream] sign error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// objectExists — PROBLEMA 4
// ------------------------------------------------------------
// HEAD no objeto do Storage. Usa cache em memória por 60s para
// não pesar em faixas populares.
//
// Retorna true/false. Nunca lança.
// ─────────────────────────────────────────────────────────────
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
  const endpoint = `${url}/storage/v1/object/${bucket}/${clean}`;

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
    // Não cacheia erro de rede (pode ser transitório)
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// MIME por extensão — PROBLEMA 6
// ─────────────────────────────────────────────────────────────
function guessMime(path) {
  if (!path) return null;
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || null;
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
