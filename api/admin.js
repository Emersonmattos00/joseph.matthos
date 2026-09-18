'use strict';

const crypto = require('crypto');

const {
  sendJson,
  methodNotAllowed,
  parseBody,
  parseCookies,
  clientIp,
  supabaseAdminRequest,
  checkAndIncrement,
  audit,
  VALID_PLANS,
  signHmac,
  verifyHmac,
  verifyScrypt,
  timingSafeEq,
  IS_PROD
} = require('./_lib');

const SESSION_COOKIE_PROD = '__Host-jm_admin';
const SESSION_COOKIE_DEV = 'jm_admin';
const SESSION_COOKIE = IS_PROD ? SESSION_COOKIE_PROD : SESSION_COOKIE_DEV;

const SESSION_MAX_AGE = 60 * 60 * 4;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const CONTENT_KEY = 'default';
const MAX_CONTENT_BYTES = 2_000_000;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;
const SALES_LIMIT = 500;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']);
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_AUDIO_SIZE = 4 * 1024 * 1024;

const VALID_ACTIONS = new Set([
  'login', 'session', 'logout', 'content', 'upload', 'users', 'sales',
  '__gen_hash__'
]);

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

  // 🔍 TEMPORÁRIO
  if (action === '__gen_hash__') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    const b = parseBody(req);
    const password = String(b.password || '');
    if (!password) return sendJson(res, 400, { ok: false, error: 'password obrigatório' });
    const salt = crypto.randomBytes(16);
    return new Promise((resolve) => {
      crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => {
        if (err) return resolve(sendJson(res, 500, { ok: false, error: err.message }));
        resolve(sendJson(res, 200, {
          ok: true,
          hash: 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex'),
          password: password
        }));
      });
    });
  }

  if (action === 'login') {
    if (method !== 'POST') return methodNotAllowed(res, 'POST');
    return handleLogin(req, res);
  }

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

  const rate = await checkAndIncrement('admin-login:' + ip, MAX_LOGIN_ATTEMPTS, LOGIN_WINDOW_MS);
  if (rate.limited) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    return sendJson(res, 429, { ok: false, error: 'Muitas tentativas.' });
  }

  const body = parseBody(req);
  const user = String(body.user || '').trim();
  const pass = String(body.pass || '');

  const expectedUser = String(process.env.ADMIN_USER || '').trim();
  const hash = String(process.env.ADMIN_PASSWORD_HASH || '').trim();
  const secret = String(process.env.ADMIN_SESSION_SECRET || '').trim();

  if (!expectedUser || !hash || !secret) {
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
  }

  const userOk = timingSafeEq(user, expectedUser);
  const passOk = await verifyScrypt(pass, hash);

  if (!userOk || !passOk) {
    await audit('admin_login', { ip, userAgent, success: false, reason: 'invalid' });
    return sendJson(res, 401, { ok: false, error: 'Usuário ou senha incorretos.' });
  }

  const token = signHmac({ user: expectedUser, iat: Date.now() }, secret);
  const cookieAttrs = [
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + SESSION_MAX_AGE,
    IS_PROD ? 'Secure' : null
  ].filter(Boolean).join('; ');

  res.setHeader('Set-Cookie', SESSION_COOKIE + '=' + token + '; ' + cookieAttrs);
  await audit('admin_login', { ip, userAgent, success: true });
  return sendJson(res, 200, { ok: true, user: expectedUser });
}

// ─────────────────────────────────────────────────────────────
// SESSION / LOGOUT
// ─────────────────────────────────────────────────────────────
async function handleSession(req, res, session) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'HEAD') { res.status(200); return res.end(); }
  return sendJson(res, 200, { ok: true, user: session.user });
}

async function handleLogout(req, res, session) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0',
    IS_PROD ? 'Secure' : null].filter(Boolean).join('; ');

  res.setHeader('Set-Cookie', [
    SESSION_COOKIE + '=; ' + attrs,
    'jm_admin=; ' + attrs,
    '__Host-jm_admin=; ' + attrs
  ]);
  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');

  await audit('admin_logout', { actor: session.user, ip, userAgent, success: true });
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// CONTENT — GET
// ─────────────────────────────────────────────────────────────
async function handleGetContent(req, res) {
  try {
    const r = await supabaseAdminRequest(
      '/rest/v1/site_content?key=eq.' + CONTENT_KEY + '&select=data,version,updated_at&limit=1',
      { method: 'GET' }
    );
    if (!r.response.ok) {
      return sendJson(res, 502, {
        ok: false, error: 'Serviço indisponível.',
        _debug: { stage: 'content_get', status: r.response.status, body: r.body }
      });
    }
    const row = Array.isArray(r.body) ? r.body[0] : null;
    return sendJson(res, 200, {
      ok: true,
      data: row && typeof row.data === 'object' ? row.data : {},
      version: Number(row && row.version) || 0,
      updatedAt: (row && row.updated_at) || null
    });
  } catch (err) {
    return sendJson(res, 502, {
      ok: false, error: 'Serviço indisponível.',
      _debug: { stage: 'content_get_throw', message: err.message, code: err.code }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// CONTENT — PUT (com _debug detalhado)
// ─────────────────────────────────────────────────────────────
async function handlePutContent(req, res, session) {
  const body = parseBody(req);
  const data = body.data;
  const baseVersion = Number.isFinite(body.baseVersion) ? Number(body.baseVersion) : null;

  if (!data || typeof data !== 'object') {
    return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });
  }

  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
  if (bytes > MAX_CONTENT_BYTES) {
    return sendJson(res, 413, { ok: false, error: 'Conteúdo muito grande.' });
  }

  try {
    const current = await supabaseAdminRequest(
      '/rest/v1/site_content?key=eq.' + CONTENT_KEY + '&select=version,data',
      { method: 'GET' }
    );
    const currentRow = Array.isArray(current.body) ? current.body[0] : null;
    const currentVersion = (currentRow && currentRow.version) || 0;

    if (baseVersion !== null && baseVersion !== currentVersion) {
      return sendJson(res, 409, { ok: false, error: 'Conflito.', currentVersion: currentVersion });
    }

    const newVersion = currentVersion + 1;

    // Salva no histórico (best-effort)
    if (currentRow) {
      const histRes = await supabaseAdminRequest('/rest/v1/site_content_history', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ key: CONTENT_KEY, data: currentRow.data, version: currentRow.version })
      });
      if (!histRes.response.ok) {
        console.warn('[admin/content] history insert falhou:', histRes.response.status);
      }
    }

    // Upsert
    const upsert = await supabaseAdminRequest(
      '/rest/v1/site_content?on_conflict=key',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          key: CONTENT_KEY, data: data, version: newVersion,
          updated_at: new Date().toISOString()
        })
      }
    );

    if (!upsert.response.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: 'Serviço indisponível.',
        _debug: {
          stage: 'content_put_upsert',
          supabaseStatus: upsert.response.status,
          supabaseBody: upsert.body,
          newVersion: newVersion,
          dataSize: bytes
        }
      });
    }

    await audit('content.update', { actor: session.user, metadata: { version: newVersion, bytes: bytes } });
    return sendJson(res, 200, { ok: true, version: newVersion });
  } catch (err) {
    return sendJson(res, 502, {
      ok: false, error: 'Serviço indisponível.',
      _debug: { stage: 'content_put_throw', message: err.message, code: err.code }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// UPLOAD
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

  const isImage = kind === 'image';
  const isAudio = kind === 'audio';
  if (!isImage && !isAudio) return sendJson(res, 400, { ok: false, error: 'Tipo inválido.' });
  if (isImage && !ALLOWED_IMAGE_TYPES.has(contentType)) return sendJson(res, 415, { ok: false, error: 'Formato inválido.' });
  if (isAudio && !ALLOWED_AUDIO_TYPES.has(contentType)) return sendJson(res, 415, { ok: false, error: 'Formato inválido.' });

  let buffer;
  try { buffer = Buffer.from(base64, 'base64'); }
  catch (e) { return sendJson(res, 400, { ok: false, error: 'Base64 inválido.' }); }

  if (isImage && buffer.length > MAX_IMAGE_SIZE) return sendJson(res, 413, { ok: false, error: 'Imagem muito grande.' });
  if (isAudio && buffer.length > MAX_AUDIO_SIZE) return sendJson(res, 413, { ok: false, error: 'Áudio muito grande.' });

  const folder = isImage ? 'images' : 'audio';
  const ext = filename.split('.').pop() || (isImage ? 'jpg' : 'mp3');
  const uniqueName = Date.now() + '_' + crypto.randomBytes(6).toString('hex') + '.' + ext;
  const path = folder + '/' + uniqueName;

  const url = process.env.SUPABASE_URL + '/storage/v1/object/site-assets/' + path;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buffer
    });
    if (!response.ok) {
      return sendJson(res, 502, {
        ok: false, error: 'Falha no upload.',
        _debug: { stage: 'storage_upload', status: response.status }
      });
    }
  } catch (e) {
    return sendJson(res, 502, {
      ok: false, error: 'Falha no upload.',
      _debug: { stage: 'storage_throw', message: e.message }
    });
  }

  const publicUrl = process.env.SUPABASE_URL + '/storage/v1/object/public/site-assets/' + path;
  await audit('upload', { actor: session.user, target: path, metadata: { size: buffer.length } });
  return sendJson(res, 200, { ok: true, url: publicUrl, path: path });
}

// ─────────────────────────────────────────────────────────────
// USERS — GET (com _debug)
// ─────────────────────────────────────────────────────────────
async function handleGetUsers(req, res) {
  const limit = clampLimit(req.query && req.query.limit);

  try {
    const profilesRes = await supabaseAdminRequest(
      '/rest/v1/profiles?select=id,email,name,created_at&order=created_at.desc&limit=' + limit,
      { method: 'GET', headers: { Prefer: 'count=exact' } }
    );

    if (!profilesRes.response.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: 'Falha.',
        _debug: {
          stage: 'users_profiles',
          status: profilesRes.response.status,
          body: profilesRes.body
        }
      });
    }

    const profiles = Array.isArray(profilesRes.body) ? profilesRes.body : [];
    const total = parseTotalFromHeaders(profilesRes.response.headers) || profiles.length;

    const plansRes = await supabaseAdminRequest(
      '/rest/v1/effective_plan?select=user_id,plan',
      { method: 'GET' }
    );

    if (!plansRes.response.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: 'Falha.',
        _debug: {
          stage: 'users_plans',
          status: plansRes.response.status,
          body: plansRes.body
        }
      });
    }

    const planMap = new Map();
    if (Array.isArray(plansRes.body)) {
      plansRes.body.forEach(function(row) { planMap.set(row.user_id, row.plan); });
    }

    const users = profiles.map(function(p) {
      return {
        id: p.id, email: p.email || '', name: p.name || '',
        plan: planMap.get(p.id) || 'free',
        createdAt: p.created_at
      };
    });

    return sendJson(res, 200, { ok: true, users: users, total: total, limit: limit });
  } catch (err) {
    return sendJson(res, 502, {
      ok: false, error: 'Falha.',
      _debug: { stage: 'users_throw', message: err.message, code: err.code }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// USERS — PATCH
// ─────────────────────────────────────────────────────────────
async function handlePatchUser(req, res, session) {
  const body = parseBody(req);
  const userId = String(body.userId || '').trim();
  const plan = String(body.plan || '').trim().toLowerCase();

  if (!isUuid(userId)) return sendJson(res, 400, { ok: false, error: 'userId inválido.' });
  if (!VALID_PLANS.has(plan)) return sendJson(res, 400, { ok: false, error: 'Plano inválido.' });

  try {
    const userCheck = await supabaseAdminRequest(
      '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) + '&select=id,email&limit=1',
      { method: 'GET' }
    );
    if (!userCheck.response.ok || !userCheck.body || !userCheck.body[0]) {
      return sendJson(res, 404, { ok: false, error: 'Usuário não encontrado.' });
    }

    if (plan === 'free') {
      const cancelRes = await supabaseAdminRequest(
        '/rest/v1/subscriptions?user_id=eq.' + encodeURIComponent(userId) + '&status=in.(authorized,trialing)',
        {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'canceled', canceled_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        }
      );
      if (!cancelRes.response.ok) {
        return sendJson(res, 502, {
          ok: false, error: 'Falha.',
          _debug: { stage: 'patch_cancel', status: cancelRes.response.status, body: cancelRes.body }
        });
      }
    } else {
      const manualId = 'manual_' + userId + '_' + Date.now();
      const insertRes = await supabaseAdminRequest('/rest/v1/subscriptions', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
        body: JSON.stringify({
          user_id: userId, plan: plan, status: 'authorized',
          provider: 'manual', provider_sub_id: manualId,
          started_at: new Date().toISOString(), updated_at: new Date().toISOString()
        })
      });
      if (!insertRes.response.ok) {
        return sendJson(res, 502, {
          ok: false, error: 'Falha.',
          _debug: { stage: 'patch_insert', status: insertRes.response.status, body: insertRes.body }
        });
      }
    }

    await audit('user.plan.change', { actor: session.user, target: userId, metadata: { plan: plan } });
    return sendJson(res, 200, { ok: true, plan: plan });
  } catch (err) {
    return sendJson(res, 502, {
      ok: false, error: 'Falha.',
      _debug: { stage: 'patch_throw', message: err.message }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SALES (com _debug)
// ─────────────────────────────────────────────────────────────
async function handleGetSales(req, res) {
  const days = parseDays(req.query && req.query.days);
  const since = days ? new Date(Date.now() - days * 86400 * 1000).toISOString() : null;

  try {
    const subs = await fetchTable('subscriptions',
      'select=id,user_id,plan,status,current_period_end,created_at',
      since);
    const rentals = await fetchTable('rentals',
      'select=id,user_id,track_id,amount_cents,status,expires_at,created_at',
      since);
    const payments = await fetchTable('payments_events',
      'select=id,event_type,external_id,processed_at,failure_reason,created_at',
      since);

    if (!subs.ok) return sendJson(res, 502, { ok: false, error: 'Falha.', _debug: { stage: 'sales_subs', ...subs.debug } });
    if (!rentals.ok) return sendJson(res, 502, { ok: false, error: 'Falha.', _debug: { stage: 'sales_rentals', ...rentals.debug } });
    if (!payments.ok) return sendJson(res, 502, { ok: false, error: 'Falha.', _debug: { stage: 'sales_payments', ...payments.debug } });

    return sendJson(res, 200, {
      ok: true,
      period: days ? days + 'd' : 'all',
      limit: SALES_LIMIT,
      subscriptions: subs.data,
      rentals: rentals.data,
      payments: payments.data,
      summary: buildSummary(subs.data, rentals.data, payments.data)
    });
  } catch (err) {
    return sendJson(res, 502, {
      ok: false, error: 'Falha.',
      _debug: { stage: 'sales_throw', message: err.message }
    });
  }
}

async function fetchTable(table, select, since) {
  const filter = since ? '&created_at=gte.' + encodeURIComponent(since) : '';
  const r = await supabaseAdminRequest(
    '/rest/v1/' + table + '?' + select + filter + '&order=created_at.desc&limit=' + SALES_LIMIT,
    { method: 'GET' }
  );
  if (!r.response.ok) {
    return { ok: false, debug: { status: r.response.status, body: r.body } };
  }
  return { ok: true, data: Array.isArray(r.body) ? r.body : [] };
}

function buildSummary(subscriptions, rentals, payments) {
  const activeSubs = subscriptions.filter(function(s) { return s.status === 'authorized'; });
  const totalRentalCents = rentals.reduce(function(sum, r) { return sum + (Number(r.amount_cents) || 0); }, 0);
  const failedEvents = payments.filter(function(p) { return p.failure_reason; });
  const pendingEvents = payments.filter(function(p) { return !p.processed_at && !p.failure_reason; });
  return {
    subscriptions: {
      total: subscriptions.length, active: activeSubs.length,
      byPlan: countBy(subscriptions, 'plan'),
      byStatus: countBy(subscriptions, 'status')
    },
    rentals: {
      total: rentals.length, revenueCents: totalRentalCents,
      active: rentals.filter(function(r) { return r.status === 'active' && new Date(r.expires_at) > new Date(); }).length
    },
    payments: {
      total: payments.length,
      processed: payments.filter(function(p) { return p.processed_at; }).length,
      failed: failedEvents.length, pending: pendingEvents.length
    }
  };
}

function countBy(arr, key) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const k = String(arr[i][key] || 'unknown');
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function verifySession(req) {
  const cookies = parseCookies((req.headers && req.headers.cookie) || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const secret = String(process.env.ADMIN_SESSION_SECRET || '');
  if (!secret) return null;
  return verifyHmac(token, secret, SESSION_MAX_AGE * 1000);
}

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

function parseDays(raw) {
  if (raw === 'all' || raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return [7, 30, 90, 365].indexOf(n) >= 0 ? n : null;
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
