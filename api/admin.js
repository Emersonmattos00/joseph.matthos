/* ============================================================
   api/admin.js — Painel administrativo
   ------------------------------------------------------------
   POST /api/admin?action=login      → login admin
   GET  /api/admin?action=session    → valida sessão
   POST /api/admin?action=logout     → encerra sessão
   GET  /api/admin?action=content    → lê conteúdo
   PUT  /api/admin?action=content    → salva conteúdo
   POST /api/admin?action=upload     → upload (imagem/áudio)
   GET  /api/admin?action=users      → lista usuários + planos
   PATCH /api/admin?action=users     → altera plano manualmente
   GET  /api/admin?action=sales      → assinaturas + rentals + eventos
   GET  /api/admin?action=audit      → eventos de auditoria

   - Sessão via cookie __Host-jm_admin (HttpOnly + HMAC assinado)
   - ADMIN_SESSION_SECRET exige mínimo de 32 caracteres
   - CSRF: Origin check em todos os métodos mutantes
   - Rate limit por IP no login (fail-closed: bloqueia se KV cair)
   - Auditoria em toda escrita
   - Upload roteia para o bucket correto:
       image         → site-assets (público)
       audio-preview → audio-preview (público)
       audio-full    → audio-premium (privado)
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
  'gen-hash'
]);

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
  res.setHeader('Allow', 'GET, HEAD, POST, PUT, PATCH');
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

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
