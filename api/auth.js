/* ============================================================
   api/auth.js — Autenticação consolidada
   ------------------------------------------------------------
   POST /api/auth?action=login    → login
   POST /api/auth?action=signup   → cadastro
   POST /api/auth?action=logout   → encerra sessão
   POST /api/auth?action=refresh  → rotaciona tokens
   GET  /api/auth?action=me       → dados do usuário + rentals
   HEAD /api/auth?action=me       → só headers

   - Cookies __Host- em produção (HttpOnly + SameSite=Lax)
   - CSRF: Origin check em métodos mutantes
   - Nenhum segredo exposto ao cliente
   - Rate limit por IP + e-mail (Redis/KV)
   - Auditoria em todas as ações
   ============================================================ */

'use strict';

const {
  sendJson,
  supabaseRequest,
  supabaseAdminRequest,
  setAuthCookies,
  clearAuthCookies,
  getAuthUser,
  getAccessToken,
  getRefreshToken,
  getPlanForUser,
  VALID_PLANS,
  checkAndIncrement,
  resetBucket,
  audit,
  checkOrigin
} = require('./_lib');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MAX_NAME_LENGTH = 120;
const MIN_NAME_LENGTH = 2;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 256;
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_REGEX = /^[\p{L}\p{N}\s.'-]+$/u;

const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1',
  'qwerty123', 'qwertyuiop', 'senha123', 'admin123', 'letmein',
  'welcome1', 'iloveyou', 'abc12345', '1q2w3e4r', '1qaz2wsx'
]);

const MAX_EMAILS_PER_HOUR = 3;
const MAX_LOGIN_ATTEMPTS_PER_IP = 30;
const MAX_LOGIN_ATTEMPTS_PER_EMAIL = 10;
const MAX_SIGNUPS_PER_IP = 5;
const MIN_RESPONSE_MS = 350;

const MAX_RENTALS = 100;

const GENERIC_AUTH_ERROR = 'E-mail ou senha incorretos.';
const GENERIC_SIGNUP_ERROR = 'Não foi possível concluir o cadastro.';
const GENERIC_RATE_ERROR = 'Muitas tentativas. Tente novamente mais tarde.';
const GENERIC_ERROR = 'Serviço indisponível.';

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Allow', 'GET, HEAD, POST');
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
      console.warn('[auth] Origin rejeitada:', {
        action,
        method,
        origin: req.headers.origin || req.headers.referer || null
      });
      return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
    }
  }

  switch (action) {
    case 'login':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleLogin(req, res);

    case 'signup':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleSignup(req, res);

    case 'logout':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleLogout(req, res);

    case 'refresh':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleRefresh(req, res);

    case 'me':
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
      return handleMe(req, res);

    default:
      return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
  }
};

// ─────────────────────────────────────────────────────────────
// ACTION: login
// ─────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const startedAt = Date.now();
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const body = parseBody(req);

  const email = normalizeEmail(body.email);
  const password =
    typeof body.password === 'string'
      ? body.password.slice(0, MAX_PASSWORD_LENGTH)
      : '';

  if (!EMAIL_REGEX.test(email) || password.length < MIN_PASSWORD_LENGTH) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_AUTH_ERROR });
  }

  const [ipRate, emailRate] = await Promise.all([
    checkAndIncrement(`login:ip:${ip}`, MAX_LOGIN_ATTEMPTS_PER_IP, 15 * 60 * 1000),
    checkAndIncrement(`login:email:${email}`, MAX_LOGIN_ATTEMPTS_PER_EMAIL, 15 * 60 * 1000)
  ]);

  if (ipRate.limited || emailRate.limited) {
    const retryAfter = Math.max(ipRate.retryAfter, emailRate.retryAfter, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE_ERROR });
  }

  try {
    const result = await supabaseRequest('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });

    const ok = result?.response?.ok && result?.body?.access_token;

    if (!ok) {
      await equalizeTiming(startedAt, MIN_RESPONSE_MS);
      await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_credentials' });
      return sendJson(res, 401, { ok: false, error: GENERIC_AUTH_ERROR });
    }

    const user = result.body.user || {};
    const metadata = user.user_metadata || {};

    await resetBucket(`login:email:${email}`).catch(() => {});
    setAuthCookies(res, result.body);

    await audit('login', {
      email, userId: user.id, ip, userAgent, success: true, reason: null
    });

    await equalizeTiming(startedAt, MIN_RESPONSE_MS);

    return sendJson(res, 200, {
      ok: true,
      user: {
        id: String(user.id || ''),
        email: sanitizeEmail(user.email || email),
        name: sanitizeName(metadata.name),
        plan: 'free' // plano real vem do /me
      }
    });
  } catch (error) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: error.code || 'error' });
    console.error('[auth/login]', error.code || error.message);
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// ACTION: signup
// ─────────────────────────────────────────────────────────────
async function handleSignup(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const body = parseBody(req);

  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const password =
    typeof body.password === 'string'
      ? body.password.slice(0, MAX_PASSWORD_LENGTH)
      : '';

  if (
    !isValidName(name) ||
    !EMAIL_REGEX.test(email) ||
    !isValidPassword(password)
  ) {
    await audit('signup', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_SIGNUP_ERROR });
  }

  const [ipRate, emailRate] = await Promise.all([
    checkAndIncrement(`signup:ip:${ip}`, MAX_SIGNUPS_PER_IP, 60 * 60 * 1000),
    checkAndIncrement(`signup:email:${email}`, MAX_EMAILS_PER_HOUR, 60 * 60 * 1000)
  ]);

  if (ipRate.limited || emailRate.limited) {
    const retryAfter = Math.max(ipRate.retryAfter, emailRate.retryAfter, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await audit('signup', { email, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE_ERROR });
  }

  try {
    const result = await supabaseRequest('/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        data: { name },
        options: process.env.SIGNUP_REDIRECT_URL
          ? { emailRedirectTo: process.env.SIGNUP_REDIRECT_URL }
          : undefined
      })
    });

    if (!result.response.ok || !result.body || !result.body.user) {
      await audit('signup', {
        email, ip, userAgent, success: false,
        reason: `supabase_${result.response.status}`
      });
      return sendJson(res, 400, { ok: false, error: GENERIC_SIGNUP_ERROR });
    }

    const user = result.body.user;
    const identities = Array.isArray(user.identities) ? user.identities : null;
    const isDuplicate = identities !== null && identities.length === 0;

    if (isDuplicate) {
      await audit('signup', { email, ip, userAgent, success: false, reason: 'email_exists' });
      return sendJson(res, 200, {
        ok: true,
        requiresEmailConfirmation: true,
        user: { id: null, email, name }
      });
    }

    await ensureProfile(user.id, { email, name });

    const requiresEmailConfirmation = !result.body.access_token;

    if (result.body.access_token && result.body.refresh_token) {
      setAuthCookies(res, result.body);
    }

    await audit('signup', {
      email, ip, userAgent, userId: user.id, success: true,
      reason: requiresEmailConfirmation ? 'pending_confirmation' : 'authenticated'
    });

    return sendJson(res, 201, {
      ok: true,
      requiresEmailConfirmation,
      user: {
        id: user.id,
        email: sanitizeEmail(user.email || email),
        name,
        plan: 'free'
      }
    });
  } catch (error) {
    await audit('signup', {
      email, ip, userAgent, success: false, reason: error.code || 'error'
    });
    console.error('[auth/signup]', error.code || error.message);
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// ACTION: logout
// ─────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  const accessToken = getAccessToken(req) || null;
  const refreshToken = getRefreshToken(req) || null;

  let revokedAccess = false;
  let revokedRefresh = false;
  let reason = null;

  if (accessToken) {
    try {
      const r = await withTimeout(
        supabaseRequest('/auth/v1/logout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + accessToken }
        }),
        3000
      );
      revokedAccess = !!r?.response?.ok;
      if (!revokedAccess) reason = 'access_revoke_failed';
    } catch (err) {
      reason = err.code === 'TIMEOUT' ? 'access_revoke_timeout' : 'access_revoke_error';
    }
  }

  if (refreshToken) {
    try {
      const r = await withTimeout(
        supabaseRequest('/auth/v1/logout?scope=global', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + refreshToken }
        }),
        3000
      );
      revokedRefresh = !!r?.response?.ok;
      if (!revokedRefresh) reason = reason || 'refresh_revoke_failed';
    } catch (err) {
      reason = reason || (err.code === 'TIMEOUT' ? 'refresh_revoke_timeout' : 'refresh_revoke_error');
    }
  }

  try {
    clearAuthCookies(res);
  } catch (err) {
    reason = reason || 'cookie_clear_failed';
  }

  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');

  await audit('logout', {
    userId: null, ip, userAgent,
    success: revokedAccess || revokedRefresh || (!accessToken && !refreshToken),
    reason
  });

  return sendJson(res, 200, {
    ok: true,
    revoked: { access: revokedAccess, refresh: revokedRefresh }
  });
}

// ─────────────────────────────────────────────────────────────
// ACTION: refresh
// ─────────────────────────────────────────────────────────────
async function handleRefresh(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const refreshToken = getRefreshToken(req);

  if (!refreshToken) {
    return sendJson(res, 401, { ok: false, error: 'Sessão expirada.' });
  }

  try {
    const result = await supabaseRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken })
    });

    if (
      !result.response.ok ||
      !result.body ||
      !result.body.access_token ||
      !result.body.refresh_token
    ) {
      clearAuthCookies(res);
      return sendJson(res, 401, { ok: false, error: 'Sessão expirada.' });
    }

    setAuthCookies(res, result.body);

    await audit('refresh', { ip, userAgent, success: true, reason: null });

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error('[auth/refresh]', error.code || error.message);
    clearAuthCookies(res);
    return sendJson(res, 401, { ok: false, error: 'Sessão expirada.' });
  }
}

// ─────────────────────────────────────────────────────────────
// ACTION: me
// ─────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const method = (req.method || 'GET').toUpperCase();

  let user = null;
  try {
    user = await getAuthUser(req);
  } catch (error) {
    return mapAuthError(res, error, method);
  }

  if (!user || !user.id) {
    try {
      const refreshed = await tryRefresh(req, res);
      if (refreshed) user = await getAuthUser(req);
    } catch (err) {
      console.warn('[auth/me] refresh falhou:', err?.message);
    }
  }

  if (!user || !user.id) {
    if (method === 'HEAD') {
      res.status(401);
      return res.end();
    }
    return sendJson(res, 401, { ok: false });
  }

  const [planResult, rentalsResult] = await Promise.allSettled([
    resolvePlan(user.id),
    getActiveRentals(user.id)
  ]);

  const plan =
    planResult.status === 'fulfilled' && VALID_PLANS.has(planResult.value)
      ? planResult.value
      : 'free';

  const rentals =
    rentalsResult.status === 'fulfilled' && Array.isArray(rentalsResult.value)
      ? rentalsResult.value
      : [];

  const payload = {
    ok: true,
    user: {
      id: String(user.id),
      email: sanitizeEmail(user.email),
      name: sanitizeName(user.user_metadata && user.user_metadata.name),
      plan
    },
    rentals
  };

  if (method === 'HEAD') {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end();
  }

  return sendJson(res, 200, payload);
}

// ─────────────────────────────────────────────────────────────
// Helpers de plano + rentals
// ─────────────────────────────────────────────────────────────
async function resolvePlan(userId) {
  try {
    return await getPlanForUser(userId);
  } catch {
    try {
      const r = await supabaseAdminRequest(
        `/rest/v1/effective_plan?user_id=eq.${encodeURIComponent(userId)}&select=plan&limit=1`,
        { method: 'GET' }
      );
      if (r.response.ok && Array.isArray(r.body) && r.body[0]) {
        const p = r.body[0].plan;
        return VALID_PLANS.has(p) ? p : 'free';
      }
    } catch {}
    return 'free';
  }
}

async function getActiveRentals(userId) {
  const nowIso = new Date().toISOString();

  const rentalsRes = await supabaseAdminRequest(
    `/rest/v1/rentals?user_id=eq.${encodeURIComponent(userId)}` +
      `&status=eq.active` +
      `&expires_at=gt.${encodeURIComponent(nowIso)}` +
      `&select=track_id,expires_at` +
      `&order=expires_at.desc` +
      `&limit=${MAX_RENTALS}`,
    { method: 'GET' }
  );

  if (!rentalsRes.response.ok || !Array.isArray(rentalsRes.body)) return [];

  const rows = rentalsRes.body;
  if (!rows.length) return [];

  const trackIds = [...new Set(rows.map((r) => r.track_id).filter(Boolean))];
  if (!trackIds.length) return [];

  const tracksRes = await supabaseAdminRequest(
    `/rest/v1/tracks?id=in.(${trackIds.join(',')})&select=id,album_id,track_index`,
    { method: 'GET' }
  );

  const trackKeyById = new Map();
  if (tracksRes.response.ok && Array.isArray(tracksRes.body)) {
    for (const t of tracksRes.body) {
      trackKeyById.set(t.id, `${t.album_id}:${t.track_index}`);
    }
  }

  return rows
    .map((r) => {
      const trackKey = trackKeyById.get(r.track_id);
      if (!trackKey) return null;
      return { trackKey, expiresAt: r.expires_at };
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// Helpers de sessão
// ─────────────────────────────────────────────────────────────
async function tryRefresh(req, res) {
  const refreshToken = getRefreshToken(req);
  if (!refreshToken) return false;

  try {
    const result = await supabaseRequest('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken })
    });

    if (!result.response.ok || !result.body?.access_token) {
      clearAuthCookies(res);
      return false;
    }

    setAuthCookies(res, result.body);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers de perfil
// ─────────────────────────────────────────────────────────────
async function ensureProfile(userId, { email, name }) {
  if (!userId) return false;

  try {
    const existing = await supabaseAdminRequest(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=id`,
      { method: 'GET' }
    );

    if (existing.response.ok && Array.isArray(existing.body) && existing.body.length > 0) {
      return true;
    }

    const insert = await supabaseAdminRequest('/rest/v1/profiles', {
      method: 'POST',
      headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
      body: JSON.stringify({
        id: userId,
        email,
        name
        // profiles NÃO tem coluna plan — plano vive em subscriptions
      })
    });

    return insert.response.ok;
  } catch (err) {
    console.error('[auth] ensureProfile:', err.code || err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers de validação / sanitização
// ─────────────────────────────────────────────────────────────
function parseAction(query) {
  if (!query) return null;
  const raw = String(query.action || '').trim().toLowerCase();
  if (!raw) return null;
  if (!['login', 'signup', 'logout', 'refresh', 'me'].includes(raw)) return null;
  return raw;
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .slice(0, MAX_EMAIL_LENGTH);
}

function sanitizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
}

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

function isValidName(name) {
  return (
    name.length >= MIN_NAME_LENGTH &&
    name.length <= MAX_NAME_LENGTH &&
    NAME_REGEX.test(name)
  );
}

function isValidPassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return false;
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return false;
  if (/^(.)\1+$/.test(password)) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// Helpers HTTP
// ─────────────────────────────────────────────────────────────
function clientIp(req) {
  const h = req.headers || {};
  const fwd =
    h['x-vercel-forwarded-for'] ||
    h['x-real-ip'] ||
    h['x-forwarded-for'];
  return String(fwd || (req.socket && req.socket.remoteAddress) || 'unknown')
    .split(',')[0]
    .trim();
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
}

function mapAuthError(res, error, method) {
  const status =
    error.code === 'UNAUTHORIZED' ? 401 :
    error.code === 'NOT_CONFIGURED' ? 503 :
    error.code === 'TIMEOUT' ? 504 :
    502;

  const message =
    error.code === 'UNAUTHORIZED' ? 'Não autorizado.' :
    error.code === 'TIMEOUT' ? 'Tempo esgotado.' :
    GENERIC_ERROR;

  if (method === 'HEAD') {
    res.status(status);
    return res.end();
  }
  return sendJson(res, status, { ok: false, error: message });
}

function equalizeTiming(startedAt, minMs) {
  const remaining = minMs - (Date.now() - startedAt);
  if (remaining > 0) return new Promise((r) => setTimeout(r, remaining));
  return Promise.resolve();
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms)
    )
  ]);
}
