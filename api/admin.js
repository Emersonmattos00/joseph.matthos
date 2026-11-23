'use strict';

/* ============================================================
   api/admin.js — Painel administrativo (v4.2)
   ------------------------------------------------------------
   - Fluxo de quarentena + promoção atômica
   - Reconciliação determinística via definitiveKey
   - Advisory locks em operações críticas
   - Cancelamento externo (Mercado Pago) antes de alterações locais
   - Cache invalidado após mudanças de plano/usuário
   ============================================================ */

const crypto = require('crypto');

const {
  sendJson, methodNotAllowed, parseBody, parseCookies, clientIp,
  checkAndIncrement, resetBucket, audit, VALID_PLANS,
  signHmac, verifyHmac, verifyScrypt, generateScryptHash, timingSafeEq, checkOrigin, IS_PROD
} = require('./_lib');

const { db, eq, and, asc, desc, gte, drizzleSql, inArray, sql, isNull } = require('./_db');
const schema = require('./_db').schema;
const {
  tracks, albums, artists, orders, orderItems, rentals, paymentsEvents,
  adminAudit, uploadIntents, users, subscriptions, plans
} = schema;

const {
  uploadObject, createSignedUploadUrl, createSignedDownloadUrl,
  getPublicUrl, getObjectMetadata, buildPathForKind,
  inferKindFromKey, getPrefixForKind, getPublicR2Config, ALLOWED_MEDIA,
  promoteFromQuarantine, isQuarantinePath, deleteObject, buildDefinitivePath
} = require('./_storage');

// ─────────────────────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────────────────────
const SESSION_COOKIE_PROD = '__Host-jm_admin';
const SESSION_COOKIE_DEV = 'jm_admin';
const SESSION_COOKIE = IS_PROD ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;
const SESSION_MAX_AGE = 60 * 60 * 4;
const MIN_SESSION_SECRET_LENGTH = 32;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const CONTENT_KEY = 'default';
const DOWNLOAD_TTL_SEC = 3600;
const SIGNED_UPLOAD_TTL_SEC = 900;
const UPLOAD_INTENT_TTL_MS = SIGNED_UPLOAD_TTL_SEC * 1000;

const RECONCILE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const RECONCILE_MAX_ITEMS = 50;

const VALID_ACTIONS = new Set([
  'login', 'session', 'logout', 'content', 'storage-config',
  'upload', 'upload-sign', 'upload-confirm', 'reconcile-uploads',
  'users', 'sales', 'audit', 'gen-hash',
  'albums', 'album', 'tracks', 'track', 'track-order',
  'download-url', 'download-album', 'delete-user', 'update-lyrics'
]);

const DEV_NO_RATE_LIMIT = process.env.NODE_ENV !== 'production' && process.env.DISABLE_RATE_LIMIT === 'true';
const DEV_NO_CSRF = process.env.NODE_ENV !== 'production' && process.env.DISABLE_CSRF === 'true';

const MAX_LYRICS_BYTES = 200 * 1024;
const MAX_LYRICS_LINES = 500;
const MAX_LYRICS_LINE_LENGTH = 500;

// ─────────────────────────────────────────────────────────────
// SESSÃO / IDENTIDADE
// ─────────────────────────────────────────────────────────────
let _sessionSecretCache = null;
function getSessionSecret() {
  if (_sessionSecretCache) return _sessionSecretCache;
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET ausente.');
  if (secret.length < MIN_SESSION_SECRET_LENGTH) throw new Error('ADMIN_SESSION_SECRET muito curto.');
  _sessionSecretCache = secret;
  return secret;
}

let _adminIdentityCache = null;
function getAdminIdentity() {
  if (_adminIdentityCache) return _adminIdentityCache;
  const id = String(process.env.ADMIN_USER_ID || '').trim();
  if (id) {
    if (!isUuid(id)) throw new Error('ADMIN_USER_ID deve ser um UUID válido.');
    _adminIdentityCache = { kind: 'id', value: id };
    return _adminIdentityCache;
  }
  const user = String(process.env.ADMIN_USER || '').trim();
  if (!user) throw new Error('ADMIN_USER ou ADMIN_USER_ID ausente.');
  _adminIdentityCache = { kind: 'email', value: user };
  return _adminIdentityCache;
}

function checkConfig() {
  try {
    getSessionSecret();
    getAdminIdentity();
    if (!String(process.env.ADMIN_USER || '').trim()) return { ok: false, error: 'ADMIN_USER ausente.' };
    if (!process.env.ADMIN_PASSWORD_HASH) return { ok: false, error: 'ADMIN_PASSWORD_HASH ausente.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getAdminUpdatedBy() {
  const id = String(process.env.ADMIN_USER_ID || '').trim();
  return isUuid(id) ? id : null;
}

function buildIntentDefinitivePath(kind, intentionId, quarantinePath) {
  if (!isUuid(intentionId)) throw new Error('Intenção de upload inválida.');
  const ext = String(quarantinePath || '').split('.').pop().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('Extensão inválida.');
  return buildDefinitivePath(kind, ext);
}

// ─────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const cfg = checkConfig();
  if (!cfg.ok) return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });

  const action = parseAction(req.query);
  if (!action) return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !DEV_NO_CSRF) {
    if (!checkOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
  }

  if (action === 'login') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    try { return await handleLogin(req, res); }
    catch (err) { console.error('[admin] login exception:', err); return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' }); }
  }

  let session;
  try { session = verifySession(req); }
  catch (err) { return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' }); }
  if (!session) return sendJson(res, 401, { ok: false, error: 'Não autorizado.' });

  try {
    switch (action) {
      case 'storage-config': if (method === 'GET') return handleStorageConfig(req, res, session); break;
      case 'session':
        if (method === 'GET') return handleSession(req, res, session);
        return methodNotAllowed(res, 'GET');
      case 'logout': if (method === 'POST') return handleLogout(req, res, session); break;
      case 'content':
        if (method === 'GET') return handleGetContent(req, res);
        if (method === 'PUT') return handlePutContent(req, res, session);
        break;
      case 'upload': if (method === 'POST') return handleUpload(req, res, session); break;
      case 'upload-sign': if (method === 'POST') return handleUploadSign(req, res, session); break;
      case 'upload-confirm': if (method === 'POST') return handleUploadConfirm(req, res, session); break;
      case 'reconcile-uploads': if (method === 'POST') return handleReconcileUploads(req, res, session); break;
      case 'users':
        if (method === 'GET') return handleGetUsers(req, res);
        if (method === 'PATCH') return handlePatchUser(req, res, session);
        if (method === 'DELETE') return handleDeleteUser(req, res, session);
        break;
      case 'sales': if (method === 'GET') return handleGetSales(req, res); break;
      case 'audit': if (method === 'GET') return handleGetAudit(req, res); break;
      case 'gen-hash': if (method === 'POST') return handleGenHash(req, res, session); break;
      case 'albums':
        if (method === 'GET') return handleListAlbums(req, res);
        if (method === 'POST') return handleCreateAlbum(req, res, session);
        break;
      case 'album':
        if (method === 'GET') return handleGetAlbum(req, res);
        if (method === 'PATCH') return handleUpdateAlbum(req, res, session);
        if (method === 'DELETE') return handleDeleteAlbum(req, res, session);
        break;
      case 'tracks':
        if (method === 'GET') return handleListTracks(req, res);
        if (method === 'POST') return handleCreateTrack(req, res, session);
        break;
      case 'track':
        if (method === 'PATCH') return handleUpdateTrack(req, res, session);
        if (method === 'DELETE') return handleDeleteTrack(req, res, session);
        break;
      case 'track-order': if (method === 'PATCH') return handleReorderTracks(req, res, session); break;
      case 'download-url': if (method === 'GET') return handleDownloadUrl(req, res, session); break;
      case 'download-album': if (method === 'GET') return handleDownloadAlbum(req, res, session); break;
      case 'update-lyrics': if (method === 'PATCH') return handleUpdateLyrics(req, res, session); break;
      default: return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
    }
  } catch (err) {
    console.error('[admin] erro não tratado:', err);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  return methodNotAllowed(res, 'GET, POST, PUT, PATCH, DELETE');
};

// ─────────────────────────────────────────────────────────────
// LOGIN / SESSION / LOGOUT
// ─────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const ip = clientIp(req);
  const rate = DEV_NO_RATE_LIMIT
    ? { limited: false }
    : await checkAndIncrement(`admin-login:${ip}`, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, { failClosed: true });
  if (rate.limited) return sendJson(res, 429, { ok: false, error: 'Muitas tentativas.' });

  const body = parseBody(req);
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');
  const expectedUser = String(process.env.ADMIN_USER || '').trim();
  const hash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();

  if (!expectedUser || !hash) return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });

  const userOk = timingSafeEq(user, expectedUser);
  const passOk = await verifyScrypt(pass, hash);

  if (!userOk || !passOk) {
    try { await audit('admin_login', { ip, success: false, reason: 'invalid', target: user }); } catch {}
    return sendJson(res, 401, { ok: false, error: 'Usuário ou senha incorretos.' });
  }

  try { await resetBucket(`admin-login:${ip}`); } catch {}

  const token = signHmac({ user: expectedUser, iat: Date.now(), jti: crypto.randomUUID() }, getSessionSecret());
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_MAX_AGE}`, IS_PROD ? 'Secure' : null].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${attrs}`);

  try { await audit('admin_login', { actor: expectedUser, ip, success: true }); } catch {}
  return sendJson(res, 200, { ok: true, user: expectedUser });
}

async function handleSession(req, res, session) {
  return sendJson(res, 200, { ok: true, user: session.user });
}

async function handleLogout(req, res, session) {
  try { await audit('admin_logout', { actor: session.user, ip: clientIp(req) }); } catch {}
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', IS_PROD ? 'Secure' : null].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${attrs}`);
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// CONTEÚDO — CAS atômico
// ─────────────────────────────────────────────────────────────
async function handleGetContent(req, res) {
  const [row] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, CONTENT_KEY)).limit(1);
  return sendJson(res, 200, {
    ok: true,
    data: row?.data || {},
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt || null
  });
}

async function handlePutContent(req, res, session) {
  const body = parseBody(req);
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });
  }

  const rawBaseVersion = body.baseVersion !== undefined ? body.baseVersion : body.version;
  const expectedVersion = Number(rawBaseVersion);
  if (rawBaseVersion === null || rawBaseVersion === undefined ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    return sendJson(res, 400, { ok: false, code: 'INVALID_BASE_VERSION', error: 'Versão-base inválida.' });
  }

  if (data.contato && data.contato.socials) {
    if (!Array.isArray(data.contato.socials)) return sendJson(res, 400, { ok: false, error: 'Formato de socials inválido.' });
    const validNetworks = new Set(['spotify','youtube','amazon','facebook','tiktok','apple','audiomack','deezer','soundcloud','instagram','x']);
    for (const s of data.contato.socials) {
      if (!s || typeof s !== 'object') return sendJson(res, 400, { ok: false, error: 'Item de social inválido.' });
      if (!validNetworks.has(String(s.network || ''))) return sendJson(res, 400, { ok: false, error: 'Rede social não permitida.' });
      if (s.url && !/^https?:\/\/[^\s]+$/i.test(String(s.url))) return sendJson(res, 400, { ok: false, error: 'URL de rede social inválida.' });
    }
  }

  if (data.filosofia && data.filosofia.frases) {
    if (!Array.isArray(data.filosofia.frases)) return sendJson(res, 400, { ok: false, error: 'Formato de frases inválido.' });
    if (data.filosofia.frases.length > 500) return sendJson(res, 400, { ok: false, error: 'Limite de frases excedido.' });
  }

  const updatedBy = getAdminUpdatedBy();
  let newVersion;
  try {
    newVersion = await db.transaction(async (tx) => {
      const next = expectedVersion + 1;
      const now = new Date().toISOString();

      if (expectedVersion === 0) {
        const inserted = await tx.insert(schema.siteContent)
          .values({ key: CONTENT_KEY, data, version: next, updatedAt: now, updatedBy })
          .onConflictDoNothing({ target: schema.siteContent.key })
          .returning({ version: schema.siteContent.version });
        if (inserted.length !== 1) { const err = new Error('VERSION_CONFLICT'); err.code = 'VERSION_CONFLICT'; throw err; }
        return next;
      }

      const updated = await tx.update(schema.siteContent)
        .set({ data, version: next, updatedAt: now, updatedBy })
        .where(and(eq(schema.siteContent.key, CONTENT_KEY), eq(schema.siteContent.version, expectedVersion)))
        .returning({ version: schema.siteContent.version });

      if (updated.length !== 1) { const err = new Error('VERSION_CONFLICT'); err.code = 'VERSION_CONFLICT'; throw err; }
      return next;
    });
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT') return sendJson(res, 409, { ok: false, error: 'Conteúdo foi alterado por outra sessão. Recarregue.' });
    throw err;
  }

  try { await audit('content.update', { actor: session.user, metadata: { version: newVersion } }); }
  catch (e) { console.warn('[admin] audit content.update falhou:', e.message); }

  return sendJson(res, 200, { ok: true, version: newVersion, updatedAt: new Date().toISOString() });
}

// ─────────────────────────────────────────────────────────────
// UPLOADS — Quarentena + Promoção
// ─────────────────────────────────────────────────────────────
function looksLikeImage(buf, mime) {
  if (buf.length < 12) return false;
  switch (mime) {
    case 'image/jpeg': return buf[0] === 0xFF && buf[1] === 0xD8;
    case 'image/png':  return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
    case 'image/gif':  return buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
    case 'image/webp': return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    case 'image/avif': return buf.toString('ascii', 4, 8) === 'ftyp';
    default: return false;
  }
}

function validateFilePayload({ kind, filename, contentType, base64 }) {
  const media = ALLOWED_MEDIA[kind];
  if (!media) return { ok: false, error: 'Tipo inválido.' };

  const name = String(filename || '').trim();
  if (!name || !name.includes('.')) return { ok: false, error: 'Nome de arquivo inválido.' };
  const ext = name.split('.').pop().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return { ok: false, error: 'Extensão inválida.' };

  const mime = String(contentType || '').trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime) || mime.length > 150) return { ok: false, error: 'Content-Type inválido.' };

  const extSet = media.exts instanceof Set ? media.exts : new Set(media.exts || []);
  const mimeSet = media.mimes instanceof Set ? media.mimes : new Set(media.mimes || []);
  if (!mimeSet.has(mime)) return { ok: false, error: `Tipo não permitido para ${kind}.` };
  if (!extSet.has(ext)) return { ok: false, error: `Extensão não permitida para ${kind}.` };

  let buffer = null;
  if (base64 !== undefined) {
    const raw = String(base64 || '').trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) return { ok: false, error: 'Conteúdo base64 inválido.' };
    const maxBase64Chars = Math.ceil(media.maxBytes * 4 / 3) + 8;
    if (raw.length > maxBase64Chars) return { ok: false, error: 'Arquivo base64 excede o tamanho máximo permitido.' };

    buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0) return { ok: false, error: 'Arquivo vazio.' };
    if (buffer.length > media.maxBytes) return { ok: false, error: 'Arquivo decodificado excede o tamanho máximo.' };
    if (kind === 'image' && !looksLikeImage(buffer, mime)) return { ok: false, error: 'Conteúdo não corresponde ao tipo de imagem.' };
  }
  return { ok: true, ext, mime, buffer };
}

async function handleUpload(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  if (kind !== 'image') return sendJson(res, 400, { ok: false, error: 'Upload direto permitido apenas para imagens. Use upload-sign para áudio.' });

  const validation = validateFilePayload({ kind, filename: body.filename, contentType: body.contentType, base64: body.base64 });
  if (!validation.ok) return sendJson(res, 400, { ok: false, error: validation.error });
  if (!validation.buffer) return sendJson(res, 400, { ok: false, error: 'Conteúdo base64 ausente.' });

  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${validation.ext}`;
  let quarantinePath;
  try { quarantinePath = buildPathForKind(kind, uniqueName); }
  catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }

  try { await uploadObject(quarantinePath, validation.buffer, validation.mime); }
  catch (err) {
    if (err.code === 'DIRECT_UPLOAD_FORBIDDEN' || err.code === 'INVALID_KIND') return sendJson(res, 400, { ok: false, error: err.message });
    if (err.code === 'NOT_CONFIGURED') return sendJson(res, 503, { ok: false, error: 'Storage indisponível.' });
    console.error('[admin] falha upload direto:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Falha no upload.' });
  }

  let promoted;
  try {
    promoted = await promoteFromQuarantine(quarantinePath, kind, {
      expectedSize: validation.buffer.length,
      expectedMime: validation.mime
    });
  } catch (err) {
    console.error('[admin] falha promoção upload direto:', err.code || err.message);
    try { await deleteObject(quarantinePath); } catch {}
    return sendJson(res, 502, { ok: false, error: 'Falha ao finalizar upload.' });
  }

  let publicUrl;
  try { publicUrl = getPublicUrl(promoted.definitiveKey); }
  catch (err) {
    try { await deleteObject(promoted.definitiveKey); } catch {}
    return sendJson(res, 502, { ok: false, error: 'Falha ao publicar imagem.' });
  }

  try { await audit('upload.direct', { actor: session.user, metadata: { kind, path: promoted.definitiveKey, size: validation.buffer.length } }); }
  catch (e) { console.warn('[admin] audit upload.direct falhou:', e.message); }

  return sendJson(res, 200, { ok: true, url: publicUrl, path: promoted.definitiveKey });
}

async function handleUploadSign(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const validation = validateFilePayload({ kind, filename: body.filename, contentType: body.contentType });
  if (!validation.ok) return sendJson(res, 400, { ok: false, error: validation.error });

  const sizeBytes = Number(body.size);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return sendJson(res, 400, { ok: false, error: 'Tamanho do arquivo inválido.' });
  const media = ALLOWED_MEDIA[kind];
  const maxBytes = Number(media?.maxBytes || 0);
  if (!maxBytes || sizeBytes > maxBytes) return sendJson(res, 400, { ok: false, error: 'Arquivo excede o limite permitido.' });

  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${validation.ext}`;
  let quarantinePath;
  try { quarantinePath = buildPathForKind(kind, uniqueName); }
  catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }

  let signed;
  try { signed = await createSignedUploadUrl(quarantinePath, validation.mime, sizeBytes, SIGNED_UPLOAD_TTL_SEC); }
  catch (err) {
    if (err.code === 'NOT_CONFIGURED') return sendJson(res, 503, { ok: false, error: 'Storage indisponível.' });
    console.error('[admin] falha sign:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Falha ao preparar upload.' });
  }

  const intentionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_MS).toISOString();

  try {
    await db.insert(uploadIntents).values({
      id: intentionId, adminUser: session.user, kind, path: quarantinePath,
      contentType: validation.mime, expectedSize: sizeBytes, expiresAt,
      consumedAt: null, createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('[admin] falha ao registrar intenção:', err.message);
    try { await deleteObject(quarantinePath); } catch {}
    return sendJson(res, 502, { ok: false, error: 'Falha ao preparar upload.' });
  }

  try { await audit('upload.sign', { actor: session.user, metadata: { kind, path: quarantinePath, mime: validation.mime, sizeBytes } }); }
  catch (e) { console.warn('[admin] audit upload.sign falhou:', e.message); }

  return sendJson(res, 200, { ok: true, intentionId, uploadUrl: signed.uploadUrl, path: signed.path, bucket: signed.bucket, expiresIn: signed.expiresIn });
}

async function handleUploadConfirm(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const path = String(body.path || '').trim();
  const intentionId = String(body.intentionId || '').trim();

  if (!kind || !path || !intentionId) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });
  if (!isUuid(intentionId)) return sendJson(res, 400, { ok: false, error: 'intentionId inválido.' });
  if (!['audio-full', 'audio-preview'].includes(kind)) return sendJson(res, 400, { ok: false, error: 'Tipo não permitido para associação com faixa.' });
  if (!isQuarantinePath(path)) return sendJson(res, 400, { ok: false, error: 'O upload precisa estar em quarentena.' });

  let inferredKind;
  try { inferredKind = inferKindFromKey(path); }
  catch { return sendJson(res, 400, { ok: false, error: 'Caminho de storage inválido.' }); }
  if (inferredKind !== kind) return sendJson(res, 400, { ok: false, error: 'O tipo informado não corresponde ao caminho no Storage.' });

  const hasTrackIndex = body.trackIndex !== undefined && body.trackIndex !== null && body.trackIndex !== '';
  const trackIndex = hasTrackIndex ? Number(body.trackIndex) : null;
  const albumId = body.albumId ? String(body.albumId).trim() : null;
  const trackId = body.trackId ? String(body.trackId).trim() : null;

  if (trackId && (albumId || hasTrackIndex)) return sendJson(res, 400, { ok: false, error: 'Informe trackId OU (albumId + trackIndex), nunca ambos.' });
  const byTrackId = Boolean(trackId && isUuid(trackId));
  const byAlbumIndex = Boolean(albumId && isUuid(albumId) && hasTrackIndex && Number.isInteger(trackIndex) && trackIndex >= 1);
  if (byTrackId === byAlbumIndex) return sendJson(res, 400, { ok: false, error: 'Informe exclusivamente trackId OU (albumId e trackIndex).' });

  let intentSnapshot = null;
  let definitiveKey = null;
  try {
    await db.transaction(async (tx) => {
      const consumed = await tx.update(uploadIntents)
        .set({ consumedAt: new Date().toISOString() })
        .where(and(
          eq(uploadIntents.id, intentionId),
          eq(uploadIntents.adminUser, session.user),
          eq(uploadIntents.path, path),
          eq(uploadIntents.kind, kind),
          isNull(uploadIntents.consumedAt),
          sql`${uploadIntents.expiresAt} > NOW()`
        ))
        .returning({
          id: uploadIntents.id, path: uploadIntents.path, kind: uploadIntents.kind,
          contentType: uploadIntents.contentType, expectedSize: uploadIntents.expectedSize
        });

      if (consumed.length !== 1) { const err = new Error('UPLOAD_INTENT_ALREADY_CONSUMED'); err.code = 'UPLOAD_INTENT_ALREADY_CONSUMED'; throw err; }
      intentSnapshot = consumed[0];

      definitiveKey = buildIntentDefinitivePath(kind, intentionId, path);

      const patch = kind === 'audio-full'
        ? { fullPath: definitiveKey, streamKey: definitiveKey, updatedAt: new Date().toISOString() }
        : { previewPath: definitiveKey, previewKey: definitiveKey, updatedAt: new Date().toISOString() };

      let updated;
      if (byTrackId) {
        [updated] = await tx.update(tracks).set(patch).where(eq(tracks.id, trackId)).returning({ id: tracks.id });
      } else {
        [updated] = await tx.update(tracks).set(patch)
          .where(and(eq(tracks.albumId, albumId), eq(tracks.trackNumber, trackIndex)))
          .returning({ id: tracks.id });
      }

      if (!updated) { const err = new Error('TRACK_NOT_FOUND'); err.code = 'TRACK_NOT_FOUND'; throw err; }
    });
  } catch (err) {
    if (err.code === 'UPLOAD_INTENT_ALREADY_CONSUMED') return sendJson(res, 409, { ok: false, error: 'Intenção já consumida por outra requisição.' });
    if (err.code === 'TRACK_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada para associação.' });
    console.error('[admin] falha na transação de confirmação:', err);
    return sendJson(res, 500, { ok: false, error: 'Falha interna ao confirmar upload.' });
  }

  try {
    await promoteFromQuarantine(path, kind, {
      expectedSize: intentSnapshot.expectedSize ? Number(intentSnapshot.expectedSize) : undefined,
      expectedMime: intentSnapshot.contentType || undefined,
      definitiveKey
    });
  } catch (err) {
    console.error('[admin] falha ao promover objeto:', err.code || err.message);
    return sendJson(res, 502, { ok: false, error: 'Falha ao promover upload. Reprocesse via reconciliação.' });
  }

  let publicUrl = null;
  try { publicUrl = getPublicUrl(definitiveKey); } catch { /* private */ }

  try { await audit('upload.confirm', { actor: session.user, metadata: { kind, path: definitiveKey, intentionId } }); }
  catch (e) { console.warn('[admin] audit upload.confirm falhou:', e.message); }

  return sendJson(res, 200, { ok: true, url: publicUrl, path: definitiveKey });
}

// ─────────────────────────────────────────────────────────────
// RECONCILIAÇÃO — on-demand
// ─────────────────────────────────────────────────────────────
async function handleReconcileUploads(req, res, session) {
  const cutoffIso = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();

  let intents;
  try {
    intents = await db.select({
      id: uploadIntents.id, kind: uploadIntents.kind, path: uploadIntents.path,
      contentType: uploadIntents.contentType, expectedSize: uploadIntents.expectedSize,
      consumedAt: uploadIntents.consumedAt
    }).from(uploadIntents)
      .where(and(
        sql`${uploadIntents.consumedAt} IS NOT NULL`,
        sql`${uploadIntents.consumedAt} > ${cutoffIso}`,
        eq(uploadIntents.adminUser, session.user)
      ))
      .orderBy(desc(uploadIntents.consumedAt))
      .limit(RECONCILE_MAX_ITEMS);
  } catch (err) {
    console.error('[admin] reconcile: falha ao consultar intenções:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Falha ao consultar intenções.' });
  }

  const results = [];
  for (const it of intents) {
    const item = { intentionId: it.id, kind: it.kind, path: it.path, action: 'skipped', reason: null };

    let candidateDefinitive = null;
    try { candidateDefinitive = buildIntentDefinitivePath(it.kind, it.id, it.path); }
    catch (e) { item.reason = 'invalid_kind_or_ext'; results.push(item); continue; }

    let track = null;
    try {
      const rows = await db.select({ id: tracks.id, fullPath: tracks.fullPath, previewPath: tracks.previewPath })
        .from(tracks)
        .where(it.kind === 'audio-full'
          ? eq(tracks.fullPath, candidateDefinitive)
          : eq(tracks.previewPath, candidateDefinitive))
        .limit(1);
      track = rows[0] || null;
    } catch (e) { item.reason = 'db_error'; results.push(item); continue; }

    if (!track) { item.reason = 'no_track_ref'; results.push(item); continue; }

    const currentPath = it.kind === 'audio-full' ? track.fullPath : track.previewPath;
    let definitiveMeta = null;
    try { definitiveMeta = await getObjectMetadata(currentPath); }
    catch (e) { item.reason = 'storage_error'; results.push(item); continue; }

    if (definitiveMeta) { item.action = 'already_ok'; results.push(item); continue; }

    let quarantineMeta = null;
    try { quarantineMeta = await getObjectMetadata(it.path); }
    catch (e) { item.reason = 'storage_error'; results.push(item); continue; }

    if (!quarantineMeta) { item.reason = 'quarantine_expired'; results.push(item); continue; }

    try {
      await promoteFromQuarantine(it.path, it.kind, {
        expectedSize: it.expectedSize ? Number(it.expectedSize) : undefined,
        expectedMime: it.contentType || undefined,
        definitiveKey: currentPath
      });
      item.action = 'repromoted';
      results.push(item);
      try { await audit('upload.reconcile', { actor: session.user, target: it.id, metadata: { kind: it.kind, path: currentPath } }); }
      catch (e) { console.warn('[admin] audit upload.reconcile falhou:', e.message); }
    } catch (err) {
      item.reason = err.code || 'promote_failed';
      results.push(item);
    }
  }

  return sendJson(res, 200, { ok: true, scanned: intents.length, results });
}

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// ─────────────────────────────────────────────────────────────
function normalizePlanCode(name, intervalUnit) {
  const n = String(name || '').toLowerCase();
  const u = String(intervalUnit || '').toLowerCase();
  if (n.includes('anual') || u === 'year') return 'anual';
  if (n.includes('premium') || u === 'month') return 'premium';
  if (n.includes('free') || n.includes('gratis')) return 'free';
  return null;
}

async function handleGetUsers(req, res) {
  const rows = await db.select({
    id: users.id, email: users.email, name: users.name, createdAt: users.createdAt
  }).from(users).orderBy(desc(users.createdAt));

  let planMap = new Map();
  let plansError = false;
  try {
    const [effectiveResult, dbPlans] = await Promise.all([
      db.execute(drizzleSql`SELECT user_id, plan FROM effective_plan`),
      db.select({ name: plans.name, intervalUnit: plans.intervalUnit }).from(plans)
    ]);

    const intervalByName = new Map(
      dbPlans.map((p) => [String(p.name), p.intervalUnit])
    );

    const effectiveRows = effectiveResult.rows || effectiveResult;
    planMap = new Map(effectiveRows.map((r) => {
      const rawPlan = String(r.plan || 'free');
      const code = normalizePlanCode(rawPlan, intervalByName.get(rawPlan) || '');
      return [r.user_id, code || 'free'];
    }));
  } catch (e) {
    console.error('[admin] falha ao consultar planos efetivos:', e.message);
    plansError = true;
  }

  return sendJson(res, 200, {
    ok: true,
    users: rows.map(u => ({
      ...u,
      plan: plansError ? null : (planMap.get(u.id) || 'free')
    })),
    plansError,
    total: rows.length
  });
}

async function cancelExternalSubscriptionsForUser(userId) {
  const rows = await db.select({
    id: subscriptions.id,
    externalSubscriptionId: subscriptions.externalSubscriptionId
  }).from(subscriptions).where(and(
    eq(subscriptions.userId, userId),
    inArray(subscriptions.status, ['ACTIVE', 'PENDING', 'PAUSED', 'PAST_DUE'])
  ));

  const externalIds = [...new Set(
    rows
      .map((row) => String(row.externalSubscriptionId || '').trim())
      .filter((id) => id && !id.startsWith('manual_'))
  )];

  if (!externalIds.length) return;

  const token = String(process.env.MP_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('MP_ACCESS_TOKEN ausente para cancelar cobrança recorrente.');

  for (const externalId of externalIds) {
    const url = `https://api.mercadopago.com/preapproval/${encodeURIComponent(externalId)}`;

    const currentResponse = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    });

    const currentText = await currentResponse.text();
    let current = null;
    try { current = currentText ? JSON.parse(currentText) : null; } catch {}

    if (!currentResponse.ok) {
      throw new Error(`Falha ao consultar pré-aprovação ${externalId}: HTTP ${currentResponse.status}`);
    }

    const currentStatus = String(current?.status || '').toLowerCase();
    if (currentStatus === 'cancelled' || currentStatus === 'canceled') continue;

    const cancelResponse = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: 'cancelled' })
    });

    const cancelText = await cancelResponse.text();
    let canceled = null;
    try { canceled = cancelText ? JSON.parse(cancelText) : null; } catch {}

    if (!cancelResponse.ok) {
      throw new Error(`Falha ao cancelar pré-aprovação ${externalId}: HTTP ${cancelResponse.status}`);
    }

    const finalStatus = String(canceled?.status || '').toLowerCase();
    if (finalStatus && finalStatus !== 'cancelled' && finalStatus !== 'canceled') {
      throw new Error(`Mercado Pago não confirmou o cancelamento da pré-aprovação ${externalId}.`);
    }
  }
}

async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!isUuid(userId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });
  if (!VALID_PLANS.has(plan)) return sendJson(res, 400, { ok: false, error: 'Plano inválido.' });

  let user;
  let planRow = null;

  try {
    const [u] = await db.select({ id: users.id, email: users.email })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (!u) return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
    user = u;

    if (plan !== 'free') {
      const availablePlans = await db.select({
        id: plans.id, name: plans.name,
        intervalUnit: plans.intervalUnit, intervalCount: plans.intervalCount,
        active: plans.active
      }).from(plans).where(eq(plans.active, true));

      const matches = availablePlans.filter((p) =>
        normalizePlanCode(p.name, p.intervalUnit) === plan
      );

      if (matches.length === 0) {
        return sendJson(res, 400, {
          ok: false,
          error: `Não existe plano comercial ativo correspondente a "${plan}".`
        });
      }

      if (matches.length > 1) {
        return sendJson(res, 409, {
          ok: false,
          error: `Há mais de um plano comercial correspondente a "${plan}". Corrija a configuração no banco.`
        });
      }

      planRow = matches[0];
    }
  } catch (err) {
    console.error('[admin] patchUser validação:', err);
    return sendJson(res, 500, { ok: false, error: 'Falha ao validar operação.' });
  }

  const now = new Date();
  const nowIso = now.toISOString();
  let periodEnd = null;

  if (planRow) {
    const count = Math.max(1, Number(planRow.intervalCount) || 1);
    const unit = String(planRow.intervalUnit || '').toLowerCase();
    periodEnd = new Date(now);

    if (['year', 'years', 'yr'].includes(unit)) {
      periodEnd.setFullYear(periodEnd.getFullYear() + count);
    } else if (['month', 'months', 'mo'].includes(unit)) {
      const day = periodEnd.getDate();
      periodEnd.setDate(1);
      periodEnd.setMonth(periodEnd.getMonth() + count);
      const lastDay = new Date(periodEnd.getFullYear(), periodEnd.getMonth() + 1, 0).getDate();
      periodEnd.setDate(Math.min(day, lastDay));
    } else if (['week', 'weeks'].includes(unit)) {
      periodEnd.setDate(periodEnd.getDate() + (7 * count));
    } else {
      periodEnd.setDate(periodEnd.getDate() + count);
    }
  }

  try {
    await cancelExternalSubscriptionsForUser(userId);
  } catch (err) {
    console.error('[admin] falha ao cancelar assinatura externa antes da troca de plano:', err.message);
    return sendJson(res, 502, {
      ok: false,
      error: 'Não foi possível cancelar a cobrança recorrente no Mercado Pago. O plano local não foi alterado.'
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(subscriptions)
        .set({ status: 'CANCELLED', updatedAt: nowIso })
        .where(and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, ['ACTIVE', 'PENDING', 'PAUSED', 'PAST_DUE'])
        ));

      if (planRow) {
        await tx.insert(subscriptions).values({
          id: crypto.randomUUID(),
          userId,
          planId: planRow.id,
          externalSubscriptionId: null,
          status: 'ACTIVE',
          currentPeriodStart: nowIso,
          currentPeriodEnd: periodEnd.toISOString(),
          updatedAt: nowIso,
          payerEmail: user.email
        });
      }
    });
  } catch (err) {
    console.error('[admin] patchUser transação:', err);
    return sendJson(res, 500, { ok: false, error: 'Falha ao atualizar plano.' });
  }

  try {
    await audit('user.plan.change', {
      actor: session.user, target: userId,
      metadata: { plan, planId: planRow?.id || null }
    });
  } catch (e) { console.warn('[admin] audit user.plan.change falhou:', e.message); }

  try {
    const { invalidateUserCache } = require('./_cache');
    const invalidated = await invalidateUserCache(userId);
    if (!invalidated) {
      console.warn('[admin] cache do usuário não foi invalidado; autorização deve continuar sendo validada no banco.');
    }
  } catch (e) { console.warn('[admin] invalidateUserCache falhou:', e.message); }

  return sendJson(res, 200, { ok: true, plan });
}

async function handleDeleteUser(req, res, session) {
  const userId = String(req.query?.id || '').trim();
  if (!isUuid(userId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    const adminIdentity = getAdminIdentity();
    const [adminUser] = await db.select({ id: users.id }).from(users)
      .where(adminIdentity.kind === 'id' ? eq(users.id, adminIdentity.value) : eq(users.email, adminIdentity.value))
      .limit(1);
    if (adminUser && adminUser.id === userId) {
      return sendJson(res, 403, { ok: false, error: 'Não é permitido anonimizar a própria conta de administrador.' });
    }
  } catch (e) { console.warn('[admin] check de admin falhou:', e.message); }

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });

  try {
    await cancelExternalSubscriptionsForUser(userId);
  } catch (err) {
    console.error('[admin] falha ao cancelar assinatura externa antes da anonimização:', err.message);
    return sendJson(res, 502, {
      ok: false,
      error: 'Não foi possível cancelar a cobrança recorrente no Mercado Pago. O usuário não foi anonimizado.'
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(subscriptions)
        .set({ status: 'CANCELLED', updatedAt: new Date().toISOString() })
        .where(and(
          eq(subscriptions.userId, userId),
          inArray(subscriptions.status, ['ACTIVE', 'PENDING'])
        ));

      const anonymizedAt = new Date().toISOString();

      await tx.update(users).set({
        email: `anon_${userId}@deleted.local`,
        name: 'Usuário Anonimizado',
        passwordHash: null,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: anonymizedAt
      }).where(eq(users.id, userId));
    });
  } catch (err) {
    console.error('[admin] deleteUser transação:', err);
    try { await audit('user.delete', { actor: session.user, target: userId, success: false, reason: err.code || 'db_error' }); }
    catch {}
    return sendJson(res, 500, { ok: false, error: 'Falha ao anonimizar usuário.' });
  }

  try { await audit('user.delete', { actor: session.user, target: userId, success: true }); }
  catch (e) { console.warn('[admin] audit user.delete falhou:', e.message); }

  try {
    const { invalidateUserCache } = require('./_cache');
    await invalidateUserCache(userId);
  } catch (e) { console.warn('[admin] invalidateUserCache falhou:', e.message); }

  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// ÁLBUNS
// ─────────────────────────────────────────────────────────────
async function handleListAlbums(req, res) {
  const rows = await db.select().from(albums).orderBy(asc(albums.sortOrder));
  return sendJson(res, 200, { ok: true, albums: rows });
}

async function handleGetAlbum(req, res) {
  if (!isUuid(String(req.query.id || ''))) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });
  const [row] = await db.select().from(albums).where(eq(albums.id, req.query.id)).limit(1);
  return row ? sendJson(res, 200, { ok: true, album: row }) : sendJson(res, 404, { ok: false, error: 'Não encontrado.' });
}

async function handleCreateAlbum(req, res, session) {
  const body = parseBody(req);
  const title = String(body.title || '').trim();
  if (!title || title.length > 200) return sendJson(res, 400, { ok: false, error: 'Título inválido.' });
  if (body.published !== undefined && typeof body.published !== 'boolean') return sendJson(res, 400, { ok: false, error: 'published deve ser booleano.' });
  const published = typeof body.published === 'boolean' ? body.published : false;

  const slug = createSlug(title);
  if (!slug) return sendJson(res, 400, { ok: false, error: 'Título gera um slug inválido.' });

  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [artist] = await tx.select({ id: artists.id }).from(artists).limit(1);
      if (!artist) { const err = new Error('ARTIST_NOT_FOUND'); err.code = 'ARTIST_NOT_FOUND'; throw err; }

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`album:create:${slug}`}))`);

      const [dup] = await tx.select({ id: albums.id }).from(albums).where(eq(albums.slug, slug)).limit(1);
      if (dup) { const err = new Error('SLUG_CONFLICT'); err.code = 'SLUG_CONFLICT'; throw err; }

      const [row] = await tx.insert(albums).values({
        id: crypto.randomUUID(), title, slug, artistId: artist.id, published
      }).returning();
      return row;
    });
  } catch (err) {
    if (err.code === 'ARTIST_NOT_FOUND') return sendJson(res, 409, { ok: false, error: 'Nenhum artista cadastrado.' });
    if (err.code === 'SLUG_CONFLICT' || err.code === '23505') return sendJson(res, 409, { ok: false, error: 'Slug já existe.' });
    throw err;
  }

  try { await audit('album.create', { actor: session.user, target: created.id, metadata: { title, slug } }); }
  catch (e) { console.warn('[admin] audit album.create falhou:', e.message); }

  return sendJson(res, 200, { ok: true, album: created });
}

async function handleUpdateAlbum(req, res, session) {
  const albumId = String(req.query.id || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const body = parseBody(req);
  const patch = {};

  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 200) return sendJson(res, 400, { ok: false, error: 'Título inválido.' });
    const newSlug = createSlug(t);
    if (!newSlug) return sendJson(res, 400, { ok: false, error: 'Título gera um slug inválido.' });
    patch.title = t; patch.slug = newSlug;
  }
  if (body.year !== undefined) {
    const y = Number(body.year);
    const currentYear = new Date().getFullYear();
    if (!Number.isInteger(y) || y < 1900 || y > currentYear + 1) return sendJson(res, 400, { ok: false, error: 'Ano inválido.' });
    patch.year = y;
  }
  if (body.coverUrl !== undefined && body.cover_image !== undefined) return sendJson(res, 400, { ok: false, error: 'Use coverUrl ou cover_image, não ambos.' });
  if (body.coverUrl !== undefined) patch.coverUrl = String(body.coverUrl).trim();
  if (body.cover_image !== undefined) patch.coverUrl = String(body.cover_image).trim();
  if (body.description !== undefined) patch.description = String(body.description).trim().slice(0, 5000);
  if (body.type !== undefined) {
    const t = String(body.type).trim().toLowerCase();
    if (!['album', 'ep', 'single', 'compilation'].includes(t)) return sendJson(res, 400, { ok: false, error: 'type inválido.' });
    patch.type = t;
  }
  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') return sendJson(res, 400, { ok: false, error: 'published deve ser booleano.' });
    patch.published = body.published;
  }

  if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'Nada a atualizar.' });

  try {
    const updated = await db.update(albums).set(patch).where(eq(albums.id, albumId)).returning();
    if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    try { await audit('album.update', { actor: session.user, target: albumId, metadata: patch }); }
    catch (e) { console.warn('[admin] audit album.update falhou:', e.message); }
    return sendJson(res, 200, { ok: true, album: updated[0] });
  } catch (err) {
    if (err.code === '23505') return sendJson(res, 409, { ok: false, error: 'Slug já existe.' });
    throw err;
  }
}

async function handleDeleteAlbum(req, res, session) {
  const albumId = String(req.query.id || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${albumId}))`);

      const [album] = await tx.select({ id: albums.id }).from(albums).where(eq(albums.id, albumId)).limit(1);
      if (!album) { const err = new Error('ALBUM_NOT_FOUND'); err.code = 'ALBUM_NOT_FOUND'; throw err; }

      await tx.delete(tracks).where(eq(tracks.albumId, albumId));
      await tx.delete(albums).where(eq(albums.id, albumId));
    });
  } catch (err) {
    if (err.code === 'ALBUM_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    throw err;
  }

  try { await audit('album.delete', { actor: session.user, target: albumId }); }
  catch (e) { console.warn('[admin] audit album.delete falhou:', e.message); }

  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// FAIXAS
// ─────────────────────────────────────────────────────────────
function validateDuration(v) {
  if (v === undefined || v === null) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s) return false;
  return /^(\d{1,3}):([0-5]\d)$/.test(s);
}

function durationToSeconds(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,3}):([0-5]\d)$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

async function handleListTracks(req, res) {
  const albumId = String(req.query.albumId || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'albumId inválido.' });
  const rows = await db.select().from(tracks).where(eq(tracks.albumId, albumId)).orderBy(asc(tracks.trackNumber));
  return sendJson(res, 200, { ok: true, tracks: rows });
}

async function handleCreateTrack(req, res, session) {
  const body = parseBody(req);
  const albumId = String(body.albumId || body.album_id || '');
  const title = String(body.title || '').trim();
  if (!isUuid(albumId) || !title || title.length > 200) return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });
  if (!validateDuration(body.duration)) return sendJson(res, 400, { ok: false, error: 'Duração inválida (use mm:ss).' });

  const slug = createSlug(title);
  if (!slug) return sendJson(res, 400, { ok: false, error: 'Título gera um slug inválido.' });

  let created;
  try {
    created = await db.transaction(async (tx) => {
      const [album] = await tx.select({ artistId: albums.artistId }).from(albums).where(eq(albums.id, albumId)).limit(1);
      if (!album) { const err = new Error('ALBUM_NOT_FOUND'); err.code = 'ALBUM_NOT_FOUND'; throw err; }

      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${albumId}))`);

      const rows = await tx.select({ n: sql`COALESCE(MAX(${tracks.trackNumber}), 0)` })
        .from(tracks).where(eq(tracks.albumId, albumId));
      const nextNumber = Number(rows[0]?.n || 0) + 1;

      const [row] = await tx.insert(tracks).values({
        id: crypto.randomUUID(), albumId, artistId: album.artistId, title, slug,
        durationSeconds: durationToSeconds(body.duration),
        trackNumber: nextNumber, status: 'DRAFT'
      }).returning();
      return row;
    });
  } catch (err) {
    if (err.code === 'ALBUM_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    if (err.code === '23505') return sendJson(res, 409, { ok: false, error: 'Slug de faixa já existe. Ajuste o título.' });
    throw err;
  }

  try { await audit('track.create', { actor: session.user, target: created.id, metadata: { albumId, title } }); }
  catch (e) { console.warn('[admin] audit track.create falhou:', e.message); }

  return sendJson(res, 200, { ok: true, track: created });
}

async function assertPathFromConsumedIntent(path, adminUser) {
  const [row] = await db.select({ id: uploadIntents.id }).from(uploadIntents)
    .where(and(
      eq(uploadIntents.path, path),
      eq(uploadIntents.adminUser, adminUser),
      sql`${uploadIntents.consumedAt} IS NOT NULL`
    )).limit(1);
  return Boolean(row);
}

async function handleUpdateTrack(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const body = parseBody(req);
  const patch = {};

  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 200) return sendJson(res, 400, { ok: false, error: 'Título inválido.' });
    const newSlug = createSlug(t);
    if (!newSlug) return sendJson(res, 400, { ok: false, error: 'Título gera um slug inválido.' });
    patch.title = t; patch.slug = newSlug;
  }
  if (body.duration !== undefined) {
    if (!validateDuration(body.duration)) return sendJson(res, 400, { ok: false, error: 'Duração inválida (use mm:ss).' });
    patch.durationSeconds = durationToSeconds(body.duration);
  }
  if (body.status !== undefined) {
    if (body.status !== 'PUBLISHED' && body.status !== 'DRAFT') return sendJson(res, 400, { ok: false, error: 'Status deve ser PUBLISHED ou DRAFT.' });
    patch.status = body.status;
  }
  if (body.published !== undefined) {
    if (typeof body.published !== 'boolean') return sendJson(res, 400, { ok: false, error: 'published deve ser booleano.' });
    if (body.status === undefined) patch.status = body.published ? 'PUBLISHED' : 'DRAFT';
  }

  const fullP = body.fullPath !== undefined ? body.fullPath : body.full_path;
  const previewP = body.previewPath !== undefined ? body.previewPath : body.preview_path;

  if (fullP !== undefined) {
    const p = String(fullP).trim();
    if (!p) return sendJson(res, 400, { ok: false, error: 'fullPath vazio.' });
    let kind;
    try { kind = inferKindFromKey(p); } catch { return sendJson(res, 400, { ok: false, error: 'fullPath com formato inválido.' }); }
    if (kind !== 'audio-full') return sendJson(res, 400, { ok: false, error: 'fullPath deve ser audio-full.' });
    const allowed = await assertPathFromConsumedIntent(p, session.user);
    if (!allowed) return sendJson(res, 400, { ok: false, error: 'fullPath não corresponde a um upload confirmado. Use upload-confirm.' });
    let exists;
    try { exists = await getObjectMetadata(p); } catch { return sendJson(res, 502, { ok: false, error: 'Falha ao consultar Storage.' }); }
    if (!exists) return sendJson(res, 400, { ok: false, error: 'fullPath não existe no Storage.' });
    patch.fullPath = p; patch.streamKey = p;
  }

  if (previewP !== undefined) {
    const p = String(previewP).trim();
    if (!p) return sendJson(res, 400, { ok: false, error: 'previewPath vazio.' });
    let kind;
    try { kind = inferKindFromKey(p); } catch { return sendJson(res, 400, { ok: false, error: 'previewPath com formato inválido.' }); }
    if (kind !== 'audio-preview') return sendJson(res, 400, { ok: false, error: 'previewPath deve ser audio-preview.' });
    const allowed = await assertPathFromConsumedIntent(p, session.user);
    if (!allowed) return sendJson(res, 400, { ok: false, error: 'previewPath não corresponde a um upload confirmado. Use upload-confirm.' });
    let exists;
    try { exists = await getObjectMetadata(p); } catch { return sendJson(res, 502, { ok: false, error: 'Falha ao consultar Storage.' }); }
    if (!exists) return sendJson(res, 400, { ok: false, error: 'previewPath não existe no Storage.' });
    patch.previewPath = p; patch.previewKey = p;
  }

  if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'Nada a atualizar.' });

  try {
    const updated = await db.update(tracks).set(patch).where(eq(tracks.id, trackId)).returning();
    if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
    try { await audit('track.update', { actor: session.user, target: trackId, metadata: patch }); }
    catch (e) { console.warn('[admin] audit track.update falhou:', e.message); }
    return sendJson(res, 200, { ok: true, track: updated[0] });
  } catch (err) {
    if (err.code === '23505') return sendJson(res, 409, { ok: false, error: 'Slug de faixa já existe. Ajuste o título.' });
    throw err;
  }
}

async function handleDeleteTrack(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ albumId: tracks.albumId }).from(tracks).where(eq(tracks.id, trackId)).for('update');
      if (!row) { const err = new Error('TRACK_NOT_FOUND'); err.code = 'TRACK_NOT_FOUND'; throw err; }

      if (row.albumId) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${row.albumId}))`);

      const deleted = await tx.delete(tracks).where(eq(tracks.id, trackId)).returning({ id: tracks.id });
      if (!deleted.length) { const err = new Error('TRACK_NOT_FOUND'); err.code = 'TRACK_NOT_FOUND'; throw err; }
    });
  } catch (err) {
    if (err.code === 'TRACK_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
    throw err;
  }

  try { await audit('track.delete', { actor: session.user, target: trackId }); }
  catch (e) { console.warn('[admin] audit track.delete falhou:', e.message); }

  return sendJson(res, 200, { ok: true });
}

async function handleReorderTracks(req, res, session) {
  const body = parseBody(req);
  const order = body.order;
  if (!Array.isArray(order) || order.length === 0) return sendJson(res, 400, { ok: false, error: 'Ordem inválida.' });

  const albumId = String(body.albumId || req.query.albumId || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'albumId inválido.' });

  const ids = new Set();
  const numbers = new Set();
  for (const item of order) {
    const id = String(item?.id || '');
    const n = Number(item?.track_number);
    if (!isUuid(id) || !Number.isInteger(n) || n < 1) return sendJson(res, 400, { ok: false, error: 'Dados na ordem inválidos.' });
    if (ids.has(id) || numbers.has(n)) return sendJson(res, 400, { ok: false, error: 'Itens duplicados na ordem.' });
    ids.add(id); numbers.add(n);
  }

  const N = order.length;
  for (let i = 1; i <= N; i++) {
    if (!numbers.has(i)) return sendJson(res, 400, { ok: false, error: `Numeração deve ser sequencial de 1 a ${N}.` });
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${albumId}))`);

      const currentTracks = await tx.select({ id: tracks.id }).from(tracks).where(eq(tracks.albumId, albumId));
      if (currentTracks.length !== ids.size) { const err = new Error('TRACK_COUNT_MISMATCH'); err.code = 'TRACK_COUNT_MISMATCH'; throw err; }
      for (const t of currentTracks) {
        if (!ids.has(t.id)) { const err = new Error('TRACK_MISSING'); err.code = 'TRACK_MISSING'; throw err; }
      }

      await tx.select({ id: tracks.id }).from(tracks).where(eq(tracks.albumId, albumId)).for('update');

      for (const item of order) {
        await tx.update(tracks).set({ trackNumber: item.track_number }).where(eq(tracks.id, item.id));
      }
    });
  } catch (err) {
    if (err.code === 'TRACK_COUNT_MISMATCH') return sendJson(res, 400, { ok: false, error: 'A lista deve conter todas as faixas do álbum, sem omissões.' });
    if (err.code === 'TRACK_MISSING') return sendJson(res, 400, { ok: false, error: 'A lista contém faixas que não pertencem a este álbum.' });
    throw err;
  }

  try { await audit('track.reorder', { actor: session.user, metadata: { albumId, count: order.length } }); }
  catch (e) { console.warn('[admin] audit track.reorder falhou:', e.message); }

  return sendJson(res, 200, { ok: true });
}

async function handleUpdateLyrics(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const lyrics = parseBody(req).lyrics;
  if (lyrics !== null && typeof lyrics !== 'string' && !Array.isArray(lyrics)) return sendJson(res, 400, { ok: false, error: 'Letra inválida.' });
  if (typeof lyrics === 'string' && Buffer.byteLength(lyrics, 'utf8') > MAX_LYRICS_BYTES) return sendJson(res, 413, { ok: false, error: 'Letra muito longa.' });
  if (Array.isArray(lyrics)) {
    if (lyrics.length > MAX_LYRICS_LINES) return sendJson(res, 413, { ok: false, error: 'Número excessivo de linhas.' });
    let totalBytes = 0;
    for (const l of lyrics) {
      if (!l || typeof l !== 'object' || Array.isArray(l)) return sendJson(res, 400, { ok: false, error: 'Item de letra inválido.' });
      if (typeof l.text !== 'string') return sendJson(res, 400, { ok: false, error: 'Texto da letra deve ser string.' });
      if (l.text.length > MAX_LYRICS_LINE_LENGTH) return sendJson(res, 413, { ok: false, error: 'Linha de letra muito longa.' });
      totalBytes += Buffer.byteLength(l.text, 'utf8');
      if (totalBytes > MAX_LYRICS_BYTES) return sendJson(res, 413, { ok: false, error: 'Letra muito longa.' });
      if (l.time !== undefined && (typeof l.time !== 'number' || !Number.isFinite(l.time) || l.time < 0)) return sendJson(res, 400, { ok: false, error: 'Timestamp da letra inválido.' });
    }
  }

  const updated = await db.update(tracks).set({ lyrics }).where(eq(tracks.id, trackId)).returning();
  if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

  try { await audit('track.lyrics.update', { actor: session.user, target: trackId }); }
  catch (e) { console.warn('[admin] audit track.lyrics.update falhou:', e.message); }

  return sendJson(res, 200, { ok: true, track: updated[0] });
}

// ─────────────────────────────────────────────────────────────
// STORAGE / DOWNLOADS
// ─────────────────────────────────────────────────────────────
async function handleStorageConfig(req, res, session) {
  try { return sendJson(res, 200, getPublicR2Config()); }
  catch (err) { return sendJson(res, 503, { ok: false, error: err.message, code: err.code }); }
}

async function handleDownloadUrl(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  if (!track || !track.fullPath) return sendJson(res, 404, { ok: false, error: 'Áudio não encontrado.' });

  try {
    const kind = inferKindFromKey(track.fullPath);
    if (kind !== 'audio-full') return sendJson(res, 403, { ok: false, error: 'Caminho não é áudio completo.' });
  } catch { return sendJson(res, 400, { ok: false, error: 'Caminho inválido.' }); }

  try {
    const filename = `${sanitizeFilename(track.title)}.mp3`;
    const { url } = await createSignedDownloadUrl(track.fullPath, DOWNLOAD_TTL_SEC, filename);
    try { await audit('download.single', { actor: session.user, target: trackId }); } catch {}
    return sendJson(res, 200, { ok: true, url, filename });
  } catch {
    return sendJson(res, 502, { ok: false, error: 'Falha ao gerar link.' });
  }
}

async function handleDownloadAlbum(req, res, session) {
  const albumId = String(req.query.id || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const rows = await db.select().from(tracks).where(eq(tracks.albumId, albumId)).orderBy(asc(tracks.trackNumber));
  const results = [];
  const queue = rows.slice();
  const CONCURRENCY = 3;

  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      if (!t.fullPath) { results.push({ id: t.id, title: t.title, url: null, filename: null }); continue; }
      try {
        const kind = inferKindFromKey(t.fullPath);
        if (kind !== 'audio-full') { results.push({ id: t.id, title: t.title, url: null, filename: null, error: 'Caminho inválido' }); continue; }
      } catch {
        results.push({ id: t.id, title: t.title, url: null, filename: null, error: 'Caminho inválido' });
        continue;
      }
      try {
        const filename = `${sanitizeFilename(t.title)}.mp3`;
        const { url } = await createSignedDownloadUrl(t.fullPath, DOWNLOAD_TTL_SEC, filename);
        results.push({ id: t.id, title: t.title, url, filename });
      } catch {
        results.push({ id: t.id, title: t.title, url: null, filename: null, error: 'Falha ao gerar link' });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const byId = new Map(results.map(r => [r.id, r]));
  const ordered = rows.map(r => byId.get(r.id)).filter(Boolean);

  try { await audit('download.album', { actor: session.user, target: albumId, metadata: { count: ordered.filter(u => u.url).length } }); }
  catch (e) { console.warn('[admin] audit download.album falhou:', e.message); }

  return sendJson(res, 200, { ok: true, tracks: ordered });
}

// ─────────────────────────────────────────────────────────────
// VENDAS / AUDITORIA / HASH
// ─────────────────────────────────────────────────────────────
async function handleGetSales(req, res) {
  try {
    const requestedDays = String(req.query?.days || 'all');
    const allowedPeriods = new Set(['all', '7', '30', '90', '365']);
    if (!allowedPeriods.has(requestedDays)) {
      return sendJson(res, 400, { ok: false, error: 'Período inválido.' });
    }

    const cutoff = requestedDays === 'all'
      ? null
      : new Date(Date.now() - Number(requestedDays) * 86400000).toISOString();
    const inPeriod = (column) => cutoff ? gte(column, cutoff) : undefined;

    const subscriptionBase = db.select({
      id: subscriptions.id,
      created_at: subscriptions.createdAt,
      plan: plans.name,
      rawStatus: subscriptions.status,
      current_period_end: subscriptions.currentPeriodEnd
    }).from(subscriptions)
      .leftJoin(plans, eq(plans.id, subscriptions.planId));
    const subscriptionsRows = cutoff
      ? await subscriptionBase.where(inPeriod(subscriptions.createdAt)).orderBy(desc(subscriptions.createdAt)).limit(500)
      : await subscriptionBase.orderBy(desc(subscriptions.createdAt)).limit(500);

    const rentalBase = db.select({
      id: rentals.id,
      created_at: rentals.createdAt,
      track_id: rentals.trackId,
      album_id: rentals.albumId,
      expires_at: rentals.expiresAt,
      status: rentals.status,
      amount_cents: orderItems.unitPriceCents,
      quantity: orderItems.quantity
    }).from(rentals)
      .leftJoin(orderItems, eq(orderItems.orderId, rentals.orderId));
    const rentalsRows = cutoff
      ? await rentalBase.where(inPeriod(rentals.createdAt)).orderBy(desc(rentals.createdAt)).limit(500)
      : await rentalBase.orderBy(desc(rentals.createdAt)).limit(500);

    const paymentBase = db.select({
      id: paymentsEvents.id,
      created_at: paymentsEvents.createdAt,
      processed_at: paymentsEvents.processedAt,
      failure_reason: paymentsEvents.failureReason,
      event_type: paymentsEvents.eventType
    }).from(paymentsEvents);
    const paymentRowsRaw = cutoff
      ? await paymentBase.where(inPeriod(paymentsEvents.createdAt)).orderBy(desc(paymentsEvents.createdAt)).limit(500)
      : await paymentBase.orderBy(desc(paymentsEvents.createdAt)).limit(500);
    const paymentRows = paymentRowsRaw.map((row) => ({ ...row, id: String(row.id) }));

    const orderBase = db.select({
      id: orders.id,
      status: orders.status,
      totalCents: orders.totalCents,
      createdAt: orders.createdAt,
      userId: orders.userId,
      paidAt: orders.paidAt
    }).from(orders);
    const orderRows = cutoff
      ? await orderBase.where(inPeriod(orders.createdAt)).orderBy(desc(orders.createdAt)).limit(500)
      : await orderBase.orderBy(desc(orders.createdAt)).limit(500);

    const aggregateResult = await db.execute(drizzleSql`
      SELECT
        (SELECT COUNT(*) FROM subscriptions s
          WHERE (${cutoff}::timestamptz IS NULL OR s.created_at >= ${cutoff}::timestamptz))::int AS subscriptions_total,
        (SELECT COUNT(*) FROM subscriptions s
          WHERE s.status = 'ACTIVE'
            AND (s.current_period_end IS NULL OR s.current_period_end > NOW())
            AND (${cutoff}::timestamptz IS NULL OR s.created_at >= ${cutoff}::timestamptz))::int AS subscriptions_active,
        (SELECT COUNT(*) FROM rentals r
          WHERE (${cutoff}::timestamptz IS NULL OR r.created_at >= ${cutoff}::timestamptz))::int AS rentals_total,
        (SELECT COALESCE(SUM(oi.unit_price_cents * oi.quantity), 0)
          FROM orders o JOIN order_items oi ON oi.order_id = o.id
          WHERE o.status = 'PAID' AND oi.product_type = 'RENTAL'
            AND (${cutoff}::timestamptz IS NULL OR o.created_at >= ${cutoff}::timestamptz))::bigint AS rental_revenue_cents,
        (SELECT COUNT(*) FROM payments_events pe
          WHERE (${cutoff}::timestamptz IS NULL OR pe.created_at >= ${cutoff}::timestamptz))::int AS payments_total,
        (SELECT COUNT(*) FROM payments_events pe
          WHERE pe.failure_reason IS NOT NULL
            AND (${cutoff}::timestamptz IS NULL OR pe.created_at >= ${cutoff}::timestamptz))::int AS payments_failed,
        (SELECT COUNT(*) FROM payments_events pe
          WHERE pe.processed_at IS NULL
            AND (${cutoff}::timestamptz IS NULL OR pe.created_at >= ${cutoff}::timestamptz))::int AS payments_pending
    `);
    const aggregate = aggregateResult.rows?.[0] || aggregateResult[0] || {};

    const normalizedSubscriptions = subscriptionsRows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      plan: row.plan || '—',
      status: row.rawStatus === 'ACTIVE' ? 'authorized'
        : row.rawStatus === 'PENDING' ? 'pending'
        : row.rawStatus === 'PAUSED' ? 'paused'
        : row.rawStatus === 'CANCELLED' ? 'canceled'
        : String(row.rawStatus || '').toLowerCase(),
      current_period_end: row.current_period_end
    }));

    const normalizedRentals = rentalsRows.map((row) => ({
      ...row,
      amount_cents: Number(row.amount_cents || 0) * Number(row.quantity || 1)
    }));

    return sendJson(res, 200, {
      ok: true,
      period: requestedDays,
      subscriptions: normalizedSubscriptions,
      rentals: normalizedRentals,
      payments: paymentRows,
      sales: orderRows,
      summary: {
        subscriptions: {
          total: Number(aggregate.subscriptions_total || 0),
          active: Number(aggregate.subscriptions_active || 0)
        },
        rentals: {
          total: Number(aggregate.rentals_total || 0),
          revenueCents: Number(aggregate.rental_revenue_cents || 0)
        },
        payments: {
          total: Number(aggregate.payments_total || 0),
          failed: Number(aggregate.payments_failed || 0),
          pending: Number(aggregate.payments_pending || 0)
        }
      }
    });
  } catch (err) {
    console.error('[admin] erro vendas:', err);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível carregar as vendas.' });
  }
}

async function handleGetAudit(req, res) {
  try {
    const rows = await db.select().from(adminAudit).orderBy(desc(adminAudit.createdAt)).limit(100);
    return sendJson(res, 200, { ok: true, audit: rows });
  } catch (err) {
    console.error('[admin] erro auditoria:', err);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível carregar a auditoria.' });
  }
}

async function handleGenHash(req, res, session) {
  const body = parseBody(req);
  const password = body.password !== undefined ? String(body.password) : '';
  if (!password) return sendJson(res, 400, { ok: false, error: 'Envie { "password": "..." } no corpo.' });
  if (password.length < 8 || password.length > 200) return sendJson(res, 400, { ok: false, error: 'Senha deve ter entre 8 e 200 caracteres.' });
  try {
    const hash = await generateScryptHash(password);
    try { await audit('admin.gen_hash', { actor: session.user }); } catch {}
    return sendJson(res, 200, { ok: true, hash });
  } catch (err) {
    console.error('[admin] gen-hash falhou:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Falha ao gerar hash.' });
  }
}

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────
function verifySession(req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyHmac(token, getSessionSecret(), SESSION_MAX_AGE * 1000);
  if (!payload) return null;
  const expectedUser = String(process.env.ADMIN_USER || '').trim();
  if (!expectedUser || payload.user !== expectedUser) return null;
  return payload;
}

function parseAction(query) {
  const raw = String(query?.action || '').trim().toLowerCase();
  return VALID_ACTIONS.has(raw) ? raw : null;
}

function createSlug(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function sanitizeFilename(s) {
  return String(s || 'audio')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._ -]+/g, '_')
    .trim() || 'audio';
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(s || ''));
}

function addDaysIso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}
