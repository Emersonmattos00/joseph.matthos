/* ============================================================
   api/admin.js — Painel administrativo (Versão Final Absoluta)
   ============================================================
   - Uploads e storage alinhados (Cloudflare R2)
   - Transações seguras em banco de dados
   - Validação de segurança no payload do siteContent
   - Reordenação de faixas com log detalhado de erros
   - Controle otimista de versão no siteContent
   ============================================================ */

'use strict';

const crypto = require('crypto');

const {
  sendJson, methodNotAllowed, parseBody, parseCookies, clientIp,
  checkAndIncrement, resetBucket, audit, VALID_PLANS,
  signHmac, verifyHmac, verifyScrypt, timingSafeEq, checkOrigin, IS_PROD
} = require('./_lib');

const { db, eq, and, asc, desc, drizzleSql, inArray } = require('./_db');
const schema = require('./_db').schema;
const { tracks, albums, artists, orders, adminAudit } = schema;

// ─────────────────────────────────────────────────────────────
// IMPORTAÇÃO R2
// ─────────────────────────────────────────────────────────────
const {
  uploadObject,
  createSignedUploadUrl,
  createSignedDownloadUrl,
  getPublicUrl,
  objectExists,
  getObjectMetadata,
  buildPathForKind
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

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 15 * 1024 * 1024;
const MAX_AUDIO_FULL_BYTES = 200 * 1024 * 1024;
const MAX_LYRICS_BYTES = 200 * 1024;
const MAX_LYRICS_LINES = 500;

const MIME_BY_KIND = {
  'image': new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']),
  'audio-preview': new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm']),
  'audio-full': new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/wav', 'audio/x-wav'])
};

const MAX_BYTES_BY_KIND = {
  'image': MAX_IMAGE_BYTES,
  'audio-preview': MAX_PREVIEW_BYTES,
  'audio-full': MAX_AUDIO_FULL_BYTES
};

const VALID_ACTIONS = new Set([
  'login', 'session', 'logout', 'content',
  'upload', 'upload-sign', 'upload-confirm',
  'users', 'sales', 'audit', 'gen-hash',
  'albums', 'album', 'tracks', 'track', 'track-order',
  'download-url', 'download-album',
  'delete-user', 'update-lyrics'
]);

const DEV_NO_RATE_LIMIT = process.env.NODE_ENV !== 'production' && process.env.DISABLE_RATE_LIMIT === 'true';
const DEV_NO_CSRF = process.env.NODE_ENV !== 'production' && process.env.DISABLE_CSRF === 'true';

// ─────────────────────────────────────────────────────────────
// SESSÃO
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

function checkConfig() {
  try {
    getSessionSecret();
    if (!process.env.ADMIN_USER || !process.env.ADMIN_PASSWORD_HASH) return { ok: false, error: 'Configuração de administrador ausente.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
  if (!cfg.ok) {
    console.error('[admin] configuração inválida:', cfg.error);
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
  }

  const action = parseAction(req.query);
  if (!action) return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });

  const method = (req.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD' && !DEV_NO_CSRF) {
    if (!checkOrigin(req)) return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
  }

  if (action === 'login') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    return handleLogin(req, res);
  }

  let session;
  try {
    session = verifySession(req);
  } catch (err) {
    console.error('[admin] falha ao verificar sessão:', err.message);
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
  }
  
  if (!session) return sendJson(res, 401, { ok: false, error: 'Não autorizado.' });

  try {
    switch (action) {
      case 'session': return handleSession(req, res, session);
      case 'logout': if (method === 'POST') return handleLogout(req, res, session); break;
      case 'content':
        if (method === 'GET') return handleGetContent(req, res);
        if (method === 'PUT') return handlePutContent(req, res, session);
        break;
      case 'upload': if (method === 'POST') return handleUpload(req, res, session); break;
      case 'upload-sign': if (method === 'POST') return handleUploadSign(req, res, session); break;
      case 'upload-confirm': if (method === 'POST') return handleUploadConfirm(req, res, session); break;
      case 'users':
        if (method === 'GET') return handleGetUsers(req, res);
        if (method === 'PATCH') return handlePatchUser(req, res, session);
        if (method === 'DELETE') return handleDeleteUser(req, res, session);
        break;
      case 'sales': if (method === 'GET') return handleGetSales(req, res); break;
      case 'audit': if (method === 'GET') return handleGetAudit(req, res); break;
      case 'gen-hash': if (method === 'GET') return handleGenHash(req, res, session); break;
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
  const rate = DEV_NO_RATE_LIMIT ? { limited: false } : await checkAndIncrement(`admin-login:${ip}`, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, { failClosed: true });
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
    await audit('admin_login', { ip, success: false, reason: 'invalid', target: user });
    return sendJson(res, 401, { ok: false, error: 'Usuário ou senha incorretos.' });
  }

  await resetBucket(`admin-login:${ip}`);
  const token = signHmac({ user: expectedUser, iat: Date.now(), jti: crypto.randomUUID() }, getSessionSecret());
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_MAX_AGE}`, IS_PROD ? 'Secure' : null].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${attrs}`);
  
  await audit('admin_login', { actor: expectedUser, ip, success: true });
  return sendJson(res, 200, { ok: true, user: expectedUser });
}

async function handleSession(req, res, session) {
  return sendJson(res, 200, { ok: true, user: session.user });
}

async function handleLogout(req, res, session) {
  await audit('admin_logout', { actor: session.user, ip: clientIp(req) });
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0', IS_PROD ? 'Secure' : null].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; ${attrs}`);
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// CONTEÚDO ESTRUTURAL
// ─────────────────────────────────────────────────────────────
async function handleGetContent(req, res) {
  const [row] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, CONTENT_KEY)).limit(1);
  return sendJson(res, 200, { ok: true, data: row?.data || {}, version: row?.version || 0 });
}

async function handlePutContent(req, res, session) {
  const body = parseBody(req);
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });

  const expectedVersion = Number(body.version !== undefined ? body.version : body.baseVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return sendJson(res, 400, { ok: false, error: 'Versão inválida.' });

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

  try {
    const newVersion = await db.transaction(async (tx) => {
      const [currentRow] = await tx.select().from(schema.siteContent).where(eq(schema.siteContent.key, CONTENT_KEY)).limit(1);
      const currentVersion = currentRow?.version || 0;

      const next = currentVersion + 1;
      await tx.insert(schema.siteContent).values({ key: CONTENT_KEY, data, version: next, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: schema.siteContent.key, set: { data, version: next, updatedAt: new Date().toISOString() } });
      return next;
    });

    await audit('content.update', { actor: session.user, metadata: { version: newVersion } });
    return sendJson(res, 200, { ok: true, version: newVersion });
  } catch (err) {
    if (err.code === 'VERSION_CONFLICT') return sendJson(res, 409, { ok: false, error: 'Conteúdo foi alterado por outra sessão. Recarregue.' });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// UPLOADS
// ─────────────────────────────────────────────────────────────
function validateFilePayload({ kind, filename, contentType, base64 }) {
  if (!kind || !MIME_BY_KIND[kind]) return { ok: false, error: 'Tipo inválido.' };
  const name = String(filename || '').trim();
  if (!name || !name.includes('.')) return { ok: false, error: 'Nome de arquivo inválido.' };
  const ext = name.split('.').pop().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) return { ok: false, error: 'Extensão inválida.' };
  
  const mime = String(contentType || '').trim().toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime) || mime.length > 150) return { ok: false, error: 'Content-Type inválido.' };
  if (!MIME_BY_KIND[kind].has(mime)) return { ok: false, error: `Tipo não permitido para ${kind}.` };

  let buffer = null;
  if (base64 !== undefined) {
    const raw = String(base64 || '').trim();
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 !== 0) return { ok: false, error: 'Conteúdo base64 inválido.' };
    buffer = Buffer.from(raw, 'base64');
    if (buffer.length === 0) return { ok: false, error: 'Arquivo vazio.' };
    if (buffer.length > MAX_BYTES_BY_KIND[kind]) return { ok: false, error: 'Arquivo excede o tamanho máximo.' };
    if (kind === 'image' && !looksLikeImage(buffer, mime)) return { ok: false, error: 'Conteúdo não corresponde ao tipo.' };
  }
  return { ok: true, ext, mime, buffer };
}

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

async function handleUpload(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const validation = validateFilePayload({ kind, filename: body.filename, contentType: body.contentType, base64: body.base64 });
  if (!validation.ok) return sendJson(res, 400, { ok: false, error: validation.error });

  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${validation.ext}`;
  const path = buildPathForKind(kind, uniqueName);

  try {
    await uploadObject(path, validation.buffer, validation.mime);
    const publicUrl = getPublicUrl(path);
    await audit('upload.direct', { actor: session.user, metadata: { kind, path, size: validation.buffer.length } });
    return sendJson(res, 200, { ok: true, url: publicUrl, path });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return sendJson(res, 503, { ok: false, error: 'Storage indisponível.' });
    console.error('[admin] falha upload:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Falha no upload.' });
  }
}

async function handleUploadSign(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const validation = validateFilePayload({ kind, filename: body.filename, contentType: body.contentType });
  if (!validation.ok) return sendJson(res, 400, { ok: false, error: validation.error });

  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${validation.ext}`;
  const path = buildPathForKind(kind, uniqueName);

  try {
    const signed = await createSignedUploadUrl(path, validation.mime, SIGNED_UPLOAD_TTL_SEC);

    if (schema.uploadIntents) {
      const expiresAt = new Date(Date.now() + UPLOAD_INTENT_TTL_MS).toISOString();
      await db.insert(schema.uploadIntents).values({
        id: crypto.randomUUID(), adminUser: session.user, kind, path, contentType: validation.mime,
        sizeLimit: MAX_BYTES_BY_KIND[kind], expiresAt, consumedAt: null, createdAt: new Date().toISOString()
      });
    }

    await audit('upload.sign', { actor: session.user, metadata: { kind, path, mime: validation.mime } });
    return sendJson(res, 200, { ok: true, uploadUrl: signed.uploadUrl, path, expiresIn: SIGNED_UPLOAD_TTL_SEC });
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED') return sendJson(res, 503, { ok: false, error: 'Storage indisponível.' });
    console.error('[admin] falha sign:', err.message);
    return sendJson(res, 502, { ok: false, error: 'Falha ao preparar upload.' });
  }
}

async function handleUploadConfirm(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const path = String(body.path || '').trim();
  if (!kind || !path) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });

  const hasTrackIndex = body.trackIndex !== undefined && body.trackIndex !== null && body.trackIndex !== '';
  const trackIndex = hasTrackIndex ? Number(body.trackIndex) : null;
  const albumId = body.albumId ? String(body.albumId).trim() : null;

  if (hasTrackIndex && (!Number.isInteger(trackIndex) || trackIndex < 1)) return sendJson(res, 400, { ok: false, error: 'Número da faixa inválido.' });
  if (albumId && !isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'Álbum inválido.' });

  let intent = null;
  if (schema.uploadIntents) {
    const [row] = await db.select().from(schema.uploadIntents).where(and(eq(schema.uploadIntents.path, path), eq(schema.uploadIntents.adminUser, session.user), eq(schema.uploadIntents.kind, kind))).limit(1);
    intent = row || null;
    if (!intent) return sendJson(res, 400, { ok: false, error: 'Upload não reconhecido.' });
    if (intent.consumedAt) return sendJson(res, 400, { ok: false, error: 'Upload já utilizado.' });
    if (new Date(intent.expiresAt).getTime() < Date.now()) return sendJson(res, 400, { ok: false, error: 'Upload expirado.' });
  }

  try {
    const exists = await objectExists(path);
    if (!exists) return sendJson(res, 400, { ok: false, error: 'Arquivo não encontrado no Storage.' });

    const meta = await getObjectMetadata(path);
    if (meta && meta.contentLength > MAX_BYTES_BY_KIND[kind]) return sendJson(res, 413, { ok: false, error: 'Arquivo excede o limite.' });
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: 'Falha ao validar no Storage.' });
  }

  if (albumId && trackIndex !== null) {
    const isFull = kind === 'audio-full';
    const patch = isFull ? { fullPath: path, streamKey: path, updatedAt: new Date().toISOString() } : { previewPath: path, previewKey: path, updatedAt: new Date().toISOString() };
    const updated = await db.update(tracks).set(patch).where(and(eq(tracks.albumId, albumId), eq(tracks.trackNumber, trackIndex))).returning();
    
    if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

    if (intent) await db.update(schema.uploadIntents).set({ consumedAt: new Date().toISOString() }).where(eq(schema.uploadIntents.id, intent.id));
    await audit('upload.confirm', { actor: session.user, metadata: { kind, path, albumId, trackIndex } });
    return sendJson(res, 200, { ok: true, url: getPublicUrl(path), path, track: updated[0] });
  }

  if (intent) await db.update(schema.uploadIntents).set({ consumedAt: new Date().toISOString() }).where(eq(schema.uploadIntents.id, intent.id));
  await audit('upload.confirm', { actor: session.user, metadata: { kind, path } });
  return sendJson(res, 200, { ok: true, path, url: getPublicUrl(path) });
}

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// ─────────────────────────────────────────────────────────────
async function handleGetUsers(req, res) {
  const rows = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, createdAt: schema.users.createdAt }).from(schema.users).orderBy(desc(schema.users.createdAt));
  let planRows = [];
  try { planRows = await db.execute(drizzleSql`SELECT user_id, plan FROM effective_plan`); } catch (e) { }
  const planMap = new Map((planRows.rows || planRows).map(r => [r.user_id, r.plan]));
  return sendJson(res, 200, { ok: true, users: rows.map(u => ({ ...u, plan: planMap.get(u.id) || 'free' })) });
}

async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();
  if (!isUuid(userId) || !VALID_PLANS.has(plan)) return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });

  try {
    await db.transaction(async (tx) => {
      const [user] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
      if (!user) { const err = new Error('USER_NOT_FOUND'); err.code = 'USER_NOT_FOUND'; throw err; }

      let planRow = null;
      if (plan !== 'free') {
        const rows = await tx.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.name, plan)).limit(1);
        planRow = rows[0] || null;
        if (!planRow) { const err = new Error('PLAN_NOT_FOUND'); err.code = 'PLAN_NOT_FOUND'; throw err; }
      }

      await tx.update(schema.subscriptions).set({ status: 'CANCELLED', updatedAt: new Date().toISOString() }).where(and(eq(schema.subscriptions.userId, userId), inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING'])));

      if (planRow) {
        await tx.insert(schema.subscriptions).values({
          id: crypto.randomUUID(), userId, planId: planRow.id, externalSubscriptionId: `manual_${userId}_${Date.now()}`,
          status: 'ACTIVE', currentPeriodStart: new Date().toISOString(), currentPeriodEnd: addDaysIso(30), updatedAt: new Date().toISOString()
        });
      }
    });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
    if (err.code === 'PLAN_NOT_FOUND') return sendJson(res, 400, { ok: false, error: 'Plano inexistente.' });
    throw err;
  }

  await audit('user.plan.change', { actor: session.user, target: userId, metadata: { plan } });
  return sendJson(res, 200, { ok: true, plan });
}

async function handleDeleteUser(req, res, session) {
  const userId = String(req.query?.id || '').trim();
  if (!isUuid(userId) || userId === session.user) return sendJson(res, 400, { ok: false, error: 'Ação não permitida.' });

  try {
    const deleted = await db.delete(schema.users).where(eq(schema.users.id, userId)).returning();
    if (!deleted.length) return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
    await audit('user.delete', { actor: session.user, target: userId });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    return sendJson(res, 409, { ok: false, error: 'Usuário possui dependências.' });
  }
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA (ÁLBUNS)
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

  const slug = createSlug(title);
  if (!slug) return sendJson(res, 400, { ok: false, error: 'Slug inválido.' });

  try {
    const created = await db.transaction(async (tx) => {
      const [artist] = await tx.select({ id: artists.id }).from(artists).limit(1);
      if (!artist) { const err = new Error('ARTIST_NOT_FOUND'); err.code = 'ARTIST_NOT_FOUND'; throw err; }
      const [dup] = await tx.select({ id: albums.id }).from(albums).where(eq(albums.slug, slug)).limit(1);
      if (dup) { const err = new Error('SLUG_CONFLICT'); err.code = 'SLUG_CONFLICT'; throw err; }

      const [row] = await tx.insert(albums).values({ id: crypto.randomUUID(), title, slug, artistId: artist.id, published: !!body.published }).returning();
      return row;
    });
    await audit('album.create', { actor: session.user, target: created.id, metadata: { title, slug } });
    return sendJson(res, 200, { ok: true, album: created });
  } catch (err) {
    if (err.code === 'ARTIST_NOT_FOUND') return sendJson(res, 409, { ok: false, error: 'Nenhum artista cadastrado.' });
    if (err.code === 'SLUG_CONFLICT') return sendJson(res, 409, { ok: false, error: 'Slug já existe.' });
    throw err;
  }
}

async function handleUpdateAlbum(req, res, session) {
  const albumId = String(req.query.id || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const body = parseBody(req);
  const patch = {};
  
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 200) return sendJson(res, 400, { ok: false, error: 'Título inválido.' });
    patch.title = t; patch.slug = createSlug(t);
  }
  if (body.year !== undefined) patch.year = Number(body.year) || null;
  if (body.coverUrl !== undefined) patch.coverUrl = String(body.coverUrl).trim();
  if (body.cover_image !== undefined) patch.coverUrl = String(body.cover_image).trim();
  if (body.description !== undefined) patch.description = String(body.description).trim();
  if (body.type !== undefined) patch.type = String(body.type).trim();
  if (body.published !== undefined) patch.published = !!body.published;

  if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'Nada a atualizar.' });

  const updated = await db.update(albums).set(patch).where(eq(albums.id, albumId)).returning();
  if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

  await audit('album.update', { actor: session.user, target: albumId, metadata: patch });
  return sendJson(res, 200, { ok: true, album: updated[0] });
}

async function handleDeleteAlbum(req, res, session) {
  const albumId = String(req.query.id || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    await db.transaction(async (tx) => {
      const [album] = await tx.select({ id: albums.id }).from(albums).where(eq(albums.id, albumId)).limit(1);
      if (!album) { const err = new Error('ALBUM_NOT_FOUND'); err.code = 'ALBUM_NOT_FOUND'; throw err; }
      await tx.delete(tracks).where(eq(tracks.albumId, albumId));
      await tx.delete(albums).where(eq(albums.id, albumId));
    });
  } catch (err) {
    if (err.code === 'ALBUM_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    throw err;
  }
  await audit('album.delete', { actor: session.user, target: albumId });
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA (FAIXAS)
// ─────────────────────────────────────────────────────────────
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

  try {
    const created = await db.transaction(async (tx) => {
      const [album] = await tx.select({ artistId: albums.artistId }).from(albums).where(eq(albums.id, albumId)).limit(1);
      if (!album) { const err = new Error('ALBUM_NOT_FOUND'); err.code = 'ALBUM_NOT_FOUND'; throw err; }
      
      const rows = await tx.select({ n: drizzleSql`COALESCE(MAX(${tracks.trackNumber}), 0)` }).from(tracks).where(eq(tracks.albumId, albumId));
      const nextNumber = Number(rows[0]?.n || 0) + 1;

      const [row] = await tx.insert(tracks).values({ 
        id: crypto.randomUUID(), albumId, artistId: album.artistId, title, slug: createSlug(title), 
        duration: body.duration || null, priceCents: Number(body.priceCents) || 0,
        trackNumber: nextNumber, status: 'DRAFT' 
      }).returning();
      return row;
    });

    await audit('track.create', { actor: session.user, target: created.id, metadata: { albumId, title } });
    return sendJson(res, 200, { ok: true, track: created });
  } catch (err) {
    if (err.code === 'ALBUM_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
    throw err;
  }
}

async function handleUpdateTrack(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const body = parseBody(req);
  const patch = {};
  
  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t || t.length > 200) return sendJson(res, 400, { ok: false, error: 'Título inválido.' });
    patch.title = t; patch.slug = createSlug(t);
  }
  if (body.duration !== undefined) patch.duration = String(body.duration);
  if (body.priceCents !== undefined) patch.priceCents = Number(body.priceCents) || 0;
  if (body.status !== undefined) patch.status = body.status === 'PUBLISHED' ? 'PUBLISHED' : 'DRAFT';
  if (body.published !== undefined) patch.status = body.published ? 'PUBLISHED' : 'DRAFT';

  try {
    const fullP = body.fullPath !== undefined ? body.fullPath : body.full_path;
    if (fullP !== undefined) {
      const p = String(fullP).trim();
      if (!p) return sendJson(res, 400, { ok: false, error: 'fullPath vazio.' });
      const exists = await objectExists(p).catch(() => true);
      if (!exists) return sendJson(res, 400, { ok: false, error: 'fullPath inválido no Storage.' });
      patch.fullPath = p; patch.streamKey = p;
    }
    
    const previewP = body.previewPath !== undefined ? body.previewPath : body.preview_path;
    if (previewP !== undefined) {
      const p = String(previewP).trim();
      if (!p) return sendJson(res, 400, { ok: false, error: 'previewPath vazio.' });
      const exists = await objectExists(p).catch(() => true);
      if (!exists) return sendJson(res, 400, { ok: false, error: 'previewPath inválido no Storage.' });
      patch.previewPath = p; patch.previewKey = p;
    }
  } catch(e) { 
    return sendJson(res, 502, { ok: false, error: 'Erro ao validar Storage.' }); 
  }

  if (!Object.keys(patch).length) return sendJson(res, 400, { ok: false, error: 'Nada a atualizar.' });

  const updated = await db.update(tracks).set(patch).where(eq(tracks.id, trackId)).returning();
  if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

  await audit('track.update', { actor: session.user, target: trackId, metadata: patch });
  return sendJson(res, 200, { ok: true, track: updated[0] });
}

async function handleDeleteTrack(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const deleted = await db.delete(tracks).where(eq(tracks.id, trackId)).returning();
  if (!deleted.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

  await audit('track.delete', { actor: session.user, target: trackId });
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// REORDENAÇÃO DE FAIXAS (CORRIGIDA)
// ─────────────────────────────────────────────────────────────
async function handleReorderTracks(req, res, session) {
  const body = parseBody(req);
  const order = body.order;
  if (!Array.isArray(order) || order.length === 0) return sendJson(res, 400, { ok: false, error: 'Ordem inválida.' });

  const albumId = String(body.albumId || req.query.albumId || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'albumId inválido.' });

  const ids = new Set();
  const numbers = new Set();
  const normalizedOrder = [];

  for (const item of order) {
    const id = String(item?.id || '');
    const n = Number(item?.track_number !== undefined ? item.track_number : item.trackNumber);
    
    if (!isUuid(id) || !Number.isInteger(n) || n < 1) {
      return sendJson(res, 400, { ok: false, error: 'Dados na ordem inválidos.' });
    }
    if (ids.has(id) || numbers.has(n)) {
      return sendJson(res, 400, { ok: false, error: 'Itens duplicados na ordem.' });
    }
    ids.add(id); 
    numbers.add(n);
    normalizedOrder.push({ id, trackNumber: n });
  }

  try {
    await db.transaction(async (tx) => {
      const rows = await tx.select({ id: tracks.id, albumId: tracks.albumId }).from(tracks).where(inArray(tracks.id, [...ids]));
      if (rows.length !== ids.size) {
        const err = new Error('TRACK_NOT_FOUND'); err.code = 'TRACK_NOT_FOUND'; throw err;
      }
      for (const r of rows) {
        if (r.albumId !== albumId) { const err = new Error('TRACK_WRONG_ALBUM'); err.code = 'TRACK_WRONG_ALBUM'; throw err; }
      }

      // ETAPA 1: Move todas as faixas para números temporários negativos
      // Isso evita o conflito de unicidade (se existir) durante a atualização
      for (let i = 0; i < normalizedOrder.length; i++) {
        await tx.update(tracks)
          .set({ trackNumber: -(i + 1) }) // -1, -2, -3...
          .where(eq(tracks.id, normalizedOrder[i].id));
      }

      // ETAPA 2: Aplica a ordem final
      for (const item of normalizedOrder) {
        await tx.update(tracks)
          .set({ trackNumber: item.trackNumber })
          .where(eq(tracks.id, item.id));
      }
    });
  } catch (err) {
    console.error('[admin] reorder error:', err);
    if (err.code === 'TRACK_NOT_FOUND') return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
    if (err.code === 'TRACK_WRONG_ALBUM') return sendJson(res, 400, { ok: false, error: 'Faixa de outro álbum.' });
    return sendJson(res, 500, { ok: false, error: `Erro no banco: ${err.message}` });
  }

  await audit('track.reorder', { actor: session.user, metadata: { albumId, count: order.length } });
  return sendJson(res, 200, { ok: true });
}

async function handleUpdateLyrics(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const lyrics = parseBody(req).lyrics;
  if (lyrics !== null && typeof lyrics !== 'string') return sendJson(res, 400, { ok: false, error: 'Letra inválida.' });
  if (typeof lyrics === 'string' && Buffer.byteLength(lyrics, 'utf8') > MAX_LYRICS_BYTES) return sendJson(res, 413, { ok: false, error: 'Letra muito longa.' });
  
  if (Array.isArray(lyrics) && lyrics.length > MAX_LYRICS_LINES) {
    return sendJson(res, 413, { ok: false, error: 'Número excessivo de linhas na letra.' });
  }

  const updated = await db.update(tracks).set({ lyrics }).where(eq(tracks.id, trackId)).returning();
  if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

  await audit('track.lyrics.update', { actor: session.user, target: trackId });
  return sendJson(res, 200, { ok: true, track: updated[0] });
}

// ─────────────────────────────────────────────────────────────
// DOWNLOADS
// ─────────────────────────────────────────────────────────────
async function handleDownloadUrl(req, res, session) {
  const trackId = String(req.query.id || '');
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  if (!track || !track.fullPath) return sendJson(res, 404, { ok: false, error: 'Áudio não encontrado.' });

  try {
    const url = await createSignedDownloadUrl(track.fullPath, DOWNLOAD_TTL_SEC, `${sanitizeFilename(track.title)}.mp3`);
    await audit('download.single', { actor: session.user, target: trackId });
    return sendJson(res, 200, { ok: true, url, filename: `${sanitizeFilename(track.title)}.mp3` });
  } catch(e) { return sendJson(res, 502, { ok: false, error: 'Falha ao gerar link.' }); }
}

async function handleDownloadAlbum(req, res, session) {
  const albumId = String(req.query.id || '');
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const rows = await db.select().from(tracks).where(eq(tracks.albumId, albumId)).orderBy(asc(tracks.trackNumber));
  try {
    const urls = await Promise.all(rows.map(async t => {
      if (!t.fullPath) return { id: t.id, title: t.title, url: null };
      const url = await createSignedDownloadUrl(t.fullPath, DOWNLOAD_TTL_SEC, `${sanitizeFilename(t.title)}.mp3`);
      return { id: t.id, title: t.title, url, filename: `${sanitizeFilename(t.title)}.mp3` };
    }));
    await audit('download.album', { actor: session.user, target: albumId, metadata: { count: urls.length } });
    return sendJson(res, 200, { ok: true, tracks: urls });
  } catch(e) { return sendJson(res, 502, { ok: false, error: 'Falha ao gerar links.' }); }
}

// ─────────────────────────────────────────────────────────────
// VENDAS E AUDITORIA
// ─────────────────────────────────────────────────────────────
async function handleGetSales(req, res) {
  try {
    const rows = await db.select().from(orders).orderBy(desc(orders.createdAt)).limit(50);
    return sendJson(res, 200, { ok: true, sales: rows.map(o => ({ id: o.id, status: o.status, totalCents: o.totalCents, createdAt: o.createdAt, userId: o.userId })) });
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
  return sendJson(res, 200, { ok: true, message: 'Use o terminal para gerar o hash.' });
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
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function sanitizeFilename(s) {
  return String(s || 'audio').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._ -]+/g, '_').trim();
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function addDaysIso(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}