/* ============================================================
   api/admin.js — Painel administrativo
   ------------------------------------------------------------
   POST   /api/admin?action=login        → login admin
   GET    /api/admin?action=session      → valida sessão
   POST   /api/admin?action=logout       → encerra sessão
   GET    /api/admin?action=content      → lê conteúdo
   PUT    /api/admin?action=content      → salva conteúdo

   ── Upload ───────────────────────────────────────────────────
   POST   /api/admin?action=upload        → upload Base64 (imagens)
   POST   /api/admin?action=upload-sign   → gera URL assinada de PUT
   POST   /api/admin?action=upload-confirm → confirma upload e
                                             grava path no banco

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

   ── Downloads (admin) ────────────────────────────────────────
   GET    /api/admin?action=download-url&id=TRACK_ID
          → URL assinada para baixar uma faixa (áudio completo)
   GET    /api/admin?action=download-album&id=ALBUM_ID
          → URLs assinadas para todas as faixas do álbum

   - Sessão via cookie __Host-jm_admin (HttpOnly + HMAC assinado)
   - ADMIN_SESSION_SECRET exige mínimo de 32 caracteres
   - CSRF: Origin check em todos os métodos mutantes
   - Rate limit por IP no login (fail-closed: bloqueia se KV cair)
   - Auditoria em toda escrita
   - Upload roteia para o bucket correto:
       image         → site-assets     (público, Base64)
       audio-preview → audio-preview   (público, presigned)
       audio-full    → audio-premium   (privado, presigned)
   - Playlists: sanitizadas para aceitar apenas track.id (integer)
   - Ao mudar plano para "free", assinaturas no MP são canceladas
   - Downloads: URLs assinadas de 1h com Content-Disposition: attachment
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
// Drizzle + Neon (usado em discografia)
// ─────────────────────────────────────────────────────────────
const { db } = require('./_db');
const schema = require('../src/schema.js');
const { tracks, albums, artists } = schema;
const { eq, and, asc, desc, sql, inArray } = require('drizzle-orm');


// ─────────────────────────────────────────────────────────────
// Storage — Backblaze B2 (substitui Supabase Storage)
// ─────────────────────────────────────────────────────────────
const {
  uploadObject,
  createSignedUploadUrl: b2CreateSignedUploadUrl,
  createSignedDownloadUrl: b2CreateSignedDownloadUrl,
  getPublicUrl: b2GetPublicUrl,
  objectExists: b2ObjectExists,
  getBucketForKind: b2GetBucketForKind
} = require('./_storage');

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

// ── Upload — limites e buckets
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;              // 5 MB
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;            // 200 MB (presigned)
const MAX_AUDIO_SIZE_LEGACY = 4 * 1024 * 1024;       // 4 MB (Base64 legado)
const UPLOAD_TIMEOUT_MS = 180_000;                   // 3 min
const SIGNED_UPLOAD_TTL_SEC = 900;                   // 15 min para concluir o PUT

// ── Download — TTL da URL assinada de download (admin)
const DOWNLOAD_TTL_SEC = 3600;                       // 1 hora

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']);

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
  'upload-sign',
  'upload-confirm',
  'users',
  'sales',
  'audit',
  'gen-hash',
  // Discografia
  'albums',
  'album',
  'tracks',
  'track',
  'track-order',
  // Downloads
  'download-url',
  'download-album'
]);

const VALID_ALBUM_TYPES = new Set(['album', 'ep', 'single']);

// ⚠️ DEV ONLY: bypass do rate limit (só ativa com DISABLE_RATE_LIMIT=true e fora de produção)
const DEV_NO_RATE_LIMIT =
  process.env.NODE_ENV !== 'production' &&
  process.env.DISABLE_RATE_LIMIT === 'true';

// ⚠️ DEV ONLY: bypass do CSRF (só ativa com DISABLE_CSRF=true e fora de produção)
const DEV_NO_CSRF =
  process.env.NODE_ENV !== 'production' &&
  process.env.DISABLE_CSRF === 'true';

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

  // ── CSRF: Origin check em métodos mutantes (bypass em dev via DEV_NO_CSRF)
  if (method !== 'GET' && method !== 'HEAD' && !DEV_NO_CSRF) {
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

    // ── Upload — 3 modos
    case 'upload':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleUpload(req, res, session);

    case 'upload-sign':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleUploadSign(req, res, session);

    case 'upload-confirm':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleUploadConfirm(req, res, session);

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

    // ── Downloads (admin)
    case 'download-url':
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleDownloadUrl(req, res, session);

    case 'download-album':
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return handleDownloadAlbum(req, res, session);

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

  const rate = DEV_NO_RATE_LIMIT
    ? { limited: false, retryAfter: 0 }
    : await checkAndIncrement(
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

  if (!DEV_NO_RATE_LIMIT) {
    await resetBucket(`admin-login:${ip}`);
  }

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
    const [row] = await db
      .select()
      .from(schema.siteContent)
      .where(eq(schema.siteContent.key, CONTENT_KEY))
      .limit(1);

    return sendJson(res, 200, {
      ok: true,
      data: row?.data && typeof row.data === 'object' ? row.data : {},
      version: Number(row?.version) || 0,
      updatedAt: row?.updatedAt || null
    });
  } catch (err) {
    console.error('[admin/content] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// CONTENT — PUT
// ─────────────────────────────────────────────────────────────
async function handlePutContent(req, res, session) {
  const body = parseBody(req);
  const data = body.data;
  const baseVersion = Number.isFinite(body.baseVersion)
    ? Number(body.baseVersion)
    : null;

  if (!data || typeof data !== 'object') {
    return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });
  }

  if (Array.isArray(data.playlists)) {
    data.playlists = sanitizePlaylists(data.playlists);
  }

  const serialized = JSON.stringify(data);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    return sendJson(res, 413, { ok: false, error: 'Conteúdo muito grande.' });
  }

  try {
    const [currentRow] = await db
      .select()
      .from(schema.siteContent)
      .where(eq(schema.siteContent.key, CONTENT_KEY))
      .limit(1);

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
      await db.insert(schema.siteContentHistory).values({
        key: CONTENT_KEY,
        data: currentRow.data,
        version: currentRow.version
      }).catch(() => {});
    }

    await db
      .insert(schema.siteContent)
      .values({
        key: CONTENT_KEY,
        data,
        version: newVersion,
        updatedAt: new Date().toISOString()
      })
      .onConflictDoUpdate({
        target: schema.siteContent.key,
        set: { data, version: newVersion, updatedAt: new Date().toISOString() }
      });

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
// UPLOAD — Base64
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

  const maxBytes = isImage ? MAX_IMAGE_SIZE : MAX_AUDIO_SIZE_LEGACY;

  if (buffer.length > maxBytes) {
    const maxMb = Math.round(maxBytes / 1024 / 1024);
    return sendJson(res, 413, {
      ok: false,
      error: isImage
        ? `Imagem muito grande (máx ${maxMb} MB).`
        : `Áudio muito grande para upload Base64 (máx ${maxMb} MB). Use upload-sign.`,
      code: 'FILE_TOO_LARGE',
      hint: isAudio ? 'Use action=upload-sign (presigned URL)' : null,
      maxBytes
    });
  }

  const ext = filename.split('.').pop() || (isImage ? 'jpg' : 'mp3');
  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const path = isImage ? `images/${uniqueName}` : uniqueName;

  let uploadResult;
  try {
    await uploadObject(bucket, path, buffer, contentType);
    uploadResult = { ok: true, status: 200 };
  } catch (err) {
    console.error('[admin/upload] B2 falhou:', err.message);
    uploadResult = { ok: false, status: 0, error: err.message };
  }

  if (!uploadResult.ok) {
    console.error('[admin/upload] Storage falhou:', {
      bucket,
      path,
      contentType,
      size: buffer.length,
      status: uploadResult.status,
      error: uploadResult.error
    });

    return sendJson(res, 502, {
      ok: false,
      error: 'Falha no upload para o Storage.',
      code: 'STORAGE_UPLOAD_FAILED',
      status: uploadResult.status
    });
  }

  const isPublicBucket = bucket !== 'audio-premium';
  const publicUrl = isPublicBucket ? b2GetPublicUrl(bucket, path) : null;

  await audit('upload', {
    actor: session.user,
    target: `${bucket}/${path}`,
    metadata: { size: buffer.length, contentType, bucket }
  });

  return sendJson(res, 200, {
    ok: true,
    url: publicUrl,
    path,
    bucket
  });
}

// ─────────────────────────────────────────────────────────────
// UPLOAD SIGN
// ─────────────────────────────────────────────────────────────
async function handleUploadSign(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const filename = String(body.filename || '').replace(/[^\w.\-]/g, '_').slice(0, 120);
  const contentType = String(body.contentType || '').trim();
  const size = Number(body.size);

  const bucket = BUCKET_BY_KIND[kind];
  if (!bucket) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Tipo inválido.',
      code: 'INVALID_KIND'
    });
  }

  if (!filename || !contentType || !Number.isFinite(size) || size <= 0) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Payload incompleto.',
      code: 'INVALID_PAYLOAD'
    });
  }

  const isImage = kind === 'image';
  const isAudio = kind === 'audio-preview' || kind === 'audio-full';

  if (isImage && !ALLOWED_IMAGE_TYPES.has(contentType)) {
    return sendJson(res, 415, {
      ok: false,
      error: 'Formato de imagem não suportado.',
      code: 'INVALID_MIME'
    });
  }
  if (isAudio && !ALLOWED_AUDIO_TYPES.has(contentType)) {
    return sendJson(res, 415, {
      ok: false,
      error: 'Formato de áudio não suportado.',
      code: 'INVALID_MIME'
    });
  }

  const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_AUDIO_SIZE;
  if (size > maxSize) {
    const maxMb = Math.round(maxSize / 1024 / 1024);
    return sendJson(res, 413, {
      ok: false,
      error: `Arquivo muito grande (máx ${maxMb} MB).`,
      code: 'FILE_TOO_LARGE',
      maxBytes: maxSize
    });
  }

  const ext = filename.split('.').pop() || (isImage ? 'jpg' : 'mp3');
  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${ext}`;
  const path = isImage ? `images/${uniqueName}` : uniqueName;

  const signed = await createSignedUploadUrl(bucket, path, SIGNED_UPLOAD_TTL_SEC);

  if (!signed.ok) {
    console.error('[admin/upload-sign] falha ao gerar signed URL:', signed.error);
    return sendJson(res, 502, {
      ok: false,
      error: 'Falha ao preparar upload.',
      code: 'SIGN_FAILED'
    });
  }

  await audit('upload.sign', {
    actor: session.user,
    target: `${bucket}/${path}`,
    metadata: { size, contentType, bucket }
  });

  return sendJson(res, 200, {
    ok: true,
    uploadUrl: signed.uploadUrl,
    token: signed.token,
    path,
    bucket,
    expiresIn: SIGNED_UPLOAD_TTL_SEC
  });
}

// ─────────────────────────────────────────────────────────────
// UPLOAD CONFIRM
// ─────────────────────────────────────────────────────────────
async function handleUploadConfirm(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const path = String(body.path || '').trim();
  const albumId = body.albumId ? String(body.albumId).trim() : null;
  const trackIndex = Number.isInteger(Number(body.trackIndex))
    ? Number(body.trackIndex)
    : null;

  const bucket = BUCKET_BY_KIND[kind];
  if (!bucket) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Tipo inválido.',
      code: 'INVALID_KIND'
    });
  }

  if (!path) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Path ausente.',
      code: 'INVALID_PAYLOAD'
    });
  }

  const exists = await objectExists(bucket, path);
  if (!exists) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Arquivo não encontrado no Storage.',
      code: 'FILE_NOT_FOUND'
    });
  }

  if (albumId && trackIndex !== null) {
    const field = kind === 'audio-full'
      ? 'full_path'
      : kind === 'audio-preview'
      ? 'preview_path'
      : null;

    if (!field) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Só áudio pode ser associado a faixas.',
        code: 'INVALID_KIND'
      });
    }

    const isFull = kind === 'audio-full';
    const patch = isFull
      ? { fullPath: path, streamKey: path, updatedAt: new Date().toISOString() }
      : { previewPath: path, previewKey: path, updatedAt: new Date().toISOString() };

    const updated = await db
      .update(tracks)
      .set(patch)
      .where(and(eq(tracks.albumId, albumId), eq(tracks.trackNumber, trackIndex)))
      .returning();

    if (!updated.length) {
      return sendJson(res, 502, {
        ok: false,
        error: 'Faixa não encontrada.',
        code: 'TRACK_NOT_FOUND'
      });
    }

    await audit('upload.confirm', {
      actor: session.user,
      target: `${albumId}:${trackIndex}`,
      metadata: { bucket, path, field }
    });

    const updatedTrack = updated[0];

    const isPublic = bucket !== 'audio-premium';
    const publicUrl = isPublic ? b2GetPublicUrl(bucket, path) : null;

    return sendJson(res, 200, {
      ok: true,
      path,
      bucket,
      url: publicUrl,
      albumId,
      trackIndex,
      field,
      track: updatedTrack
    });
  }

  const isPublic = bucket !== 'audio-premium';
  const publicUrl = isPublic ? b2GetPublicUrl(bucket, path) : null;

  await audit('upload.confirm', {
    actor: session.user,
    target: `${bucket}/${path}`,
    metadata: { bucket, standalone: true }
  });

  return sendJson(res, 200, {
    ok: true,
    path,
    bucket,
    url: publicUrl,
    standalone: true
  });
}

// ─────────────────────────────────────────────────────────────
// Storage — helpers
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// USERS — GET
// ─────────────────────────────────────────────────────────────
async function handleGetUsers(req, res) {
  const limit = clampLimit(req.query?.limit);

  try {
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        createdAt: schema.users.createdAt
      })
      .from(schema.users)
      .orderBy(desc(schema.users.createdAt))
      .limit(limit);

    const planRows = await db.execute(sql`
      SELECT user_id, plan FROM effective_plan
    `);
    const planMap = new Map(
      (planRows.rows || planRows).map((r) => [r.user_id, r.plan])
    );

    const users = rows.map((u) => ({
      id: u.id,
      email: u.email || '',
      name: u.name || '',
      plan: planMap.get(u.id) || 'free',
      createdAt: u.createdAt
    }));

    return sendJson(res, 200, { ok: true, users, total: users.length, limit });
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
    const [targetUser] = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!targetUser) {
      return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
    }

    if (plan === 'free') {
      const activeSubs = await db
        .select({
          id: schema.subscriptions.id,
          externalSubscriptionId: schema.subscriptions.externalSubscriptionId,
          status: schema.subscriptions.status
        })
        .from(schema.subscriptions)
        .where(and(
          eq(schema.subscriptions.userId, userId),
          inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING'])
        ));

      const mpToken = String(process.env.MP_ACCESS_TOKEN || '').trim();
      let mpCancelledCount = 0;

      if (mpToken && activeSubs.length) {
        for (const sub of activeSubs) {
          if (sub.provider !== 'mercadopago' || !sub.provider_sub_id) continue;

          try {
            const r = await fetch(
              `https://api.mercadopago.com/preapproval/${encodeURIComponent(sub.provider_sub_id)}`,
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${mpToken}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({ status: 'cancelled' })
              }
            );

            if (!r.ok) {
              const text = await r.text().catch(() => '');
              console.warn(
                '[admin/users] MP cancel failed:',
                sub.provider_sub_id,
                r.status,
                text.slice(0, 200)
              );
            } else {
              console.log('[admin/users] MP cancel OK:', sub.provider_sub_id);
              mpCancelledCount++;
            }
          } catch (err) {
            console.error('[admin/users] MP cancel error:', err.message);
          }
        }
      }

      await db
        .update(schema.subscriptions)
        .set({
          status: 'CANCELLED',
          cancelAtPeriodEnd: true,
          updatedAt: new Date().toISOString()
        })
        .where(and(
          eq(schema.subscriptions.userId, userId),
          inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING'])
        ));

      await audit('user.plan.change', {
        actor: session.user,
        target: userId,
        metadata: {
          plan,
          email: targetUser.email || null,
          mpCancelledCount,
          activeSubs: activeSubs.length
        }
      });

      return sendJson(res, 200, { ok: true, plan });
    }

    const [planRow] = await db
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(eq(schema.plans.name, plan))
      .limit(1);

    if (!planRow) {
      return sendJson(res, 400, { ok: false, error: 'Plano não encontrado.' });
    }

    const manualId = `manual_${userId}_${Date.now()}`;

    await db.insert(schema.subscriptions).values({
      id: crypto.randomUUID(),
      userId,
      planId: planRow.id,
      externalSubscriptionId: manualId,
      status: 'ACTIVE',
      currentPeriodStart: new Date().toISOString(),
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await db
      .update(schema.subscriptions)
      .set({
        status: 'CANCELLED',
        cancelAtPeriodEnd: true,
        updatedAt: new Date().toISOString()
      })
      .where(and(
        eq(schema.subscriptions.userId, userId),
        inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING']),
        sql`${schema.subscriptions.externalSubscriptionId} IS DISTINCT FROM ${manualId}`
      )).catch(() => {});

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
  const base = db.select({
    id: schema.subscriptions.id,
    user_id: schema.subscriptions.userId,
    plan: sql`(SELECT name FROM plans WHERE id = ${schema.subscriptions.planId})`,
    status: schema.subscriptions.status,
    current_period_end: schema.subscriptions.currentPeriodEnd,
    created_at: schema.subscriptions.createdAt
  }).from(schema.subscriptions);

  if (since) {
    return base.where(sql`${schema.subscriptions.createdAt} >= ${since}`).orderBy(desc(schema.subscriptions.createdAt)).limit(SALES_LIMIT);
  }
  return base.orderBy(desc(schema.subscriptions.createdAt)).limit(SALES_LIMIT);
}

async function fetchRentals(since) {
  const base = db.select({
    id: schema.rentals.id,
    user_id: schema.rentals.userId,
    track_id: schema.rentals.trackId,
    amount_cents: sql`0`,
    status: schema.rentals.status,
    expires_at: schema.rentals.expiresAt,
    created_at: schema.rentals.createdAt
  }).from(schema.rentals);

  if (since) {
    return base.where(sql`${schema.rentals.createdAt} >= ${since}`).orderBy(desc(schema.rentals.createdAt)).limit(SALES_LIMIT);
  }
  return base.orderBy(desc(schema.rentals.createdAt)).limit(SALES_LIMIT);
}

async function fetchPayments(since) {
  const base = db.select({
    id: schema.paymentsEvents.id,
    event_type: schema.paymentsEvents.eventType,
    external_id: schema.paymentsEvents.externalId,
    processed_at: schema.paymentsEvents.processedAt,
    failure_reason: schema.paymentsEvents.failureReason,
    created_at: schema.paymentsEvents.createdAt
  }).from(schema.paymentsEvents);

  if (since) {
    return base.where(sql`${schema.paymentsEvents.createdAt} >= ${since}`).orderBy(desc(schema.paymentsEvents.createdAt)).limit(SALES_LIMIT);
  }
  return base.orderBy(desc(schema.paymentsEvents.createdAt)).limit(SALES_LIMIT);
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
// AUDIT
// ─────────────────────────────────────────────────────────────
async function handleGetAudit(req, res) {
  const source = String(req.query?.source || 'admin').toLowerCase();
  const isAdminSource = source !== 'auth';
  const limit = clampAuditLimit(req.query?.limit);

  try {
    let events;
    if (isAdminSource) {
      events = await db
        .select()
        .from(schema.adminAudit)
        .orderBy(desc(schema.adminAudit.createdAt))
        .limit(limit);
    } else {
      events = await db
        .select()
        .from(schema.authAuditLog)
        .orderBy(desc(schema.authAuditLog.createdAt))
        .limit(limit);
    }

    return sendJson(res, 200, {
      ok: true,
      source: isAdminSource ? 'admin' : 'auth',
      limit,
      events
    });
  } catch (err) {
    console.error('[admin/audit] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA — ÁLBUNS (Drizzle/Neon)
// ─────────────────────────────────────────────────────────────
function mapAlbumRow(a) {
  if (!a) return null;
  return {
    id: a.id,
    title: a.title,
    slug: a.slug,
    artist: a.artist || a.artistName || 'Joseph Matthos',
    artist_id: a.artistId,
    cover_image: a.coverUrl,
    cover_url: a.coverUrl,
    cover_initials: a.coverInitials || (a.title ? a.title.charAt(0).toUpperCase() : '♪'),
    year: a.year,
    type: a.type || 'album',
    description: a.description || '',
    published: a.published === true,
    order_index: a.orderIndex ?? a.sortOrder ?? 0,
    release_date: a.releaseDate,
    sort_order: a.sortOrder,
    upc: a.upc,
    created_at: a.createdAt,
    updated_at: a.updatedAt
  };
}

const albumSelectFields = {
  id: albums.id,
  title: albums.title,
  slug: albums.slug,
  artist: albums.artist,
  artistId: albums.artistId,
  artistName: artists.name,
  coverUrl: albums.coverUrl,
  coverInitials: albums.coverInitials,
  year: albums.year,
  type: albums.type,
  description: albums.description,
  published: albums.published,
  orderIndex: albums.orderIndex,
  releaseDate: albums.releaseDate,
  sortOrder: albums.sortOrder,
  upc: albums.upc,
  createdAt: albums.createdAt,
  updatedAt: albums.updatedAt
};

async function handleListAlbums(req, res) {
  try {
    const rows = await db.select(albumSelectFields)
      .from(albums)
      .leftJoin(artists, eq(albums.artistId, artists.id))
      .orderBy(asc(albums.sortOrder), asc(albums.createdAt));

    const mapped = rows.map(mapAlbumRow);
    return sendJson(res, 200, { ok: true, albums: mapped });
  } catch (err) {
    console.error('[admin/albums] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleGetAlbum(req, res) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID ausente.' });

  try {
    const rows = await db.select(albumSelectFields)
      .from(albums)
      .leftJoin(artists, eq(albums.artistId, artists.id))
      .where(eq(albums.id, id))
      .limit(1);

    if (!rows.length) {
      return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    }

    return sendJson(res, 200, { ok: true, album: mapAlbumRow(rows[0]) });
  } catch (err) {
    console.error('[admin/album] GET:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleCreateAlbum(req, res, session) {
  const body = parseBody(req);
  const title = String(body.title || '').trim();
  if (!title) return sendJson(res, 400, { ok: false, error: 'Título obrigatório.' });

  const id = String(body.id || crypto.randomUUID());

  let slug = String(body.slug || title)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || `album-${Date.now()}`;

  try {
    const existing = await db.select({ slug: albums.slug })
      .from(albums).where(eq(albums.slug, slug)).limit(1);
    if (existing.length) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  } catch {}

  const [firstArtist] = await db.select({ id: artists.id }).from(artists).limit(1);
  const artistId = body.artist_id || firstArtist?.id;
  if (!artistId) {
    return sendJson(res, 400, { ok: false, error: 'Nenhum artista cadastrado.' });
  }

  const payload = {
    id,
    title,
    slug,
    artistId,
    artist: String(body.artist || 'Joseph Matthos').trim(),
    year: Number.isFinite(Number(body.year)) ? Number(body.year) : null,
    type: VALID_ALBUM_TYPES.has(body.type) ? body.type : 'album',
    coverInitials: String(body.cover_initials || title.charAt(0)).trim().slice(0, 8),
    coverUrl: String(body.cover_image || body.cover_url || '').trim() || null,
    description: String(body.description || '').trim(),
    published: !!body.published,
    orderIndex: Number.isFinite(Number(body.order_index)) ? Number(body.order_index) : 0,
    releaseDate: body.release_date || null,
    upc: body.upc || null
  };

  try {
    const [created] = await db.insert(albums).values(payload).returning();

    await audit('album.create', {
      actor: session.user,
      target: id,
      metadata: { title }
    });

    return sendJson(res, 200, { ok: true, album: mapAlbumRow(created) });
  } catch (err) {
    console.error('[admin/album] POST erro:', err.message);
    if (String(err.message).includes('duplicate')) {
      return sendJson(res, 409, { ok: false, error: 'Já existe um álbum com este slug/id.' });
    }
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleUpdateAlbum(req, res, session) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID ausente.' });

  const body = parseBody(req);
  const patch = {};

  if (typeof body.title === 'string')           patch.title = body.title.trim();
  if (typeof body.slug === 'string')            patch.slug = body.slug.trim();
  if (typeof body.artist === 'string')          patch.artist = body.artist.trim();
  if (typeof body.type === 'string' && VALID_ALBUM_TYPES.has(body.type)) patch.type = body.type;
  if (typeof body.cover_initials === 'string')  patch.coverInitials = body.cover_initials.trim().slice(0, 8);
  if (typeof body.cover_image === 'string')     patch.coverUrl = body.cover_image.trim() || null;
  if (typeof body.cover_url === 'string')       patch.coverUrl = body.cover_url.trim() || null;
  if (typeof body.description === 'string')     patch.description = body.description.trim();
  if (typeof body.published === 'boolean')      patch.published = body.published;
  if (body.year !== undefined)                  patch.year = Number.isFinite(Number(body.year)) ? Number(body.year) : null;
  if (body.order_index !== undefined)           patch.orderIndex = Number.isFinite(Number(body.order_index)) ? Number(body.order_index) : 0;
  if (typeof body.release_date === 'string')    patch.releaseDate = body.release_date.trim() || null;

  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'Nada para atualizar.' });
  }

  try {
    const rows = await db.update(albums)
      .set(patch)
      .where(eq(albums.id, id))
      .returning();

    if (!rows.length) {
      return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    }

    await audit('album.update', {
      actor: session.user,
      target: id,
      metadata: { fields: Object.keys(patch) }
    });

    return sendJson(res, 200, { ok: true, album: mapAlbumRow(rows[0]) });
  } catch (err) {
    console.error('[admin/album] PATCH erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleDeleteAlbum(req, res, session) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID ausente.' });

  try {
    const [existing] = await db.select({ id: tracks.id })
      .from(tracks).where(eq(tracks.albumId, id)).limit(1);
    const hasTracks = !!existing;

    const force = String(req.query?.force || '').toLowerCase() === 'true';

    if (hasTracks && !force) {
      return sendJson(res, 409, {
        ok: false,
        error: 'Álbum possui faixas. Exclua as faixas primeiro ou use force=true.'
      });
    }

    if (hasTracks && force) {
      await db.delete(tracks).where(eq(tracks.albumId, id));
    }

    const deleted = await db.delete(albums).where(eq(albums.id, id)).returning();

    if (!deleted.length) {
      return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
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
// DISCOGRAFIA — FAIXAS (Drizzle/Neon)
// ─────────────────────────────────────────────────────────────
function mapTrackRow(t) {
  if (!t) return null;
  return {
    id: t.id,
    album_id: t.albumId,
    track_index: t.trackNumber ?? 0,
    track_number: t.trackNumber ?? 0,
    title: t.title,
    slug: t.slug,
    duration: t.durationSeconds ? String(t.durationSeconds) : '—',
    duration_seconds: t.durationSeconds,
    status: t.status,
    published: t.status === 'PUBLISHED',
    preview_path: t.previewPath,
    full_path: t.fullPath,
    preview_key: t.previewKey,
    stream_key: t.streamKey,
    master_key: t.masterKey,
    created_at: t.createdAt,
    updated_at: t.updatedAt
  };
}

const trackSelectFields = {
  id: tracks.id,
  albumId: tracks.albumId,
  artistId: tracks.artistId,
  title: tracks.title,
  slug: tracks.slug,
  durationSeconds: tracks.durationSeconds,
  status: tracks.status,
  previewKey: tracks.previewKey,
  streamKey: tracks.streamKey,
  masterKey: tracks.masterKey,
  trackNumber: tracks.trackNumber,
  fullPath: tracks.fullPath,
  previewPath: tracks.previewPath,
  createdAt: tracks.createdAt,
  updatedAt: tracks.updatedAt
};

async function handleListTracks(req, res) {
  const albumId = String(req.query?.albumId || '').trim();
  if (!albumId) return sendJson(res, 400, { ok: false, error: 'albumId ausente.' });

  try {
    const rows = await db.select(trackSelectFields)
      .from(tracks)
      .where(eq(tracks.albumId, albumId))
      .orderBy(asc(tracks.trackNumber), asc(tracks.createdAt));

    const mapped = rows.map(mapTrackRow);
    return sendJson(res, 200, { ok: true, tracks: mapped });
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

  let nextIndex = 1;
  try {
    const [maxRow] = await db.select({ n: tracks.trackNumber })
      .from(tracks)
      .where(eq(tracks.albumId, albumId))
      .orderBy(desc(tracks.trackNumber))
      .limit(1);
    nextIndex = (maxRow?.n || 0) + 1;
  } catch {}

  const slug = String(body.slug || title)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || `track-${Date.now()}`;

  // Pega artistId do álbum (ou do primeiro artista)
  const [albumRow] = await db.select({ artistId: albums.artistId })
    .from(albums).where(eq(albums.id, albumId)).limit(1);
  let artistId = albumRow?.artistId;
  if (!artistId) {
    const [firstArtist] = await db.select({ id: artists.id }).from(artists).limit(1);
    artistId = firstArtist?.id;
  }
  if (!artistId) {
    return sendJson(res, 400, { ok: false, error: 'Nenhum artista cadastrado.' });
  }

  const payload = {
    id: crypto.randomUUID(),
    albumId,
    artistId,
    title,
    slug,
    trackNumber: nextIndex,
    status: body.published ? 'PUBLISHED' : 'DRAFT',
    durationSeconds: Number.isFinite(Number(body.duration_seconds)) ? Number(body.duration_seconds) : null,
    previewKey: String(body.preview_path || '').trim() || null,
    streamKey: String(body.full_path || '').trim() || null,
    fullPath: String(body.full_path || '').trim() || null,
    previewPath: String(body.preview_path || '').trim() || null
  };

  try {
    const [created] = await db.insert(tracks).values(payload).returning();

    await audit('track.create', {
      actor: session.user,
      target: `${albumId}:${nextIndex}`,
      metadata: { title }
    });

    return sendJson(res, 200, { ok: true, track: mapTrackRow(created) });
  } catch (err) {
    console.error('[admin/track] POST erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleUpdateTrack(req, res, session) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const body = parseBody(req);
  const patch = {};

  if (typeof body.title === 'string')           patch.title = body.title.trim();
  if (typeof body.slug === 'string')            patch.slug = body.slug.trim();
  if (body.track_index !== undefined)           patch.trackNumber = Number(body.track_index) || 0;
  if (body.track_number !== undefined)          patch.trackNumber = Number(body.track_number) || 0;
  if (typeof body.published === 'boolean')      patch.status = body.published ? 'PUBLISHED' : 'DRAFT';
  if (typeof body.status === 'string' && ['DRAFT','PUBLISHED','ARCHIVED'].includes(body.status)) patch.status = body.status;
  if (body.duration_seconds !== undefined)      patch.durationSeconds = Number.isFinite(Number(body.duration_seconds)) ? Number(body.duration_seconds) : null;
  if (typeof body.preview_path === 'string')    { patch.previewPath = body.preview_path.trim() || null; patch.previewKey = body.preview_path.trim() || null; }
  if (typeof body.full_path === 'string')       { patch.fullPath = body.full_path.trim() || null; patch.streamKey = body.full_path.trim() || null; }

  if (Object.keys(patch).length === 0) {
    return sendJson(res, 400, { ok: false, error: 'Nada para atualizar.' });
  }

  try {
    const rows = await db.update(tracks)
      .set(patch)
      .where(eq(tracks.id, id))
      .returning();

    if (!rows.length) {
      return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
    }

    await audit('track.update', {
      actor: session.user,
      target: String(id),
      metadata: { fields: Object.keys(patch) }
    });

    return sendJson(res, 200, { ok: true, track: mapTrackRow(rows[0]) });
  } catch (err) {
    console.error('[admin/track] PATCH erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleDeleteTrack(req, res, session) {
  const id = String(req.query?.id || '').trim();
  if (!id) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    const deleted = await db.delete(tracks).where(eq(tracks.id, id)).returning();

    if (!deleted.length) {
      return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
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
      error: 'Payload deve ser { order: [{ id, track_number }, ...] }.'
    });
  }

  try {
    await Promise.all(order.map((item, i) => {
      const n = Number(item.track_number) || (i + 1);
      return db
        .update(tracks)
        .set({ trackNumber: n })
        .where(eq(tracks.id, String(item.id)));
    }));

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
// DOWNLOADS (admin)
// ─────────────────────────────────────────────────────────────
async function handleDownloadUrl(req, res, session) {
  const trackId = String(req.query?.id || '').trim();
  if (!trackId) {
    return sendJson(res, 400, { ok: false, error: 'ID de faixa inválido.' });
  }

  try {
    const [track] = await db.select(trackSelectFields)
      .from(tracks).where(eq(tracks.id, trackId)).limit(1);

    if (!track) {
      return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
    }

    if (!track.fullPath) {
      return sendJson(res, 400, {
        ok: false,
        error: 'Esta faixa não tem áudio completo cadastrado.',
        code: 'NO_FULL_PATH'
      });
    }

    const baseName = sanitizeFilename(track.title);
    const filename = `${baseName}.mp3`;

    const signed = await createSignedDownloadUrl(
      'audio-premium',
      track.fullPath,
      DOWNLOAD_TTL_SEC,
      filename
    );

    if (!signed.ok) {
      console.error('[admin/download-url] sign falhou:', signed.error);
      return sendJson(res, 502, {
        ok: false,
        error: 'Falha ao preparar download.',
        code: 'SIGN_FAILED'
      });
    }

    await audit('download.track', {
      actor: session.user,
      target: String(trackId),
      metadata: { title: track.title, album: track.albumId }
    });

    return sendJson(res, 200, {
      ok: true,
      url: signed.url,
      filename: signed.filename,
      expiresIn: DOWNLOAD_TTL_SEC
    });
  } catch (err) {
    console.error('[admin/download-url] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

async function handleDownloadAlbum(req, res, session) {
  const albumId = String(req.query?.id || '').trim();
  if (!albumId) {
    return sendJson(res, 400, { ok: false, error: 'ID do álbum ausente.' });
  }

  try {
    const rows = await db.select(trackSelectFields)
      .from(tracks)
      .where(eq(tracks.albumId, albumId))
      .orderBy(asc(tracks.trackNumber));

    if (!rows.length) {
      return sendJson(res, 404, { ok: false, error: 'Álbum sem faixas.' });
    }

    const results = [];

    for (const t of rows) {
      if (!t.fullPath) {
        results.push({
          id: t.id,
          title: t.title,
          trackIndex: t.trackNumber,
          url: null,
          filename: null,
          error: 'SEM_AUDIO'
        });
        continue;
      }

      const idx = String(t.trackNumber || 0).padStart(2, '0');
      const baseName = sanitizeFilename(t.title);
      const filename = `${idx} - ${baseName}.mp3`;

      const signed = await createSignedDownloadUrl(
        'audio-premium',
        t.fullPath,
        DOWNLOAD_TTL_SEC,
        filename
      );

      results.push({
        id: t.id,
        title: t.title,
        trackIndex: t.trackNumber,
        url: signed.ok ? signed.url : null,
        filename: signed.ok ? signed.filename : null,
        error: signed.ok ? null : 'SIGN_FAILED'
      });
    }

    await audit('download.album', {
      actor: session.user,
      target: albumId,
      metadata: { count: rows.length }
    });

    return sendJson(res, 200, {
      ok: true,
      albumId,
      expiresIn: DOWNLOAD_TTL_SEC,
      tracks: results
    });
  } catch (err) {
    console.error('[admin/download-album] erro:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Serviço indisponível.' });
  }
}

function sanitizeFilename(s) {
  return String(s || 'audio')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    || 'audio';
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