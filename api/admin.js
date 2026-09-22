/* ============================================================
   api/admin.js — Painel administrativo
   ------------------------------------------------------------
   POST   /api/admin?action=login        → login admin
   GET    /api/admin?action=session      → valida sessão
   POST   /api/admin?action=logout       → encerra sessão
   GET    /api/admin?action=content      → lê conteúdo
   PUT    /api/admin?action=content      → salva conteúdo
   POST   /api/admin?action=upload       → upload (imagem/áudio)
   GET    /api/admin?action=users        → lista usuários + planos
   PATCH  /api/admin?action=users        → altera plano manualmente
   GET    /api/admin?action=sales        → assinaturas + rentals + eventos
   GET    /api/admin?action=audit        → eventos de auditoria

   ── Discografia (v2) ─────────────────────────────────────────
   GET    /api/admin?action=albums       → lista álbuns
   POST   /api/admin?action=albums       → cria álbum
   GET    /api/admin?action=album&id=X   → detalhe do álbum
   PATCH  /api/admin?action=album&id=X   → atualiza álbum
   DELETE /api/admin?action=album&id=X   → exclui álbum
   GET    /api/admin?action=tracks&albumId=X  → lista faixas
   POST   /api/admin?action=tracks       → cria faixa
   PATCH  /api/admin?action=track&id=X   → atualiza faixa
   DELETE /api/admin?action=track&id=X   → exclui faixa
   PATCH  /api/admin?action=track-order  → reordena faixas

   - Sessão via cookie __Host-jm_admin (HttpOnly + HMAC assinado)
   - ADMIN_SESSION_SECRET exige mínimo de 32 caracteres
   - CSRF: Origin check em todos os métodos mutantes
   - Rate limit por IP no login (fail-closed: bloqueia se KV cair)
   - Auditoria em toda escrita
   - Upload roteia para o bucket correto:
       image         → site-assets     (público)
       audio-preview → audio-preview   (público)
       audio-full    → audio-premium   (privado)
   - Playlists: sanitizadas para aceitar apenas track.id (integer)
   ============================================================ */

'use strict';

const crypto = require('crypto');

const {
  // HTTP
  sendJson,
  methodNotAllowed,
  parseBody,
  parseCookies,
  clientIp,

  // Supabase
  supabaseAdminRequest,

  // Rate limit
  checkAndIncrement,
  resetBucket,

  // Auditoria
  audit,

  // Plano
  VALID_PLANS,

  // HMAC
  signHmac,
  verifyHmac,

  // Senha
  verifyScrypt,
  timingSafeEq,

  // CSRF
  checkOrigin,

  // Ambiente
  IS_PROD
} = require('./_lib');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const SESSION_COOKIE_PROD = '__Host-jm_admin';
const SESSION_COOKIE_DEV = 'jm_admin';
const SESSION_COOKIE = IS_PROD ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;

const SESSION_MAX_AGE = 60 * 60 * 4; // 4h
const MIN_SESSION_SECRET_LENGTH = 32;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const CONTENT_KEY = 'default';
const MAX_CONTENT_BYTES = 2_000_000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const SALES_LIMIT = 500;
const AUDIT_LIMIT = 100;
const AUDIT_MAX_LIMIT = 500;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_AUDIO_SIZE = 4 * 1024 * 1024;

// Buckets válidos por tipo de upload
const BUCKET_BY_KIND = {
  'image': 'site-assets',
  'audio-preview': 'audio-preview',
  'audio-full': 'audio-premium'
};

const VALID_ACTIONS = new Set([
  'login',
  'session',
  'logout',
  'content',
  'upload',
  'users',
  'sales',
  'audit',
  'gen-hash',
  // Discografia
  'albums',
  'album',
  'tracks',
  'track',
  'track-order'
]);

const VALID_ALBUM_TYPES = new Set(['album', 'ep', 'single']);

// ─────────────────────────────────────────────────────────────
// Segredo da sessão — validação
// ─────────────────────────────────────────────────────────────
function getSessionSecret() {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();

  if (!secret) {
    const err = new Error('ADMIN_SESSION_SECRET ausente.');
    err.code = 'SECRET_MISSING';
    throw err;
  }

  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    const err = new Error(
      `ADMIN_SESSION_SECRET deve ter no mínimo ${MIN_SESSION_SECRET_LENGTH} caracteres (atual: ${secret.length}).`
    );
    err.code = 'SECRET_TOO_SHORT';
    throw err;
  }

  return secret;
}

// ─────────────────────────────────────────────────────────────
// Handler principal
// ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const action = parseAction(req.query);
  if (!action) {
    return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
  }

  const method = (req.method || 'GET').toUpperCase();

  // ── CSRF: Origin check em métodos mutantes
  if (method !== 'GET' && method !== 'HEAD') {
    if (!checkOrigin(req)) {
      console.warn('[admin] Origin rejeitada:', {
        action,
        method,
        origin: req.headers.origin || req.headers.referer || null
      });
      return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
    }
  }

  // ── Login: público, com rate limit
  if (action === 'login') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    return handleLogin(req, res);
  }

  // ── Todas as outras ações exigem sessão
  const session = verifySession(req);
  if (!session) {
    return sendJson(res, 401, { ok: false, error: 'Não autorizado.' });
  }

  switch (action) {
    case 'session':
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
      return handleSession(req, res, session);

    case 'logout':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleLogout(req, res, session);

    case 'content':
      if (method === 'GET') return handleGetContent(req, res);
      if (method === 'PUT') return handlePutContent(req, res, session);
      return methodNotAllowed(res, 'GET, PUT');

    case 'upload':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleUpload(req, res, session);

    case 'users':
      if (method === 'GET') return handleGetUsers(req, res);
      if (method === 'PATCH') return handlePatchUser(req, res, session);
      return methodNotAllowed(res, 'GET, PATCH');

    case 'sales':
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleGetSales(req, res);

    case 'audit':
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleGetAudit(req, res);

    case 'gen-hash':
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleGenHash(req, res, session);

    // ── Discografia: álbuns
    case 'albums':
      if (method === 'GET')  return handleListAlbums(req, res);
      if (method === 'POST') return handleCreateAlbum(req, res, session);
      return methodNotAllowed(res, 'GET, POST');

    case 'album':
      if (method === 'GET')    return handleGetAlbum(req, res);
      if (method === 'PATCH')  return handleUpdateAlbum(req, res, session);
      if (method === 'DELETE') return handleDeleteAlbum(req, res, session);
      return methodNotAllowed(res, 'GET, PATCH, DELETE');

    // ── Discografia: faixas
    case 'tracks':
      if (method === 'GET')  return handleListTracks(req, res);
      if (method === 'POST') return handleCreateTrack(req, res, session);
      return methodNotAllowed(res, 'GET, POST');

    case 'track':
      if (method === 'PATCH')  return handleUpdateTrack(req, res, session);
      if (method === 'DELETE') return handleDeleteTrack(req, res, session);
      return methodNotAllowed(res, 'PATCH, DELETE');

    case 'track-order':
      if (method === 'PATCH') return handleReorderTracks(req, res, session);
      return methodNotAllowed(res, 'PATCH');

    default:
      return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
  }
};

// ─────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  // ⚠️ failClosed: true → se o KV cair, bloqueia login por segurança.
  const rate = await checkAndIncrement(
    `admin-login:${ip}`,
    MAX_LOGIN_ATTEMPTS,
    LOGIN_WINDOW_MS,
    { failClosed: true }
  );
  if (rate.limited) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    console.warn(
      `[admin-login] rate limited ip=${ip} reason=${rate.reason || 'unknown'} retryAfter=${rate.retryAfter}`
    );
    await audit('admin_login', {
      ip,
      userAgent,
      success: false,
      reason: rate.reason || 'rate_limited'
    });
    return sendJson(res, 429, {
      ok: false,
      error: 'Muitas tentativas. Tente novamente mais tarde.'
    });
  }

  const body = parseBody(req);
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');

  const expectedUser = String(process.env.ADMIN_USER || '').trim();
  const hash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();

  let secret;
  try {
    secret = getSessionSecret();
  } catch (err) {
    console.error('[admin/login]', err.code, err.message);
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
  }

  if (!expectedUser || !hash) {
    console.error('[admin/login] ADMIN_USER ou ADMIN_PASSWORD_HASH ausente');
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
  }

  const userOk = timingSafeEq(user, expectedUser);
  const passOk = await verifyScrypt(pass, hash);

  if (!userOk || !passOk) {
    await audit('admin_login', {
      ip,
      userAgent,
      success: false,
      reason: 'invalid',
      target: user
    });
    return sendJson(res, 401, { ok: false, error: 'Usuário ou senha incorretos.' });
  }

  // Login OK → zera o contador de tentativas deste IP.
  await resetBucket(`admin-login:${ip}`);

  const token = signHmac({ user: expectedUser, iat: Date.now() }, secret);

  const cookieAttrs = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE}`,
    IS_PROD ? 'Secure' : null
  ].filter(Boolean).join('; ');

  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs}`);

  await audit('admin_login', {
    actor: expectedUser,
    ip,
    userAgent,
    success: true
  });

  return sendJson(res, 200, { ok: true, user: expectedUser });
}

// ─────────────────────────────────────────────────────────────
// SESSION / LOGOUT
// ─────────────────────────────────────────────────────────────
async function handleSession(req, res, session) {
  const method = (req.method || 'GET').toUpperCase();

  if (method === 'HEAD') {
    res.status(200);
    return res.end();
  }

  return sendJson(res, 200, { ok: true, user: session.user });
}

async function handleLogout(req, res, session) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  const cookieAttrs = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    IS_PROD ? 'Secure' : null
  ].filter(Boolean).join('; ');

  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE}=; ${cookieAttrs}`,
    `jm_admin=; ${cookieAttrs}`,
    `__Host-jm_admin=; ${cookieAttrs}`
  ]);
  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');

  await audit('admin_logout', {
    actor: session.user,
    ip,
    userAgent,
    success: true
  });

  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// CONTENT — GET
// ─────────────────────────────────────────────────────────────
async function handleGetContent(req, res) {
  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/site_content?key=eq.${CONTENT_KEY}&select=data,version,updated_at&limit=1`,
      { method: 'GET' }
    );

    if (!r.response.ok) {
      console.error('[admin/content] Supabase erro');
      return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
    }

    const row = Array.isArray(r.body) ? r.body[0] : null;

    return sendJson(res, 200, {
      ok: true,
      data: row?.data && typeof row.data === 'object' ? row.data : {},
      version: Number(row?.version) || 0,
      updatedAt: row?.updated_at || null
    });
  } catch (err) {
    console.error('[admin/content] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// CONTENT — PUT
// ------------------------------------------------------------
// Sanitiza playlists antes de persistir:
//   - tracks deve ser array de inteiros positivos (track.id)
//   - strings legadas "albumId:index" são descartadas
// ============================================================
async function handlePutContent(req, res, session) {
  const body = parseBody(req);
  const data = body.data;
  const baseVersion = Number.isFinite(body.baseVersion)
    ? Number(body.baseVersion)
    : null;

  if (!data || typeof data !== 'object') {
    return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });
  }

  // ── Sanitiza playlists (apenas track.id numérico)
  if (Array.isArray(data.playlists)) {
    data.playlists = sanitizePlaylists(data.playlists);
  }

  const serialized = JSON.stringify(data);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    return sendJson(res, 413, { ok: false, error: 'Conteúdo muito grande.' });
  }

  try {
    const current = await supabaseAdminRequest(
      `/rest/v1/site_content?key=eq.${CONTENT_KEY}&select=version,data`,
      { method: 'GET' }
    );
    const currentRow = Array.isArray(current.body) ? current.body[0] : null;
    const currentVersion = currentRow?.version || 0;

    if (baseVersion !== null && baseVersion !== currentVersion) {
      return sendJson(res, 409, {
        ok: false,
        error: 'O conteúdo foi alterado por outro administrador.',
        currentVersion
      });
    }

    const newVersion = currentVersion + 1;

    if (currentRow) {
      await supabaseAdminRequest('/rest/v1/site_content_history', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          key: CONTENT_KEY,
          data: currentRow.data,
          version: currentRow.version
        })
      }).catch(() => {});
    }

    const upsert = await supabaseAdminRequest(
      `/rest/v1/site_content?on_conflict=key`,
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          key: CONTENT_KEY,
          data,
          version: newVersion,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!upsert.response.ok) {
      console.error('[admin/content] upsert falhou');
      return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
    }

    await audit('content.update', {
      actor: session.user,
      metadata: { version: newVersion, bytes }
    });

    return sendJson(res, 200, { ok: true, version: newVersion });
  } catch (err) {
    console.error('[admin/content] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

/**
 * Sanitiza o array de playlists.
 * - Aceita apenas `tracks` numéricos positivos
 * - Remove strings legadas
 * - Limita tamanho de campos
 */
function sanitizePlaylists(playlists) {
  if (!Array.isArray(playlists)) return [];

  return playlists
    .map((pl) => {
      if (!pl || typeof pl !== 'object' || Array.isArray(pl)) return null;

      const clean = {
        id: typeof pl.id === 'string'
          ? pl.id.slice(0, 64).replace(/[^\w\-]/g, '')
          : `playlist-${Date.now().toString(36)}`,
        title: typeof pl.title === 'string'
          ? pl.title.slice(0, 120)
          : 'Playlist',
        description: typeof pl.description === 'string'
          ? pl.description.slice(0, 240)
          : '',
        cover: typeof pl.cover === 'string'
          ? pl.cover.slice(0, 3)
          : '♪',
        tracks: []
      };

      if (Array.isArray(pl.tracks)) {
        clean.tracks = pl.tracks
          .map((ref) => {
            if (typeof ref === 'number' && Number.isFinite(ref) && ref > 0) {
              return Math.floor(ref);
            }
            if (typeof ref === 'string') {
              const n = Number(ref.trim());
              if (Number.isFinite(n) && n > 0) return Math.floor(n);
            }
            return null;
          })
          .filter((n) => n !== null);
      }

      return clean;
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// UPLOAD
// ------------------------------------------------------------
// Direciona para o bucket correto conforme `kind`:
//   - 'image'          → site-assets     (público)
//   - 'audio-preview'  → audio-preview   (público)
//   - 'audio-full'     → audio-premium   (privado)
//
// Retorno:
//   - Buckets públicos → { ok, url, path, bucket }
//   - Bucket privado   → { ok, url: null, path, bucket }
//     `path` deve ser gravado em tracks.full_path; a URL é
//     assinada em runtime pelo /api/stream.
// ─────────────────────────────────────────────────────────────
async function handleUpload(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const filename = String(body.filename || '').replace(/[^\w.\-]/g, '_').slice(0, 120);
  const contentType = String(body.contentType || '').trim();
  const base64 = String(body.base64 || '');

  if (!filename || !contentType || !base64) {
    return sendJson(res, 400, { ok: false, error: 'Payload incompleto.' });
  }

  const bucket = BUCKET_BY_KIND[kind];
  if (!bucket) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Tipo inválido. Use "image", "audio-preview" ou "audio-full".'
    });
  }

  const isImage = kind === 'image';
  const isAudio = kind === 'audio-preview' || kind === 'audio-full';

  if (isImage && !ALLOWED_IMAGE_TYPES.has(contentType)) {
    return sendJson(res, 415, { ok: false, error: 'Formato de imagem não suportado.' });
  }
  if (isAudio && !ALLOWED_AUDIO_TYPES.has(contentType)) {
    return sendJson(res, 415, { ok: false, error: 'Formato de áudio não suportado.' });
  }

  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return sendJson(res, 400, { ok: false, error: 'Base64 inválido.' });
  }

  if (isImage && buffer.length > MAX_IMAGE_SIZE) {
    return sendJson(res, 413, { ok: false, error: 'Imagem muito grande (máx 5 MB).' });
  }
  if (isAudio && buffer.length > MAX_AUDIO_SIZE) {
    return sendJson(res, 413, {
      ok: false,
      error: `Áudio muito grande (máx ${Math.round(MAX_AUDIO_SIZE / 1024 / 1024)} MB).`
    });
  }

  // Nome único do arquivo
  const ext = filename.split('.').pop() || (isImage ? 'jpg' : 'mp3');
  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;

  // Imagens ficam em subpasta 'images/'; áudio na raiz do bucket
  const path = isImage ? `images/${uniqueName}` : uniqueName;

  const uploadResult = await supabaseStorageUpload(bucket, path, buffer, contentType);
  if (!uploadResult.ok) {
    return sendJson(res, 502, { ok: false, error: 'Falha no upload.' });
  }

  // URL pública só para buckets públicos
  const isPublicBucket = bucket !== 'audio-premium';
  const publicUrl = isPublicBucket
    ? `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
    : null;

  await audit('upload', {
    actor: session.user,
    target: `${bucket}/${path}`,
    metadata: { size: buffer.length, contentType, bucket }
  });

  return sendJson(res, 200, {
    ok: true,
    url: publicUrl,      // null para áudio full (bucket privado)
    path,                // usar em tracks.preview_path ou tracks.full_path
    bucket
  });
}

async function supabaseStorageUpload(bucket, path, buffer, contentType) {
  const url = `${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': contentType,
        'x-upsert': 'true'
      },
      body: buffer,
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    console.error('[admin/upload] storage fetch:', err.message);
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

// ─────────────────────────────────────────────────────────────
// USERS — GET
// ─────────────────────────────────────────────────────────────
async function handleGetUsers(req, res) {
  const limit = clampLimit(req.query?.limit);

  try {
    const profilesRes = await supabaseAdminRequest(
      `/rest/v1/profiles?select=id,email,name,created_at&order=created_at.desc&limit=${limit}`,
      {
        method: 'GET',
        headers: { Prefer: 'count=exact' }
      }
    );

    if (!profilesRes.response.ok) {
      return sendJson(res, 502, { ok: false, error: 'Falha ao listar usuários.' });
    }

    const profiles = Array.isArray(profilesRes.body) ? profilesRes.body : [];
    const totalFromHeader = parseTotalFromHeaders(profilesRes.response.headers);
    const total = totalFromHeader ?? profiles.length;

    const plansRes = await supabaseAdminRequest(
      `/rest/v1/effective_plan?select=user_id,plan`,
      { method: 'GET' }
    );

    const planMap = new Map();
    if (plansRes.response.ok && Array.isArray(plansRes.body)) {
      for (const row of plansRes.body) planMap.set(row.user_id, row.plan);
    }

    const users = profiles.map((p) => ({
      id: p.id,
      email: p.email || '',
      name: p.name || '',
      plan: planMap.get(p.id) || 'free',
      createdAt: p.created_at
    }));

    return sendJson(res, 200, { ok: true, users, total, limit });
  } catch (err) {
    console.error('[admin/users] GET:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// USERS — PATCH
// ─────────────────────────────────────────────────────────────
async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!isUuid(userId)) {
    return sendJson(res, 400, { ok: false, error: 'userId inválido.' });
  }
  if (!VALID_PLANS.has(plan)) {
    return sendJson(res, 400, { ok: false, error: 'Plano inválido.' });
  }

  try {
    const userCheck = await supabaseAdminRequest(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id,email&limit=1`,
      { method: 'GET' }
    );
    if (!userCheck.response.ok || !Array.isArray(userCheck.body) || !userCheck.body[0]) {
      return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
    }

    const targetUser = userCheck.body[0];

    if (plan === 'free') {
      const cancelRes = await supabaseAdminRequest(
        `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&status=in.(authorized,trialing)`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'canceled',
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }
      );
      if (!cancelRes.response.ok) {
        return sendJson(res, 502, { ok: false, error: 'Falha ao atualizar plano.' });
      }
    } else {
      const manualId = `manual_${userId}_${Date.now()}`;
      const insertRes = await supabaseAdminRequest('/rest/v1/subscriptions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: userId,
          plan,
          status: 'authorized',
          provider: 'manual',
          provider_sub_id: manualId,
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
      });
      if (!insertRes.response.ok) {
        return sendJson(res, 502, { ok: false, error: 'Falha ao atualizar plano.' });
      }

      await supabaseAdminRequest(
        `/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(userId)}&status=in.(authorized,trialing)&provider_sub_id=neq.${encodeURIComponent(manualId)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'canceled',
            canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }
      ).catch(() => {});
    }

    await audit('user.plan.change', {
      actor: session.user,
      target: userId,
      metadata: { plan, email: targetUser.email || null }
    });

    return sendJson(res, 200, { ok: true, plan });
  } catch (err) {
    console.error('[admin/users] PATCH:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// SALES
// ─────────────────────────────────────────────────────────────
async function handleGetSales(req, res) {
  const days = parseDays(req.query?.days);
  const since = days
    ? new Date(Date.now() - days * 86400 * 1000).toISOString()
    : null;

  try {
    const [subsRes, rentalsRes, paymentsRes] = await Promise.all([
      fetchSubscriptions(since),
      fetchRentals(since),
      fetchPayments(since)
    ]);

    const subscriptions = Array.isArray(subsRes) ? subsRes : [];
    const rentals = Array.isArray(rentalsRes) ? rentalsRes : [];
    const payments = Array.isArray(paymentsRes) ? paymentsRes : [];

    return sendJson(res, 200, {
      ok: true,
      period: days ? `${days}d` : 'all',
      limit: SALES_LIMIT,
      subscriptions,
      rentals,
      payments,
      summary: buildSummary(subscriptions, rentals, payments)
    });
  } catch (err) {
    console.error('[admin/sales] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function fetchSubscriptions(since) {
  const filter = since ? `&created_at=gte.${encodeURIComponent(since)}` : '';
  const r = await supabaseAdminRequest(
    `/rest/v1/subscriptions?select=id,user_id,plan,status,current_period_end,created_at${filter}&order=created_at.desc&limit=${SALES_LIMIT}`,
    { method: 'GET' }
  );
  if (!r.response.ok) throw new Error('subscriptions fetch failed');
  return r.body;
}

async function fetchRentals(since) {
  const filter = since ? `&created_at=gte.${encodeURIComponent(since)}` : '';
  const r = await supabaseAdminRequest(
    `/rest/v1/rentals?select=id,user_id,track_id,amount_cents,status,expires_at,created_at${filter}&order=created_at.desc&limit=${SALES_LIMIT}`,
    { method: 'GET' }
  );
  if (!r.response.ok) throw new Error('rentals fetch failed');
  return r.body;
}

async function fetchPayments(since) {
  const filter = since ? `&created_at=gte.${encodeURIComponent(since)}` : '';
  const r = await supabaseAdminRequest(
    `/rest/v1/payments_events?select=id,event_type,external_id,processed_at,failure_reason,created_at${filter}&order=created_at.desc&limit=${SALES_LIMIT}`,
    { method: 'GET' }
  );
  if (!r.response.ok) throw new Error('payments fetch failed');
  return r.body;
}

function buildSummary(subscriptions, rentals, payments) {
  const activeSubs = subscriptions.filter((s) => s.status === 'authorized');
  const totalRentalCents = rentals.reduce(
    (sum, r) => sum + (Number(r.amount_cents) || 0),
    0
  );
  const failedEvents = payments.filter((p) => p.failure_reason);
  const pendingEvents = payments.filter(
    (p) => !p.processed_at && !p.failure_reason
  );

  return {
    subscriptions: {
      total: subscriptions.length,
      active: activeSubs.length,
      byPlan: countBy(subscriptions, 'plan'),
      byStatus: countBy(subscriptions, 'status')
    },
    rentals: {
      total: rentals.length,
      revenueCents: totalRentalCents,
      active: rentals.filter(
        (r) => r.status === 'active' && new Date(r.expires_at) > new Date()
      ).length
    },
    payments: {
      total: payments.length,
      processed: payments.filter((p) => p.processed_at).length,
      failed: failedEvents.length,
      pending: pendingEvents.length
    }
  };
}

function countBy(arr, key) {
  const out = {};
  for (const item of arr) {
    const k = String(item[key] || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// AUDIT — leitura do histórico de eventos
// ------------------------------------------------------------
// GET /api/admin?action=audit&source=admin|auth&limit=100
//
// - source=admin (padrão) → lê de `admin_audit`
//   Colunas: id, action, actor, target, metadata, ip, user_agent, created_at
//
// - source=auth → lê de `auth_audit_log`
//   Colunas: id, event, email_hash, user_id, ip, user_agent, success, reason, created_at
// ─────────────────────────────────────────────────────────────
async function handleGetAudit(req, res) {
  const source = String(req.query?.source || 'admin').toLowerCase();
  const isAdminSource = source !== 'auth';
  const table = isAdminSource ? 'admin_audit' : 'auth_audit_log';
  const limit = clampAuditLimit(req.query?.limit);

  const select = isAdminSource
    ? 'id,action,actor,target,metadata,ip,user_agent,created_at'
    : 'id,event,email_hash,user_id,ip,user_agent,success,reason,created_at';

  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/${table}?select=${select}&order=created_at.desc&limit=${limit}`,
      { method: 'GET' }
    );

    if (!r.response.ok) {
      console.error(`[admin/audit] Supabase erro (${table}):`, r.response.status);
      return sendJson(res, 502, { ok: false, error: 'Falha ao ler auditoria.' });
    }

    return sendJson(res, 200, {
      ok: true,
      source: isAdminSource ? 'admin' : 'auth',
      limit,
      events: Array.isArray(r.body) ? r.body : []
    });
  } catch (err) {
    console.error('[admin/audit] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA — ÁLBUNS
// ─────────────────────────────────────────────────────────────
async function handleListAlbums(req, res) {
  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/albums?select=id,title,artist,year,type,cover_initials,cover_image,description,published,order_index,created_at,updated_at&order=order_index.asc,created_at.asc`,
      { method: 'GET' }
    );

    if (!r.response.ok) {
      console.error('[admin/albums] Supabase erro:', r.response.status);
      return sendJson(res, 502, { ok: false, error: 'Falha ao listar álbuns.' });
    }

    return sendJson(res, 200, {
      ok: true,
      albums: Array.isArray(r.body) ? r.body : []
    });
  } catch (err) {
    console.error('[admin/albums] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleGetAlbum(req, res) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID ausente.' });

  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/albums?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
      { method: 'GET' }
    );
    const row = Array.isArray(r.body) ? r.body[0] : null;
    if (!row) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    return sendJson(res, 200, { ok: true, album: row });
  } catch (err) {
    console.error('[admin/album] GET:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleCreateAlbum(req, res, session) {
  const body = parseBody(req);
  const id = String(body.id || '').trim();
  const title = String(body.title || '').trim();

  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(id)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'ID inválido. Use letras, números e hífens (ex: album-bbb).'
    });
  }
  if (!title) return sendJson(res, 400, { ok: false, error: 'Título obrigatório.' });

  const payload = {
    id,
    title,
    artist: String(body.artist || 'Joseph Matthos').trim(),
    year: Number.isFinite(Number(body.year)) ? Number(body.year) : null,
    type: VALID_ALBUM_TYPES.has(body.type) ? body.type : 'album',
    cover_initials: String(body.cover_initials || '').trim().slice(0, 8),
    cover_image: String(body.cover_image || '').trim(),
    description: String(body.description || '').trim(),
    published: !!body.published,
    order_index: Number.isFinite(Number(body.order_index)) ? Number(body.order_index) : 0,
    updated_at: new Date().toISOString()
  };

  try {
    const r = await supabaseAdminRequest('/rest/v1/albums', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload)
    });

    if (!r.response.ok) {
      const errText = r.response.status === 409
        ? 'Já existe um álbum com este ID.'
        : 'Falha ao criar álbum.';
      console.error('[admin/album] POST:', r.response.status, r.body);
      return sendJson(res, r.response.status === 409 ? 409 : 502, {
        ok: false,
        error: errText
      });
    }

    await audit('album.create', {
      actor: session.user,
      target: id,
      metadata: { title }
    });

    const created = Array.isArray(r.body) ? r.body[0] : null;
    return sendJson(res, 200, { ok: true, album: created });
  } catch (err) {
    console.error('[admin/album] POST erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleUpdateAlbum(req, res, session) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID ausente.' });

  const body = parseBody(req);
  const patch = {};

  if (typeof body.title === 'string')          patch.title = body.title.trim();
  if (typeof body.artist === 'string')         patch.artist = body.artist.trim();
  if (body.year !== undefined)                 patch.year = Number.isFinite(Number(body.year)) ? Number(body.year) : null;
  if (typeof body.type === 'string' && VALID_ALBUM_TYPES.has(body.type)) patch.type = body.type;
  if (typeof body.cover_initials === 'string') patch.cover_initials = body.cover_initials.trim().slice(0, 8);
  if (typeof body.cover_image === 'string')    patch.cover_image = body.cover_image.trim();
  if (typeof body.description === 'string')    patch.description = body.description.trim();
  if (typeof body.published === 'boolean')     patch.published = body.published;
  if (body.order_index !== undefined)          patch.order_index = Number.isFinite(Number(body.order_index)) ? Number(body.order_index) : 0;

  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'Nada para atualizar.' });
  }

  patch.updated_at = new Date().toISOString();

  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/albums?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      }
    );

    if (!r.response.ok) {
      console.error('[admin/album] PATCH:', r.response.status, r.body);
      return sendJson(res, 502, { ok: false, error: 'Falha ao atualizar álbum.' });
    }

    await audit('album.update', {
      actor: session.user,
      target: id,
      metadata: { fields: Object.keys(patch) }
    });

    const updated = Array.isArray(r.body) ? r.body[0] : null;
    return sendJson(res, 200, { ok: true, album: updated });
  } catch (err) {
    console.error('[admin/album] PATCH erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleDeleteAlbum(req, res, session) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID ausente.' });

  try {
    // 1) Verifica se tem faixas
    const tracksRes = await supabaseAdminRequest(
      `/rest/v1/tracks?album_id=eq.${encodeURIComponent(id)}&select=id&limit=1`,
      { method: 'GET' }
    );
    const hasTracks = Array.isArray(tracksRes.body) && tracksRes.body.length > 0;

    const force = String(req.query?.force || '').toLowerCase() === 'true';

    if (hasTracks && !force) {
      return sendJson(res, 409, {
        ok: false,
        error: 'Álbum possui faixas. Exclua as faixas primeiro ou use force=true.'
      });
    }

    // 2) Se force=true, exclui as faixas primeiro
    if (hasTracks && force) {
      await supabaseAdminRequest(
        `/rest/v1/tracks?album_id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
      );
    }

    // 3) Exclui o álbum
    const r = await supabaseAdminRequest(
      `/rest/v1/albums?id=eq.${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    );

    if (!r.response.ok) {
      console.error('[admin/album] DELETE:', r.response.status, r.body);
      return sendJson(res, 502, { ok: false, error: 'Falha ao excluir álbum.' });
    }

    await audit('album.delete', {
      actor: session.user,
      target: id,
      metadata: { forced: force, tracksDeleted: hasTracks }
    });

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[admin/album] DELETE erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA — FAIXAS
// ─────────────────────────────────────────────────────────────
async function handleListTracks(req, res) {
  const albumId = String(req.query?.albumId || '').trim();
  if (!albumId) return sendJson(res, 400, { ok: false, error: 'albumId ausente.' });

  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/tracks?album_id=eq.${encodeURIComponent(albumId)}&select=id,album_id,track_index,title,duration,preview_start,preview_duration,price_cents,for_sale,lyrics,published,preview_path,full_path,created_at,updated_at&order=track_index.asc`,
      { method: 'GET' }
    );

    if (!r.response.ok) {
      console.error('[admin/tracks] Supabase erro:', r.response.status);
      return sendJson(res, 502, { ok: false, error: 'Falha ao listar faixas.' });
    }

    return sendJson(res, 200, {
      ok: true,
      tracks: Array.isArray(r.body) ? r.body : []
    });
  } catch (err) {
    console.error('[admin/tracks] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleCreateTrack(req, res, session) {
  const body = parseBody(req);
  const albumId = String(body.album_id || '').trim();
  const title = String(body.title || '').trim();

  if (!albumId) return sendJson(res, 400, { ok: false, error: 'album_id obrigatório.' });
  if (!title) return sendJson(res, 400, { ok: false, error: 'Título obrigatório.' });

  // Calcula próximo track_index (maior + 1)
  let nextIndex = 0;
  try {
    const maxRes = await supabaseAdminRequest(
      `/rest/v1/tracks?album_id=eq.${encodeURIComponent(albumId)}&select=track_index&order=track_index.desc&limit=1`,
      { method: 'GET' }
    );
    const maxRow = Array.isArray(maxRes.body) ? maxRes.body[0] : null;
    nextIndex = maxRow ? Number(maxRow.track_index) + 1 : 0;
  } catch {
    nextIndex = 0;
  }

  const payload = {
    album_id: albumId,
    track_index: nextIndex,
    title,
    duration: String(body.duration || '—').trim(),
    preview_start: Number.isFinite(Number(body.preview_start)) ? Number(body.preview_start) : 0,
    preview_duration: Number.isFinite(Number(body.preview_duration)) ? Number(body.preview_duration) : 30,
    price_cents: Number.isFinite(Number(body.price_cents)) ? Number(body.price_cents) : 499,
    for_sale: body.for_sale !== false,
    lyrics: Array.isArray(body.lyrics) ? body.lyrics : [],
    published: !!body.published,
    preview_path: String(body.preview_path || '').trim() || null,
    full_path: String(body.full_path || '').trim() || null,
    updated_at: new Date().toISOString()
  };

  try {
    const r = await supabaseAdminRequest('/rest/v1/tracks', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload)
    });

    if (!r.response.ok) {
      console.error('[admin/track] POST:', r.response.status, r.body);
      return sendJson(res, 502, { ok: false, error: 'Falha ao criar faixa.' });
    }

    await audit('track.create', {
      actor: session.user,
      target: `${albumId}:${nextIndex}`,
      metadata: { title }
    });

    const created = Array.isArray(r.body) ? r.body[0] : null;
    return sendJson(res, 200, { ok: true, track: created });
  } catch (err) {
    console.error('[admin/track] POST erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleUpdateTrack(req, res, session) {
  const id = Number(req.query?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return sendJson(res, 400, { ok: false, error: 'ID inválido.' });
  }

  const body = parseBody(req);
  const patch = {};

  if (typeof body.title === 'string')           patch.title = body.title.trim();
  if (typeof body.duration === 'string')        patch.duration = body.duration.trim();
  if (body.preview_start !== undefined)         patch.preview_start = Number(body.preview_start) || 0;
  if (body.preview_duration !== undefined)      patch.preview_duration = Number(body.preview_duration) || 30;
  if (body.price_cents !== undefined)           patch.price_cents = Number.isFinite(Number(body.price_cents)) ? Number(body.price_cents) : 0;
  if (typeof body.for_sale === 'boolean')       patch.for_sale = body.for_sale;
  if (Array.isArray(body.lyrics))               patch.lyrics = body.lyrics;
  if (typeof body.published === 'boolean')      patch.published = body.published;
  if (typeof body.preview_path === 'string')    patch.preview_path = body.preview_path.trim() || null;
  if (typeof body.full_path === 'string')       patch.full_path = body.full_path.trim() || null;
  if (body.track_index !== undefined)           patch.track_index = Number(body.track_index) || 0;

  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'Nada para atualizar.' });
  }

  patch.updated_at = new Date().toISOString();

  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/tracks?id=eq.${id}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patch)
      }
    );

    if (!r.response.ok) {
      console.error('[admin/track] PATCH:', r.response.status, r.body);
      return sendJson(res, 502, { ok: false, error: 'Falha ao atualizar faixa.' });
    }

    await audit('track.update', {
      actor: session.user,
      target: String(id),
      metadata: { fields: Object.keys(patch) }
    });

    const updated = Array.isArray(r.body) ? r.body[0] : null;
    return sendJson(res, 200, { ok: true, track: updated });
  } catch (err) {
    console.error('[admin/track] PATCH erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleDeleteTrack(req, res, session) {
  const id = Number(req.query?.id);
  if (!Number.isFinite(id) || id <= 0) {
    return sendJson(res, 400, { ok: false, error: 'ID inválido.' });
  }

  try {
    const r = await supabaseAdminRequest(
      `/rest/v1/tracks?id=eq.${id}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } }
    );

    if (!r.response.ok) {
      console.error('[admin/track] DELETE:', r.response.status, r.body);
      return sendJson(res, 502, { ok: false, error: 'Falha ao excluir faixa.' });
    }

    await audit('track.delete', {
      actor: session.user,
      target: String(id)
    });

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[admin/track] DELETE erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleReorderTracks(req, res, session) {
  const body = parseBody(req);
  const order = body.order;

  if (!Array.isArray(order) || !order.length) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Payload deve ser { order: [{id, track_index}, ...] }.'
    });
  }

  try {
    // Aplica em paralelo
    const results = await Promise.all(order.map((item) =>
      supabaseAdminRequest(
        `/rest/v1/tracks?id=eq.${Number(item.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            track_index: Number(item.track_index) || 0,
            updated_at: new Date().toISOString()
          })
        }
      )
    ));

    const failed = results.filter((r) => !r.response.ok);
    if (failed.length) {
      console.error('[admin/track-order] algumas falharam:', failed.length);
      return sendJson(res, 502, {
        ok: false,
        error: `${failed.length} faixa(s) não puderam ser reordenadas.`
      });
    }

    await audit('track.reorder', {
      actor: session.user,
      metadata: { count: order.length }
    });

    return sendJson(res, 200, { ok: true, count: order.length });
  } catch (err) {
    console.error('[admin/track-order] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// SESSÃO
// ─────────────────────────────────────────────────────────────
function verifySession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;

  let secret;
  try {
    secret = getSessionSecret();
  } catch {
    return null;
  }

  return verifyHmac(token, secret, SESSION_MAX_AGE * 1000);
}

// ─────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────
function parseAction(query) {
  if (!query) return null;
  const raw = String(query.action || '').trim().toLowerCase();
  if (!raw) return null;
  return VALID_ACTIONS.has(raw) ? raw : null;
}

function clampLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function clampAuditLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return AUDIT_LIMIT;
  return Math.min(Math.floor(n), AUDIT_MAX_LIMIT);
}

function parseDays(raw) {
  if (raw === 'all' || raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return [7, 30, 90, 365].includes(n) ? n : null;
}

function parseTotalFromHeaders(headers) {
  const cr = headers && (headers['content-range'] || headers['Content-Range']);
  if (!cr) return null;
  const m = String(cr).match(/\/(\d+|\*)$/);
  if (!m || m[1] === '*') return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────
// GEN-HASH — TEMPORÁRIO
// ------------------------------------------------------------
// Gera um hash scrypt de uma senha. Requer sessão de admin.
//
// GET /api/admin?action=gen-hash&password=XXXX
//
// ⚠️ REMOVER ESTA FUNÇÃO após gerar o hash novo.
// ─────────────────────────────────────────────────────────────
async function handleGenHash(req, res, session) {
  const password = String(req.query?.password || '');

  if (!password || password.length < 12) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Senha deve ter pelo menos 12 caracteres.'
    });
  }

  try {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    const encoded = 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex');

    await audit('admin_gen_hash', {
      actor: session.user,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] || '',
      success: true
    });

    return sendJson(res, 200, { ok: true, hash: encoded });
  } catch (err) {
    console.error('[admin/gen-hash]', err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro ao gerar hash.' });
  }
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
