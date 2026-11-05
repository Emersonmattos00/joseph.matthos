/* ============================================================
   api/admin.js — Painel administrativo (Versão Final Auditada)
   ------------------------------------------------------------
   Correções aplicadas:
   - upload-sign: passa contentType correto
   - upload / upload-confirm: usa kind lógico
   - Valida MIME, extensão e tamanho dos uploads
   - handleUpdateTrack: NÃO grava `published` (coluna não existe)
   - handleUpdateTrack: converte mm:ss → durationSeconds
   - handleCreateTrack: idem; trackNumber calculado como MAX+1
   - handleUpdateAlbum: aceita patch parcial (title, published,
     coverUrl, coverInitials, orderIndex, description, year, type, sortOrder)
   - handleCreateAlbum: persiste todos os campos do schema
   - handleDeleteUser: verifica orders, rentals e subscriptions (FKs RESTRICT)
   - handlePatchUser: retorna 400 se plano não existir em `plans`
   - handleGetUsers: retorna 503 se `effective_plan` falhar
   - handleUpdateLyrics: retorna 501 até confirmar coluna
   - handleReorderTracks: valida mesmo álbum, dentro de transação
   - handleDownloadUrl / handleDownloadAlbum: retornam `filename`
   - Transação em handleDeleteAlbum
   - baseVersion em handlePutContent (evita sobrescrita)
   - Retorna updatedAt em handleGetContent

   TODO (dependem de decisão de produto/schema):
   - tracks.price_cents / tracks.for_sale → usar rental_products
   - tracks.preview_start / preview_duration → coluna nova ou rental_products
   - tracks.lyrics → coluna nova
   - admin_grants para concessão administrativa (evitar assinatura fictícia)
   - desativação de usuário em vez de exclusão física
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

const VALID_KINDS = new Set(['image', 'audio-preview', 'audio-full']);

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

const VALID_ALBUM_TYPES = new Set(['album', 'ep', 'single']);

const DEV_NO_RATE_LIMIT = process.env.NODE_ENV !== 'production' && process.env.DISABLE_RATE_LIMIT === 'true';
const DEV_NO_CSRF = process.env.NODE_ENV !== 'production' && process.env.DISABLE_CSRF === 'true';

function getSessionSecret() {
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_SESSION_SECRET ausente.');
  if (secret.length < MIN_SESSION_SECRET_LENGTH) throw new Error('ADMIN_SESSION_SECRET muito curto.');
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
    case 'delete-user':
      if (method === 'DELETE') return handleDeleteUser(req, res, session);
      break;
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
// TODO: confirmar existência da tabela `site_content` no schema
//       (colunas esperadas: key, data jsonb, version integer, updated_at).
// ─────────────────────────────────────────────────────────────
async function handleGetContent(req, res) {
  const [row] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, CONTENT_KEY)).limit(1);
  return sendJson(res, 200, {
    ok: true,
    data: row?.data || {},
    version: row?.version || 0,
    updatedAt: row?.updatedAt || null
  });
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
    return sendJson(res, 409, {
      ok: false,
      error: 'O conteúdo foi alterado por outra sessão. Atualize a página antes de salvar.',
      currentVersion
    });
  }

  const newVersion = currentVersion + 1;
  const now = new Date().toISOString();

  try {
    if (current) {
      const updated = await db.update(schema.siteContent)
        .set({ data, version: newVersion, updatedAt: now })
        .where(and(
          eq(schema.siteContent.key, CONTENT_KEY),
          eq(schema.siteContent.version, baseVersion)
        ))
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
  if (!filename || filename.length > 180 || /[\/\\\r\n]/.test(filename)) throw new Error('Nome de arquivo inválido.');

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

  if (!VALID_KINDS.has(kind) || !path) return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });

  if (path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    return sendJson(res, 400, { ok: false, error: 'Caminho de arquivo inválido.' });
  }

  if (albumId && !isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'Álbum inválido.' });

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
      if (kind === 'image') return sendJson(res, 400, { ok: false, error: 'Imagem não pode ser associada como áudio.' });

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
  let rows;
  try {
    rows = await db.select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      createdAt: schema.users.createdAt
    }).from(schema.users).orderBy(desc(schema.users.createdAt));
  } catch (err) {
    console.error('[admin/users] falha ao listar usuários:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível listar usuários.' });
  }

  let planRows;
  try {
    const result = await db.execute(sql`SELECT user_id, plan FROM effective_plan`);
    planRows = result.rows || result;
  } catch (err) {
    console.error('[admin/users] falha ao consultar effective_plan:', err.code || err.message);
    return sendJson(res, 503, {
      ok: false,
      error: 'Não foi possível consultar os planos dos usuários.'
    });
  }

  const planMap = new Map(
    planRows.map(r => [String(r.user_id), String(r.plan).toLowerCase()])
  );

  return sendJson(res, 200, {
    ok: true,
    users: rows.map(u => ({
      ...u,
      plan: planMap.get(String(u.id)) || 'free'
    })),
    total: rows.length
  });
}

async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!isUuid(userId) || !VALID_PLANS.has(plan)) {
    return sendJson(res, 400, { ok: false, error: 'Dados inválidos.' });
  }

  let planRow = null;
  if (plan !== 'free') {
    const [row] = await db.select({ id: schema.plans.id }).from(schema.plans)
      .where(eq(schema.plans.name, plan)).limit(1);
    if (!row) {
      return sendJson(res, 400, { ok: false, error: `Plano "${plan}" não cadastrado.` });
    }
    planRow = row;
  }

  // TODO (dívida técnica): criar tabela `admin_grants` para concessões
  // administrativas e parar de simular assinatura paga.
  try {
    await db.transaction(async (tx) => {
      await tx.update(schema.subscriptions)
        .set({ status: 'CANCELLED', updatedAt: new Date().toISOString() })
        .where(and(
          eq(schema.subscriptions.userId, userId),
          inArray(schema.subscriptions.status, ['ACTIVE', 'PENDING'])
        ));

      if (plan !== 'free' && planRow) {
        await tx.insert(schema.subscriptions).values({
          id: crypto.randomUUID(),
          userId,
          planId: planRow.id,
          externalSubscriptionId: `manual_${userId}_${Date.now()}`,
          status: 'ACTIVE',
          currentPeriodStart: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    });
  } catch (err) {
    console.error('[admin/user-plan]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível alterar o plano.' });
  }

  await audit('user.plan.change', { actor: session.user, target: userId, metadata: { plan } });
  return sendJson(res, 200, { ok: true, plan });
}

async function handleDeleteUser(req, res, session) {
  const userId = String(req.query?.id || '').trim();

  if (!isUuid(userId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });
  if (userId === session.user) return sendJson(res, 400, { ok: false, error: 'Ação não permitida.' });

  try {
    const [ordersCount] = await db.select({ c: sql`COUNT(*)` }).from(orders).where(eq(orders.userId, userId));
    const [rentalsCount] = await db.select({ c: sql`COUNT(*)` }).from(schema.rentals).where(eq(schema.rentals.userId, userId));
    const [subsCount] = await db.select({ c: sql`COUNT(*)` }).from(schema.subscriptions).where(eq(schema.subscriptions.userId, userId));

    const hasDeps =
      Number(ordersCount?.c) > 0 ||
      Number(rentalsCount?.c) > 0 ||
      Number(subsCount?.c) > 0;

    if (hasDeps) {
      return sendJson(res, 409, {
        ok: false,
        error: 'Usuário possui histórico (pedidos, aluguéis ou assinaturas). Desative a conta em vez de excluir.'
      });
    }

    await audit('user.delete', { actor: session.user, target: userId });
    const deleted = await db.delete(schema.users).where(eq(schema.users.id, userId)).returning();

    return deleted.length
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
  } catch (err) {
    console.error('[admin/user-delete]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível excluir o usuário.' });
  }
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA
// ─────────────────────────────────────────────────────────────
async function handleListAlbums(req, res) {
  const rows = await db.select().from(albums).orderBy(asc(albums.sortOrder));
  return sendJson(res, 200, { ok: true, albums: rows });
}

async function handleGetAlbum(req, res) {
  const albumId = String(req.query.id || '').trim();
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const [row] = await db.select().from(albums).where(eq(albums.id, albumId)).limit(1);
  return row
    ? sendJson(res, 200, { ok: true, album: row })
    : sendJson(res, 404, { ok: false, error: 'Não encontrado.' });
}

function buildAlbumFieldsFromBody(body, { requireTitle }) {
  const patch = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (requireTitle && (title.length < 1 || title.length > 200)) {
      throw new Error('Título do álbum inválido.');
    }
    if (title.length > 0) {
      if (title.length > 200) throw new Error('Título do álbum inválido.');
      patch.title = title;
      patch.slug = createSlug(title);
    }
  }

  if (body.published !== undefined) patch.published = body.published === true;

  if (body.artist !== undefined) {
    patch.artist = String(body.artist || '').trim() || null;
  }

  if (body.cover_image !== undefined || body.coverUrl !== undefined) {
    patch.coverUrl = String(body.cover_image ?? body.coverUrl ?? '').trim() || null;
  }

  if (body.cover_initials !== undefined || body.coverInitials !== undefined) {
    patch.coverInitials = String(body.cover_initials ?? body.coverInitials ?? '').trim().slice(0, 8) || null;
  }

  if (body.description !== undefined) {
    patch.description = String(body.description || '').trim() || null;
  }

  if (body.type !== undefined) {
    const type = String(body.type || '').trim().toLowerCase();
    if (!VALID_ALBUM_TYPES.has(type)) throw new Error('Tipo de álbum inválido.');
    patch.type = type;
  }

  if (body.year !== undefined) {
    const year = body.year === null || body.year === '' ? null : Number(body.year);
    if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
      throw new Error('Ano inválido.');
    }
    patch.year = year;
  }

  if (body.order_index !== undefined || body.orderIndex !== undefined) {
    const order = Number(body.order_index ?? body.orderIndex);
    if (!Number.isInteger(order) || order < 0) throw new Error('Ordem inválida.');
    patch.orderIndex = order;
  }

  if (body.sortOrder !== undefined) {
    const sortOrder = Number(body.sortOrder);
    if (!Number.isInteger(sortOrder)) throw new Error('sortOrder inválido.');
    patch.sortOrder = sortOrder;
  }

  return patch;
}

async function handleCreateAlbum(req, res, session) {
  const body = parseBody(req);
  const artistId = String(body.artistId || body.artist_id || '').trim();

  if (!isUuid(artistId)) return sendJson(res, 400, { ok: false, error: 'Artista inválido.' });

  const [artist] = await db.select({ id: artists.id }).from(artists).where(eq(artists.id, artistId)).limit(1);
  if (!artist) return sendJson(res, 404, { ok: false, error: 'Artista não encontrado.' });

  let fields;
  try {
    fields = buildAlbumFieldsFromBody(body, { requireTitle: true });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  if (!fields.title) return sendJson(res, 400, { ok: false, error: 'Título do álbum obrigatório.' });

  try {
    const [created] = await db.insert(albums).values({
      id: crypto.randomUUID(),
      artistId,
      ...fields
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
  const albumId = String(req.query.id || '').trim();
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const body = parseBody(req);

  let patch;
  try {
    patch = buildAlbumFieldsFromBody(body, { requireTitle: false });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: err.message });
  }

  if (!Object.keys(patch).length) {
    return sendJson(res, 400, { ok: false, error: 'Nada para atualizar.' });
  }

  try {
    const [updated] = await db.update(albums).set(patch)
      .where(eq(albums.id, albumId)).returning();

    if (!updated) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

    await audit('album.update', { actor: session.user, target: albumId, metadata: patch });
    return sendJson(res, 200, { ok: true, album: updated });
  } catch (err) {
    if (err.code === '23505') return sendJson(res, 409, { ok: false, error: 'Já existe um álbum com esse identificador.' });
    console.error('[admin/album-update]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível atualizar o álbum.' });
  }
}

async function handleDeleteAlbum(req, res, session) {
  const albumId = String(req.query.id || '').trim();
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  // TODO (dívida técnica): verificar dependências comerciais
  // (pedidos, aluguéis) e remoção de objetos no B2 antes de apagar.
  // Hoje o handler apaga em transação, mas não checa essas FKs.
  try {
    await db.transaction(async (tx) => {
      // tracks.albumId tem ON DELETE SET NULL; apagamos as faixas
      // manualmente porque a intenção de produto é remover o álbum
      // com suas faixas.
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

function parseDurationToSeconds(value) {
  if (typeof value !== 'string') return null;

  const match = value.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  if (!match) return null;

  return Number(match[1]) * 60 + Number(match[2]);
}

async function handleCreateTrack(req, res, session) {
  const body = parseBody(req);
  const albumId = String(body.album_id || body.albumId || '').trim();
  const title = String(body.title || '').trim();

  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'Álbum inválido.' });
  if (!title || title.length > 200) return sendJson(res, 400, { ok: false, error: 'Título da faixa inválido.' });

  const [album] = await db.select({ id: albums.id, artistId: albums.artistId }).from(albums).where(eq(albums.id, albumId)).limit(1);
  if (!album) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

  let durationSeconds = null;
  if (body.duration !== undefined && body.duration !== '') {
    durationSeconds = parseDurationToSeconds(String(body.duration));
    if (durationSeconds === null) {
      return sendJson(res, 400, { ok: false, error: 'Duração inválida. Utilize o formato mm:ss.' });
    }
  }

  const status = body.published === true ? 'PUBLISHED' : 'DRAFT';

  try {
    const created = await db.transaction(async (tx) => {
      const [lastTrack] = await tx
        .select({ maxNumber: sql`MAX(${tracks.trackNumber})` })
        .from(tracks)
        .where(eq(tracks.albumId, albumId));

      const nextNumber = Number(lastTrack?.maxNumber || 0) + 1;

      const [row] = await tx.insert(tracks).values({
        id: crypto.randomUUID(),
        albumId,
        artistId: album.artistId,
        title,
        slug: createSlug(title),
        trackNumber: nextNumber,
        status,
        durationSeconds
        // NOTA: price_cents, for_sale, preview_start, preview_duration e
        // lyrics NÃO existem em `tracks` no schema atual. O frontend
        // envia esses campos, mas o backend os ignora.
      }).returning();

      return row;
    });

    await audit('track.create', { actor: session.user, target: created.id, metadata: { albumId, trackNumber: created.trackNumber } });
    return sendJson(res, 201, { ok: true, track: created });
  } catch (err) {
    console.error('[admin/track-create]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível cadastrar a faixa.' });
  }
}

async function handleUpdateTrack(req, res, session) {
  const body = parseBody(req);
  const trackId = String(req.query.id || body.id || '').trim();
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const patch = {};

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title || title.length > 200) {
      return sendJson(res, 400, { ok: false, error: 'Título inválido.' });
    }
    patch.title = title;
  }

  if (body.published !== undefined) {
    // `tracks` NÃO tem coluna `published`; `status` é a fonte da verdade.
    patch.status = body.published === true ? 'PUBLISHED' : 'DRAFT';
  }

  if (body.duration !== undefined) {
    if (body.duration === '' || body.duration === null) {
      patch.durationSeconds = null;
    } else {
      const seconds = parseDurationToSeconds(String(body.duration));
      if (seconds === null) {
        return sendJson(res, 400, { ok: false, error: 'Duração inválida. Utilize o formato mm:ss.' });
      }
      patch.durationSeconds = seconds;
    }
  }

  if (body.full_path !== undefined || body.fullPath !== undefined) {
    const v = String(body.full_path ?? body.fullPath ?? '').trim() || null;
    patch.fullPath = v;
    patch.streamKey = v;
  }

  if (body.preview_path !== undefined || body.previewPath !== undefined) {
    const v = String(body.preview_path ?? body.previewPath ?? '').trim() || null;
    patch.previewPath = v;
    patch.previewKey = v;
  }

  // NOTA: price_cents, for_sale, preview_start, preview_duration e lyrics
  // são enviados pelo frontend, mas NÃO existem em `tracks`. Ignorados
  // aqui. Quando essas colunas forem criadas (ou migradas para
  // rental_products), reativar o mapeamento abaixo.
  // if (body.price_cents !== undefined) patch.priceCents = Number(body.price_cents);
  // if (body.for_sale !== undefined) patch.forSale = body.for_sale === true;

  if (!Object.keys(patch).length) {
    return sendJson(res, 400, { ok: false, error: 'Nada para atualizar.' });
  }

  try {
    const [updated] = await db.update(tracks).set(patch)
      .where(eq(tracks.id, trackId)).returning();

    if (!updated) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

    await audit('track.update', { actor: session.user, target: trackId, metadata: patch });
    return sendJson(res, 200, { ok: true, track: updated });
  } catch (err) {
    console.error('[admin/track-update]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível atualizar a faixa.' });
  }
}

async function handleDeleteTrack(req, res, session) {
  const trackId = String(req.query.id || '').trim();
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  try {
    const deleted = await db.delete(tracks).where(eq(tracks.id, trackId)).returning();
    if (!deleted.length) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

    await audit('track.delete', { actor: session.user, target: trackId });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[admin/track-delete]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível excluir a faixa.' });
  }
}

async function handleReorderTracks(req, res, session) {
  const body = parseBody(req);
  const order = Array.isArray(body.order) ? body.order : [];
  if (!order.length) return sendJson(res, 400, { ok: false, error: 'Lista de reordenação vazia.' });

  const valid = order
    .map(item => ({
      id: String(item.id || '').trim(),
      track_number: Number(item.track_number)
    }))
    .filter(item =>
      isUuid(item.id) &&
      Number.isInteger(item.track_number) &&
      item.track_number >= 1
    );

  if (!valid.length) {
    return sendJson(res, 400, { ok: false, error: 'Nenhuma faixa válida para reordenar.' });
  }

  // Verifica que todas as faixas pertencem ao mesmo álbum.
  const ids = valid.map(v => v.id);
  let albumIds;
  try {
    const rows = await db.select({ id: tracks.id, albumId: tracks.albumId })
      .from(tracks).where(inArray(tracks.id, ids));
    albumIds = new Set(rows.map(r => String(r.albumId || '')));
  } catch (err) {
    console.error('[admin/track-reorder] lookup:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível validar as faixas.' });
  }

  if (albumIds.size !== 1 || albumIds.has('')) {
    return sendJson(res, 400, {
      ok: false,
      error: 'As faixas informadas não pertencem ao mesmo álbum.'
    });
  }

  try {
    await db.transaction(async (tx) => {
      for (const item of valid) {
        await tx.update(tracks)
          .set({ trackNumber: item.track_number })
          .where(eq(tracks.id, item.id));
      }
    });

    await audit('track.reorder', { actor: session.user, metadata: { count: valid.length } });
    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error('[admin/track-reorder]', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Não foi possível reordenar as faixas.' });
  }
}

async function handleUpdateLyrics(req, res, session) {
  // TODO: coluna `tracks.lyrics` não existe no schema atual.
  // Reativar quando houver migration adicionando a coluna.
  return sendJson(res, 501, {
    ok: false,
    error: 'Edição de letras ainda não implementada neste schema.'
  });

  /*
  const trackId = String(req.query.id || '').trim();
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const lyrics = parseBody(req).lyrics;
  if (!Array.isArray(lyrics)) {
    return sendJson(res, 400, { ok: false, error: 'Formato de letras inválido.' });
  }

  const [updated] = await db.update(tracks).set({ lyrics })
    .where(eq(tracks.id, trackId)).returning();

  return updated
    ? sendJson(res, 200, { ok: true, track: updated })
    : sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
  */
}

// ─────────────────────────────────────────────────────────────
// DOWNLOADS
// ─────────────────────────────────────────────────────────────
async function handleDownloadUrl(req, res, session) {
  const trackId = String(req.query.id || '').trim();
  if (!isUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  if (!track || !track.fullPath) return sendJson(res, 404, { ok: false, error: 'Áudio não encontrado.' });

  const filename = `${sanitizeFilename(track.title)}.mp3`;
  const url = await b2CreateSignedDownloadUrl('audio-full', track.fullPath, DOWNLOAD_TTL_SEC, filename);
  return sendJson(res, 200, { ok: true, url, filename });
}

async function handleDownloadAlbum(req, res, session) {
  const albumId = String(req.query.id || '').trim();
  if (!isUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'ID inválido.' });

  const rows = await db.select().from(tracks).where(eq(tracks.albumId, albumId)).orderBy(asc(tracks.trackNumber));
  const urls = await Promise.all(rows.map(async t => {
    if (!t.fullPath) return { id: t.id, title: t.title, filename: null, url: null };
    const filename = `${sanitizeFilename(t.title)}.mp3`;
    const url = await b2CreateSignedDownloadUrl('audio-full', t.fullPath, DOWNLOAD_TTL_SEC, filename);
    return { id: t.id, title: t.title, filename, url };
  }));
  return sendJson(res, 200, { ok: true, tracks: urls });
}

// ─────────────────────────────────────────────────────────────
// VENDAS E AUDITORIA
// ─────────────────────────────────────────────────────────────
async function handleGetSales(req, res) {
  try {
    const rawDays = req.query?.days;
    let days = null;
    if (rawDays !== undefined && rawDays !== null && rawDays !== '' && rawDays !== 'all') {
      const n = Number(rawDays);
      if (Number.isInteger(n) && n > 0 && n <= 365) days = n;
    }

    const now = new Date();
    const since = days ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : null;
    const sinceIso = since ? since.toISOString() : null;

    const subRows = await db.select({
      id: schema.subscriptions.id,
      status: schema.subscriptions.status,
      createdAt: schema.subscriptions.createdAt,
      currentPeriodEnd: schema.subscriptions.currentPeriodEnd,
      planName: schema.plans.name
    })
    .from(schema.subscriptions)
    .leftJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .orderBy(desc(schema.subscriptions.createdAt))
    .limit(50);

    const subscriptions = subRows
      .filter(s => !sinceIso || String(s.createdAt) >= sinceIso)
      .map(s => ({
        id: s.id,
        plan: s.planName || '—',
        status: s.status,
        createdAt: s.createdAt,
        currentPeriodEnd: s.currentPeriodEnd
      }));

    const rentRows = await db.select({
      id: schema.rentals.id,
      status: schema.rentals.status,
      startsAt: schema.rentals.startsAt,
      expiresAt: schema.rentals.expiresAt,
      createdAt: schema.rentals.createdAt,
      trackId: schema.rentals.trackId,
      trackTitle: schema.tracks.title,
      orderId: schema.rentals.orderId
    })
    .from(schema.rentals)
    .leftJoin(schema.tracks, eq(schema.tracks.id, schema.rentals.trackId))
    .orderBy(desc(schema.rentals.createdAt))
    .limit(50);

    const orderIds = rentRows.map(r => r.orderId).filter(Boolean);
    let ordersById = new Map();
    if (orderIds.length) {
      const orderRows = await db.select({
        id: schema.orders.id,
        totalCents: schema.orders.totalCents,
        status: schema.orders.status
      }).from(schema.orders).where(inArray(schema.orders.id, orderIds));
      ordersById = new Map(orderRows.map(o => [o.id, o]));
    }

    const rentals = rentRows
      .filter(r => !sinceIso || String(r.createdAt) >= sinceIso)
      .map(r => {
        const order = r.orderId ? ordersById.get(r.orderId) : null;
        return {
          id: r.id,
          trackId: r.trackId,
          trackTitle: r.trackTitle || '—',
          status: r.status,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          amountCents: order?.status === 'PAID' ? order.totalCents : 0
        };
      });

    const activeSubs = subscriptions.filter(s =>
      ['ACTIVE', 'AUTHORIZED', 'TRIALING'].includes(String(s.status || '').toUpperCase())
    ).length;

    const rentalRevenueCents = rentals.reduce(
      (sum, r) => sum + (Number.isFinite(r.amountCents) ? r.amountCents : 0),
      0
    );

    const summary = {
      subscriptions: { total: subscriptions.length, active: activeSubs },
      rentals: { total: rentals.length, revenueCents: rentalRevenueCents },
      payments: { total: 0, failed: 0, pending: 0 }
    };

    return sendJson(res, 200, {
      ok: true,
      period: days ? String(days) : 'all',
      subscriptions,
      rentals,
      payments: [],
      summary
    });
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
  return String(s || 'audio').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._ -]+/g, '_').trim() || 'audio';
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}