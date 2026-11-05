/* ============================================================
   api/admin.js — Painel administrativo (Versão Final Auditada)
   ------------------------------------------------------------
   Correções aplicadas:
   - upload-sign: passa contentType correto para createSignedUploadUrl
   - upload / upload-confirm: usa kind lógico (não nome físico)
   - Valida MIME, extensão e tamanho dos uploads
   - Sincroniza published/status em handleUpdateTrack
   - Transação em handleDeleteAlbum
   - Validações de payload em álbuns e faixas
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

const { tracks, albums, artists, orders, adminAudit } = schema;

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

// ★ Kinds lógicos (o storage resolve para o bucket físico)
const VALID_KINDS = new Set(['image', 'audio-preview', 'audio-full']);

// ★ Regras de upload
const UPLOAD_RULES = {
  image: {
    extensions: ['jpg', 'jpeg', 'png', 'webp'],
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 10 * 1024 * 1024
  },
  'audio-preview': {
    extensions: ['mp3', 'm4a', 'ogg', 'wav'],
    mimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav'],
    maxBytes: 30 * 1024 * 1024
  },
  'audio-full': {
    extensions: ['mp3', 'm4a', 'ogg', 'wav'],
    mimeTypes: ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/x-wav'],
    maxBytes: 300 * 1024 * 1024
  }
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

  if (!user || !pass || user.length > 150 || pass.length > 1024) {
    return sendJson(res, 400, { ok: false, error: 'Credenciais inválidas.' });
  }

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
  const baseVersion = Number(body.baseVersion);

  if (!data || typeof data !== 'object' || Array.isArray(data) || !Number.isInteger(baseVersion) || baseVersion < 0) {
    return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });
  }

  const [current] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, CONTENT_KEY)).limit(1);
  const currentVersion = current?.version ?? 0;

  if (currentVersion !== baseVersion) {
    return sendJson(res, 409, { ok: false, error: 'O conteúdo foi alterado por outra sessão. Atualize a página antes de salvar.', currentVersion });
  }

  const newVersion = currentVersion + 1;
  const now = new Date().toISOString();

  try {
    if (current) {
      const updated = await db.update(schema.siteContent)
        .set({ data, version: newVersion, updatedAt: now })
        .where(and(eq(schema.siteContent.key, CONTENT_KEY), eq(schema.siteContent.version, baseVersion)))
        .returning();

      if (!updated.length) {
        return sendJson(res, 409, { ok: false, error: 'Conflito de atualização.' });
      }
    } else {
      await db.insert(schema.siteContent).values({ key: CONTENT_KEY, data, version: newVersion, updatedAt: now });
    }

    await audit('content.update', { actor: session.user, metadata: { version: newVersion } });
    return sendJson(res, 200, { ok: true, version: newVersion });
  } catch (err) {
    console.error('[admin/content]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível salvar o conteúdo.' });
  }
}

// ─────────────────────────────────────────────────────────────
// UTILS de upload
// ─────────────────────────────────────────────────────────────
function validateUploadInput(body) {
  const kind = String(body.kind || '').trim();
  const filename = String(body.filename || '').trim();
  const contentType = String(body.contentType || '').trim().toLowerCase();
  const size = Number(body.size) || 0;
  const rule = UPLOAD_RULES[kind];

  if (!rule) throw new Error('Tipo de upload não permitido.');
  if (!filename || filename.length > 180 || /[\/\\\r\n]/.test(filename)) {
    throw new Error('Nome de arquivo inválido.');
  }

  const ext = filename.split('.').pop().toLowerCase();
  if (!rule.extensions.includes(ext)) throw new Error('Extensão não permitida.');
  if (!rule.mimeTypes.includes(contentType)) throw new Error('MIME não permitido.');
  if (size > 0 && size > rule.maxBytes) throw new Error('Arquivo muito grande.');

  return { kind, filename, ext, contentType, size };
}

function createUploadPath(kind, extension) {
  const directory = kind === 'image'
    ? 'images'
    : kind === 'audio-preview'
      ? 'audio/previews'
      : 'audio/full';

  const filename = `${Date.now()}_${crypto.randomBytes(12).toString('hex')}.${extension}`;
  return `${directory}/${filename}`;
}

// ─────────────────────────────────────────────────────────────
// UPLOADS
// ─────────────────────────────────────────────────────────────
async function handleUpload(req, res, session) {
  const body = parseBody(req);

  let file;
  try { file = validateUploadInput(body); }
  catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }

  const buffer = Buffer.from(String(body.base64 || ''), 'base64');
  if (!buffer.length) return sendJson(res, 400, { ok: false, error: 'Arquivo vazio.' });

  const path = createUploadPath(file.kind, file.ext);

  try {
    await uploadObject(file.kind, path, buffer, file.contentType);
    const publicUrl = file.kind !== 'audio-full' ? b2GetPublicUrl(file.kind, path) : null;
    await audit('upload.direct', { actor: session.user, metadata: { kind: file.kind, path } });
    return sendJson(res, 200, { ok: true, url: publicUrl, path, kind: file.kind });
  } catch (err) {
    console.error('[admin/upload]', err.message);
    return sendJson(res, 502, { ok: false, error: 'Falha no upload.' });
  }
}

async function handleUploadSign(req, res, session) {
  const body = parseBody(req);

  let file;
  try { file = validateUploadInput(body); }
  catch (err) { return sendJson(res, 400, { ok: false, error: err.message }); }

  const path = createUploadPath(file.kind, file.ext);

  try {
    const signed = await b2CreateSignedUploadUrl(file.kind, path, file.contentType, SIGNED_UPLOAD_TTL_SEC);
    await audit('admin.upload.sign', { actor: session.user, metadata: { kind: file.kind, path } });
    return sendJson(res, 200, {
      ok: true,
      uploadUrl: signed.uploadUrl,
      path,
      kind: file.kind,
      expiresIn: SIGNED_UPLOAD_TTL_SEC
    });
  } catch (err) {
    console.error('[admin/upload-sign]', err.message);
    return sendJson(res, 502, { ok: false, error: 'Não foi possível gerar URL de upload.' });
  }
}

async function handleUploadConfirm(req, res, session) {
  const body = parseBody(req);

  const kind = String(body.kind || '').trim();
  const path = String(body.path || '').trim();
  const albumId = body.albumId ? String(body.albumId).trim() : null;
  const trackIndex = (body.trackIndex === undefined || body.trackIndex === null || body.trackIndex === '')
    ? null
    : Number(body.trackIndex);

  if (!VALID_KINDS.has(kind) || !path) {
    return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });
  }

  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    return sendJson(res, 400, { ok: false, error: 'Caminho de arquivo inválido.' });
  }

  if (albumId && !isUuid(albumId)) {
    return sendJson(res, 400, { ok: false, error: 'Álbum inválido.' });
  }

  if (trackIndex !== null && (!Number.isInteger(trackIndex) || trackIndex < 1)) {
    return sendJson(res, 400, { ok: false, error: 'Número da faixa inválido.' });
  }

  if ((albumId && !trackIndex) || (!albumId && trackIndex)) {
    return sendJson(res, 400, { ok: false, error: 'Álbum e número da faixa devem ser informados juntos.' });
  }

  try {
    const exists = await b2ObjectExists(kind, path);
    if (!exists) return sendJson(res, 404, { ok: false, error: 'Arquivo não encontrado no armazenamento.' });

    if (albumId && trackIndex !== null) {
      if (kind === 'image') {
        return sendJson(res, 400, { ok: false, error: 'Imagem não pode ser associada como áudio.' });
      }

      const isFull = kind === 'audio-full';
      const patch = isFull
        ? { fullPath: path, streamKey: path, updatedAt: new Date().toISOString() }
        : { previewPath: path, previewKey: path, updatedAt: new Date().toISOString() };

      const updated = await db.update(tracks).set(patch)
        .where(and(eq(tracks.albumId, albumId), eq(tracks.trackNumber, trackIndex)))
        .returning();

      if (!updated.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

      await audit('upload.track.confirm', { actor: session.user, target: updated[0].id, metadata: { kind, path } });

      const publicUrl = kind === 'audio-full' ? null : b2GetPublicUrl(kind, path);
      return sendJson(res, 200, { ok: true, path, kind, url: publicUrl, track: updated[0] });
    }

    const publicUrl = kind === 'audio-full' ? null : b2GetPublicUrl(kind, path);
    await audit('upload.confirm', { actor: session.user, metadata: { kind, path } });
    return sendJson(res, 200, { ok: true, path, kind, url: publicUrl });
  } catch (err) {
    console.error('[admin/upload-confirm]', err.code || err.message);
    return sendJson(res, 502, { ok: false, error: 'Não foi possível confirmar o arquivo.' });
  }
}

// ─────────────────────────────────────────────────────────────
// USUÁRIOS
// ─────────────────────────────────────────────────────────────
async function handleGetUsers(req, res) {
  const rows = await db.select({
    id: schema.users.id,
    email: schema.users.email,
    name: schema.users.name,
    createdAt: schema.users.createdAt
  }).from(schema.users).orderBy(desc(schema.users.createdAt));

  let planRows = [];
  try {
    planRows = await db.execute(sql`SELECT user_id, plan FROM effective_plan`);
  } catch (e) {
    console.warn('[admin] View effective_plan não encontrada.');
  }

  const planMap = new Map((planRows.rows || planRows).map(r => [r.user_id, r.plan]));
  return sendJson(res, 200, { ok: true, users: rows.map(u => ({ ...u, plan: planMap.get(u.id) || 'free' })) });
}

async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!isUuid(userId) || !VALID_PLANS.has(plan)) return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });

  await db.update(schema.subscriptions)
    .set({ status: 'CANCELLED', updatedAt: new Date().toISOString() })
    .where(and(eq(schema.subscriptions.userId, userId), inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING'])));

  if (plan !== 'free') {
    const [planRow] = await db.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.name, plan)).limit(1);
    if (planRow) {
      await db.insert(schema.subscriptions).values({
        id: crypto.randomUUID(),
        userId,
        planId: planRow.id,
        externalSubscriptionId: `manual_${userId}_${Date.now()}`,
        status: 'ACTIVE',
        currentPeriodStart: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }
  }

  await audit('user.plan.change', { actor: session.user, target: userId, metadata: { plan } });
  return sendJson(res, 200, { ok: true, plan });
}

async function handleDeleteUser(req, res, session) {
  const userId = String(req.query?.id || '').trim();
  if (!userId || userId === session.user) return sendJson(res, 400, { ok: false, error: 'Ação não permitida.' });

  const [hasOrders] = await db.select({ count: sql`COUNT(*)` }).from(orders).where(eq(orders.userId, userId));
  if (Number(hasOrders?.count) > 0) {
    return sendJson(res, 409, { ok: false, error: 'Não é possível excluir um usuário com histórico financeiro. Desative a conta em vez disso.' });
  }

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
  const title = String(body.title || '').trim();
  const artistId = String(body.artistId || '').trim();

  if (title.length < 1 || title.length > 200) {
    return sendJson(res, 400, { ok: false, error: 'Título do álbum inválido.' });
  }
  if (!isUuid(artistId)) {
    return sendJson(res, 400, { ok: false, error: 'Artista inválido.' });
  }

  const [artist] = await db.select({ id: artists.id }).from(artists).where(eq(artists.id, artistId)).limit(1);
  if (!artist) return sendJson(res, 404, { ok: false, error: 'Artista não encontrado.' });

  const slug = createSlug(title);
  if (!slug) return sendJson(res, 400, { ok: false, error: 'Não foi possível gerar o identificador do álbum.' });

  try {
    const [created] = await db.insert(albums).values({
      id: crypto.randomUUID(),
      title,
      slug,
      artistId,
      published: body.published === true,
      coverUrl: body.coverUrl || null,
      description: body.description || null,
      year: Number.isInteger(Number(body.year)) ? Number(body.year) : null,
      type: body.type || 'album',
      sortOrder: Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0
    }).returning();

    await audit('album.create', { actor: session.user, target: created.id });
    return sendJson(res, 201, { ok: true, album: created });
  } catch (err) {
    if (err.code === '23505') return sendJson(res, 409, { ok: false, error: 'Já existe um álbum com esse identificador.' });
    console.error('[admin/album-create]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível criar o álbum.' });
  }
}

async function handleUpdateAlbum(req, res, session) {
  const body = parseBody(req);
  const [updated] = await db.update(albums).set({ title: body.title, published: body.published }).where(eq(albums.id, req.query.id)).returning();
  return sendJson(res, 200, { ok: true, album: updated });
}

async function handleDeleteAlbum(req, res, session) {
  const albumId = String(req.query.id || '').trim();
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    await db.transaction(async (tx) => {
      await tx.delete(tracks).where(eq(tracks.albumId, albumId));
      await tx.delete(albums).where(eq(albums.id, albumId));
    });
    await audit('album.delete', { actor: session.user, target: albumId });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[admin/album-delete]', err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível excluir o álbum.' });
  }
}

async function handleListTracks(req, res) {
  const albumId = String(req.query.albumId || '').trim();
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'albumId inválido.' });

  const rows = await db.select().from(tracks).where(eq(tracks.albumId, albumId)).orderBy(asc(tracks.trackNumber));
  return sendJson(res, 200, { ok: true, tracks: rows });
}

async function handleCreateTrack(req, res, session) {
  const body = parseBody(req);
  const albumId = String(body.album_id || '').trim();
  const title = String(body.title || '').trim();

  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'Álbum inválido.' });
  if (!title || title.length > 200) return sendJson(res, 400, { ok: false, error: 'Título da faixa inválido.' });

  const [album] = await db.select({ id: albums.id, artistId: albums.artistId }).from(albums).where(eq(albums.id, albumId)).limit(1);
  if (!album) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

  const [lastTrack] = await db.select({ maxNumber: sql`MAX(${tracks.trackNumber})` }).from(tracks).where(eq(tracks.albumId, albumId));
  const nextNumber = Number(lastTrack?.maxNumber || 0) + 1;

  try {
    const [created] = await db.insert(tracks).values({
      id: crypto.randomUUID(),
      albumId,
      artistId: album.artistId,
      title,
      slug: createSlug(title),
      trackNumber: nextNumber,
      status: 'DRAFT',
      lyrics: []
    }).returning();

    await audit('track.create', { actor: session.user, target: created.id, metadata: { albumId, trackNumber: nextNumber } });
    return sendJson(res, 201, { ok: true, track: created });
  } catch (err) {
    console.error('[admin/track-create]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível cadastrar a faixa.' });
  }
}

async function handleUpdateTrack(req, res, session) {
  const body = parseBody(req);
  const trackId = String(req.query.id || body.id || '').trim();
  if (!trackId) return sendJson(res, 400, { ok: false, error: 'ID obrigatório.' });

  const patch = {};
  if (body.title) patch.title = body.title;
  if (body.published !== undefined) {
    const published = body.published === true;
    patch.status = published ? 'PUBLISHED' : 'DRAFT';
    patch.published = published;
  }
  if (body.full_path) { patch.fullPath = body.full_path; patch.streamKey = body.full_path; }
  if (body.preview_path) { patch.previewPath = body.preview_path; patch.previewKey = body.preview_path; }

  const [updated] = await db.update(tracks).set(patch).where(eq(tracks.id, trackId)).returning();
  return updated
    ? sendJson(res, 200, { ok: true, track: updated })
    : sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
}

async function handleDeleteTrack(req, res, session) {
  await db.delete(tracks).where(eq(tracks.id, req.query.id));
  return sendJson(res, 200, { ok: true });
}

async function handleReorderTracks(req, res, session) {
  const body = parseBody(req);
  const order = Array.isArray(body.order) ? body.order : [];
  if (!order.length) return sendJson(res, 400, { ok: false, error: 'Lista de reordenação vazia.' });

  for (const item of order) {
    if (!isUuid(item.id) || !Number.isInteger(Number(item.track_number)) || Number(item.track_number) < 1) continue;
    await db.update(tracks).set({ trackNumber: Number(item.track_number) }).where(eq(tracks.id, item.id));
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
  const url = await b2CreateSignedDownloadUrl('audio-full', track.fullPath, DOWNLOAD_TTL_SEC, `${sanitizeFilename(track.title)}.mp3`);
  return sendJson(res, 200, { ok: true, url });
}

async function handleDownloadAlbum(req, res, session) {
  const rows = await db.select().from(tracks).where(eq(tracks.albumId, req.query.id)).orderBy(asc(tracks.trackNumber));
  const urls = await Promise.all(rows.map(async t => {
    if (!t.fullPath) return { id: t.id, url: null };
    const url = await b2CreateSignedDownloadUrl('audio-full', t.fullPath, DOWNLOAD_TTL_SEC, `${sanitizeFilename(t.title)}.mp3`);
    return { id: t.id, title: t.title, url };
  }));
  return sendJson(res, 200, { ok: true, tracks: urls });
}

// ─────────────────────────────────────────────────────────────
// VENDAS E AUDITORIA
// ─────────────────────────────────────────────────────────────
async function handleGetSales(req, res) {
  try {
    const rows = await db.select().from(orders).orderBy(desc(orders.createdAt)).limit(50);
    const sales = rows.map(o => ({ id: o.id, status: o.status, totalCents: o.totalCents, createdAt: o.createdAt, userId: o.userId }));
    return sendJson(res, 200, { ok: true, sales });
  } catch (err) {
    console.error('[admin/sales]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível consultar as vendas.' });
  }
}

async function handleGetAudit(req, res) {
  try {
    const rows = await db.select().from(adminAudit).orderBy(desc(adminAudit.createdAt)).limit(100);
    return sendJson(res, 200, { ok: true, audit: rows });
  } catch (err) {
    console.error('[admin/audit]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível consultar a auditoria.' });
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
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}