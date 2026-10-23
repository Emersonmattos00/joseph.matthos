/* ============================================================
   api/admin.js — Painel administrativo (Versão Final)
   ============================================================ */

'use strict';

const crypto = require('crypto');

const {
  sendJson, methodNotAllowed, parseBody, parseCookies, clientIp,
  checkAndIncrement, resetBucket, audit, VALID_PLANS,
  signHmac, verifyHmac, verifyScrypt, timingSafeEq, checkOrigin, IS_PROD
} = require('./_lib');

const { db, eq, and, or, asc, desc, sql, inArray } = require('./_db');
const schema = require('./_db').schema;

const { tracks, albums, artists } = schema;

const {
  uploadObject, createSignedUploadUrl: b2CreateSignedUploadUrl,
  createSignedDownloadUrl: b2CreateSignedDownloadUrl,
  getPublicUrl: b2GetPublicUrl, objectExists: b2ObjectExists
} = require('./_storage');


// Constantes
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

const BUCKET_BY_KIND = {
  'image': 'site-assets',
  'audio-preview': 'audio-preview',
  'audio-full': 'audio-premium'
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

function getSessionSecret() {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET ausente.');
  if (secret.length < MIN_SESSION_SECRET_LENGTH) throw new Error(`ADMIN_SESSION_SECRET muito curto.`);
  return secret;
}

module.exports = async function handler(req, res) {
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH, DELETE');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

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

  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { ok: false, error: 'Não autorizado.' });

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

  // Logs seguros de depuração (apenas para o servidor)
  console.log('[admin/login] Tentativa para usuário:', user);
  console.log('[admin/login] userOk:', userOk, 'passOk:', passOk);

  if (!userOk || !passOk) {
    await audit('admin_login', { ip, success: false, reason: 'invalid', target: user });
    return sendJson(res, 401, { ok: false, error: 'Usuário ou senha incorretos.' });
  }

  await resetBucket(`admin-login:${ip}`);
  const token = signHmac({ user: expectedUser, iat: Date.now() }, getSessionSecret());
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_MAX_AGE}`, IS_PROD ? 'Secure' : null].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; ${attrs}`);
  await audit('admin_login', { actor: expectedUser, ip, success: true });
  return sendJson(res, 200, { ok: true, user: expectedUser });
}

async function handleSession(req, res, session) {
  return sendJson(res, 200, { ok: true, user: session.user });
}

async function handleLogout(req, res, session) {
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
  if (!data || typeof data !== 'object') return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });
  
  const [currentRow] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, CONTENT_KEY)).limit(1);
  const currentVersion = currentRow?.version || 0;
  const newVersion = currentVersion + 1;

  await db.insert(schema.siteContent).values({ key: CONTENT_KEY, data, version: newVersion, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: schema.siteContent.key, set: { data, version: newVersion, updatedAt: new Date().toISOString() } });

  await audit('content.update', { actor: session.user, metadata: { version: newVersion } });
  return sendJson(res, 200, { ok: true, version: newVersion });
}

// ─────────────────────────────────────────────────────────────
// UPLOADS
// ─────────────────────────────────────────────────────────────
async function handleUpload(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const buffer = Buffer.from(String(body.base64 || ''), 'base64');
  const bucket = BUCKET_BY_KIND[kind];
  
  if (!bucket) return sendJson(res, 400, { ok: false, error: 'Tipo inválido.' });
  
  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${body.filename.split('.').pop()}`;
  const path = kind === 'image' ? `images/${uniqueName}` : uniqueName;

  try {
    await uploadObject(bucket, path, buffer, body.contentType);
    const publicUrl = bucket !== 'audio-premium' ? b2GetPublicUrl(bucket, path) : null;
    return sendJson(res, 200, { ok: true, url: publicUrl, path, bucket });
  } catch (err) {
    return sendJson(res, 502, { ok: false, error: 'Falha no upload.' });
  }
}

async function handleUploadSign(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const bucket = BUCKET_BY_KIND[kind];
  if (!bucket) return sendJson(res, 400, { ok: false, error: 'Tipo inválido.' });

  const uniqueName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${body.filename.split('.').pop()}`;
  const path = kind === 'image' ? `images/${uniqueName}` : uniqueName;

  const signed = await createSignedUploadUrl(bucket, path, SIGNED_UPLOAD_TTL_SEC);
  return sendJson(res, 200, { ok: true, uploadUrl: signed.uploadUrl, token: signed.token, path, bucket });
}

async function handleUploadConfirm(req, res, session) {
  const body = parseBody(req);
  const kind = String(body.kind || '').trim();
  const path = String(body.path || '').trim();
  const albumId = body.albumId ? String(body.albumId).trim() : null;
  const trackIndex = Number(body.trackIndex);

  const bucket = BUCKET_BY_KIND[kind];
  if (!bucket || !path) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });

  const exists = await b2ObjectExists(bucket, path);
  if (!exists) return sendJson(res, 400, { ok: false, error: 'Arquivo não encontrado no Storage.' });

  if (albumId && trackIndex !== null) {
    const isFull = kind === 'audio-full';
    const patch = isFull
      ? { fullPath: path, streamKey: path, updatedAt: new Date().toISOString() }
      : { previewPath: path, previewKey: path, updatedAt: new Date().toISOString() };

    const updated = await db.update(tracks).set(patch).where(and(eq(tracks.albumId, albumId), eq(tracks.trackNumber, trackIndex))).returning();
    if (!updated.length) return sendJson(res, 502, { ok: false, error: 'Faixa não encontrada.' });

    const publicUrl = bucket !== 'audio-premium' ? b2GetPublicUrl(bucket, path) : null;
    return sendJson(res, 200, { ok: true, url: publicUrl, path, bucket, track: updated[0] });
  }

  const publicUrl = bucket !== 'audio-premium' ? b2GetPublicUrl(bucket, path) : null;
  return sendJson(res, 200, { ok: true, path, bucket, url: publicUrl });
}

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// ─────────────────────────────────────────────────────────────
async function handleGetUsers(req, res) {
  const rows = await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, createdAt: schema.users.createdAt }).from(schema.users).orderBy(desc(schema.users.createdAt));
  const planRows = await db.execute(sql`SELECT user_id, plan FROM effective_plan`);
  const planMap = new Map((planRows.rows || planRows).map(r => [r.user_id, r.plan]));

  return sendJson(res, 200, { ok: true, users: rows.map(u => ({ ...u, plan: planMap.get(u.id) || 'free' })) });
}

async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!isUuid(userId) || !VALID_PLANS.has(plan)) return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });

  await db.update(schema.subscriptions).set({ status: 'CANCELLED', updatedAt: new Date().toISOString() }).where(and(eq(schema.subscriptions.userId, userId), inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING'])));

  if (plan !== 'free') {
    const [planRow] = await db.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.name, plan)).limit(1);
    if (planRow) {
      await db.insert(schema.subscriptions).values({
        id: crypto.randomUUID(), userId, planId: planRow.id, externalSubscriptionId: `manual_${userId}_${Date.now()}`,
        status: 'ACTIVE', currentPeriodStart: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
    }
  }

  await audit('user.plan.change', { actor: session.user, target: userId, metadata: { plan } });
  return sendJson(res, 200, { ok: true, plan });
}

async function handleDeleteUser(req, res, session) {
  const userId = String(req.query?.id || '').trim();
  if (!userId || userId === session.user) return sendJson(res, 400, { ok: false, error: 'Ação não permitida.' });

  await audit('user.delete', { actor: session.user, target: userId });
  const deleted = await db.delete(schema.users).where(eq(schema.users.id, userId)).returning();
  
  return deleted.length ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA
// ─────────────────────────────────────────────────────────────
async function handleListAlbums(req, res) {
  const rows = await db.select().from(albums).orderBy(asc(albums.sortOrder));
  return sendJson(res, 200, { ok: true, albums: rows });
}

async function handleGetAlbum(req, res) {
  const [row] = await db.select().from(albums).where(eq(albums.id, req.query.id)).limit(1);
  return row ? sendJson(res, 200, { ok: true, album: row }) : sendJson(res, 404, { ok: false, error: 'Não encontrado.' });
}

async function handleCreateAlbum(req, res, session) {
  const body = parseBody(req);
  const [artist] = await db.select({ id: artists.id }).from(artists).limit(1);
  const [created] = await db.insert(albums).values({
    id: crypto.randomUUID(), title: body.title, slug: createSlug(body.title), artistId: artist.id, published: !!body.published
  }).returning();
  return sendJson(res, 200, { ok: true, album: created });
}

async function handleUpdateAlbum(req, res, session) {
  const body = parseBody(req);
  const [updated] = await db.update(albums).set({ title: body.title, published: body.published }).where(eq(albums.id, req.query.id)).returning();
  return sendJson(res, 200, { ok: true, album: updated });
}

async function handleDeleteAlbum(req, res, session) {
  await db.delete(tracks).where(eq(tracks.albumId, req.query.id));
  await db.delete(albums).where(eq(albums.id, req.query.id));
  return sendJson(res, 200, { ok: true });
}

async function handleListTracks(req, res) {
  const rows = await db.select().from(tracks).where(eq(tracks.albumId, req.query.albumId)).orderBy(asc(tracks.trackNumber));
  return sendJson(res, 200, { ok: true, tracks: rows });
}

async function handleCreateTrack(req, res, session) {
  const body = parseBody(req);
  const [album] = await db.select({ artistId: albums.artistId }).from(albums).where(eq(albums.id, body.album_id)).limit(1);
  const [created] = await db.insert(tracks).values({
    id: crypto.randomUUID(), albumId: body.album_id, artistId: album.artistId, title: body.title, slug: createSlug(body.title),
    trackNumber: 1, status: 'DRAFT'
  }).returning();
  return sendJson(res, 200, { ok: true, track: created });
}

async function handleUpdateTrack(req, res, session) {
  const body = parseBody(req);
  const patch = {};
  if (body.title) patch.title = body.title;
  if (body.published !== undefined) patch.status = body.published ? 'PUBLISHED' : 'DRAFT';
  if (body.full_path) { patch.fullPath = body.full_path; patch.streamKey = body.full_path; }
  if (body.preview_path) { patch.previewPath = body.preview_path; patch.previewKey = body.preview_path; }

  const [updated] = await db.update(tracks).set(patch).where(eq(tracks.id, req.query.id)).returning();
  return sendJson(res, 200, { ok: true, track: updated });
}

async function handleDeleteTrack(req, res, session) {
  await db.delete(tracks).where(eq(tracks.id, req.query.id));
  return sendJson(res, 200, { ok: true });
}

async function handleReorderTracks(req, res, session) {
  const body = parseBody(req);
  for (const item of body.order) {
    await db.update(tracks).set({ trackNumber: item.track_number }).where(eq(tracks.id, item.id));
  }
  return sendJson(res, 200, { ok: true });
}

async function handleUpdateLyrics(req, res, session) {
  const [updated] = await db.update(tracks).set({ lyrics: parseBody(req).lyrics }).where(eq(tracks.id, req.query.id)).returning();
  return sendJson(res, 200, { ok: true, track: updated });
}

// ─────────────────────────────────────────────────────────────
// DOWNLOADS
// ─────────────────────────────────────────────────────────────
async function handleDownloadUrl(req, res, session) {
  const [track] = await db.select().from(tracks).where(eq(tracks.id, req.query.id)).limit(1);
  if (!track || !track.fullPath) return sendJson(res, 404, { ok: false, error: 'Áudio não encontrado.' });
  const url = await b2CreateSignedDownloadUrl('audio-premium', track.fullPath, DOWNLOAD_TTL_SEC, `${sanitizeFilename(track.title)}.mp3`);
  return sendJson(res, 200, { ok: true, url });
}

async function handleDownloadAlbum(req, res, session) {
  const rows = await db.select().from(tracks).where(eq(tracks.albumId, req.query.id)).orderBy(asc(tracks.trackNumber));
  const urls = await Promise.all(rows.map(async t => {
    if (!t.fullPath) return { id: t.id, url: null };
    const url = await b2CreateSignedDownloadUrl('audio-premium', t.fullPath, DOWNLOAD_TTL_SEC, `${sanitizeFilename(t.title)}.mp3`);
    return { id: t.id, title: t.title, url };
  }));
  return sendJson(res, 200, { ok: true, tracks: urls });
}

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────
function verifySession(req) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  return token ? verifyHmac(token, getSessionSecret(), SESSION_MAX_AGE * 1000) : null;
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