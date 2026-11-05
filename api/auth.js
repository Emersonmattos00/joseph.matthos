/* ============================================================
   api/auth.js — Autenticação própria (Neon + JWT)
   ------------------------------------------------------------
   Correções aplicadas (auditoria auth):
   - Remove `noTimestamp: true` (defesa em profundidade)
   - Adiciona `tokenType: 'access' | 'refresh'` nos JWTs
   - Implementa `?action=refresh` (valida tokenType + emite novos)
   - getActiveRentals: `trackKey: 'album:${albumId}'` e
     `trackKey: '${albumId}:${trackNumber}'` (compatível com
     frontend) + `trackId`/`albumId` para retrocompat
   - /me: plano degradado ou rentals falho → 503 explícito
   - readPassword/readEmail: rejeita excesso (não trunca)
   - assertJwtConfiguration() antes de login/signup
   - parseAction exige string
   - verifyPassword valida formato do hash (mesmo padrão _lib)
   - Login DB down → 503 (não 502)
   - signup DB down → 503

   TODO (próxima rodada, não bloqueia deploy):
   - Tabela `auth_sessions` para revogar refresh no logout
   - Migração de hashes antigos para `verifyScrypt` do _lib.js
   ============================================================ */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { eq, and, gt, lte } = require('drizzle-orm');

const { users, rentals, tracks } = require('../src/schema.js');

const {
  sendJson,
  setAuthCookies,
  clearAuthCookies,
  getPlanForUserDetailed,
  getAuthUser,
  VALID_PLANS,
  checkAndIncrement,
  resetBucket,
  audit,
  checkOrigin,
  clientIp,
} = require('./_lib');

const { db, neonSql } = require('./_db');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MAX_NAME_LENGTH = 120;
const MIN_NAME_LENGTH = 2;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 256;
const MAX_PASSWORD_BYTES = 1024;
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_REGEX = /^[\p{L}\p{N}\s.'-]+$/u;

const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1',
  'qwerty123', 'qwertyuiop', 'senha123', 'admin123', 'letmein',
  'welcome1', 'iloveyou', 'abc12345', '1q2w3e4r', '1qaz2wsx'
]);

const MAX_EMAILS_PER_HOUR = 3;
const MAX_LOGIN_ATTEMPTS_PER_IP = 60;
const MAX_LOGIN_ATTEMPTS_PER_EMAIL = 10;
const MAX_SIGNUPS_PER_IP = 10;
const MIN_RESPONSE_MS = 350;

const MAX_RENTALS = 100;

const ACCESS_MAX_AGE_SEC = 60 * 60;
const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const GENERIC_AUTH_ERROR = 'E-mail ou senha incorretos.';
const GENERIC_SIGNUP_ERROR = 'Não foi possível concluir o cadastro.';
const GENERIC_RATE_ERROR = 'Muitas tentativas. Tente novamente mais tarde.';
const GENERIC_ERROR = 'Serviço indisponível.';

const DB_DOWN_CODES = new Set([
  'AUTH_DATABASE_UNAVAILABLE',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  '08006',
  '08001',
  '08003'
]);

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
      if (method !== 'GET' && method !== 'HEAD') {
        return methodNotAllowed(res, 'GET, HEAD');
      }
      return handleMe(req, res);
    default:
      return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
  }
};

// ─────────────────────────────────────────────────────────────
// JWT — par de tokens (tokenType + iat/exp explícitos)
// ─────────────────────────────────────────────────────────────
function assertJwtConfiguration() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    const err = new Error('JWT_SECRET ausente ou insuficiente.');
    err.code = 'JWT_CONFIGURATION_ERROR';
    throw err;
  }
  return secret;
}

function signTokenPair(user) {
  const secret = assertJwtConfiguration();

  const now = Math.floor(Date.now() / 1000);
  const accessExp = now + ACCESS_MAX_AGE_SEC;
  const refreshExp = now + REFRESH_MAX_AGE_SEC;

  const base = { id: user.id, email: user.email };

  // NÃO usar noTimestamp: o jsonwebtoken adiciona iat
  // automaticamente — e nós também passamos explicitamente.
  // O token sai com iat correto em ambos os casos.
  const options = {
    algorithm: 'HS256',
    issuer: 'josephmatthos',
    audience: 'josephmatthos-platform'
  };

  const access_token = jwt.sign(
    { ...base, tokenType: 'access', iat: now, exp: accessExp },
    secret,
    options
  );

  const refresh_token = jwt.sign(
    { ...base, tokenType: 'refresh', iat: now, exp: refreshExp },
    secret,
    options
  );

  return {
    access_token,
    refresh_token,
    iat: now,
    exp: accessExp
  };
}

function verifyRefreshToken(token) {
  try {
    const secret = assertJwtConfiguration();
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      issuer: 'josephmatthos',
      audience: 'josephmatthos-platform'
    });

    const now = Math.floor(Date.now() / 1000);

    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.tokenType !== 'refresh' ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= now ||
      payload.iat > now + 30 ||
      payload.exp - payload.iat > REFRESH_MAX_AGE_SEC
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Hash de senha (scrypt) — formato compatível com _lib.verifyScrypt
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt.toString('hex')}$${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    try {
      const parts = String(storedHash).split('$');
      if (parts.length !== 3) return resolve(false);

      const [algo, saltHex, hashHex] = parts;

      if (
        algo !== 'scrypt' ||
        !/^[a-f0-9]{32,128}$/i.test(saltHex) ||
        !/^[a-f0-9]{64,128}$/i.test(hashHex)
      ) {
        return resolve(false);
      }

      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');

      crypto.scrypt(password, salt, expected.length, (err, derived) => {
        if (err) return resolve(false);
        try {
          resolve(
            derived.length === expected.length &&
            crypto.timingSafeEqual(derived, expected)
          );
        } catch {
          resolve(false);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ACTION: login
// ─────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const startedAt = Date.now();
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const body = parseBody(req);

  try {
    assertJwtConfiguration();
  } catch {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    return sendJson(res, 503, { ok: false, error: GENERIC_ERROR });
  }

  const email = readEmail(body.email);
  const password = readPassword(body.password);

  if (!EMAIL_REGEX.test(email) || password === null) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_AUTH_ERROR });
  }

  const [ipRate, emailRate] = await Promise.all([
    checkAndIncrement(`login:ip:${ip}`, MAX_LOGIN_ATTEMPTS_PER_IP, 15 * 60 * 1000, { failClosed: true }),
    checkAndIncrement(`login:email:${email}`, MAX_LOGIN_ATTEMPTS_PER_EMAIL, 15 * 60 * 1000, { failClosed: true })
  ]);

  if (ipRate.limited || emailRate.limited) {
    const retryAfter = Math.max(ipRate.retryAfter, emailRate.retryAfter, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE_ERROR });
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user || !user.passwordHash) {
      await equalizeTiming(startedAt, MIN_RESPONSE_MS);
      await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_credentials' });
      return sendJson(res, 401, { ok: false, error: GENERIC_AUTH_ERROR });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      await equalizeTiming(startedAt, MIN_RESPONSE_MS);
      await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_credentials' });
      return sendJson(res, 401, { ok: false, error: GENERIC_AUTH_ERROR });
    }

    await resetBucket(`login:email:${email}`).catch(() => {});

    const pair = signTokenPair(user);
    setAuthCookies(res, pair);

    let plan = 'free';
    try {
      const planResult = await getPlanForUserDetailed(user.id);
      if (!planResult.degraded) plan = planResult.plan;
    } catch (err) {
      console.warn('[auth/login] plano:', err.code || err.message);
    }

    await audit('login', { email, userId: user.id, ip, userAgent, success: true, reason: null });
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);

    return sendJson(res, 200, {
      ok: true,
      user: {
        id: String(user.id),
        email: sanitizeEmail(user.email),
        name: sanitizeName(user.name),
        plan
      }
    });
  } catch (error) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: error.code || 'error' });
    console.error('[auth/login]', error.code || error.message);

    const status = DB_DOWN_CODES.has(error.code) ? 503 : 502;
    return sendJson(res, status, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// ACTION: signup
// ─────────────────────────────────────────────────────────────
async function handleSignup(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const body = parseBody(req);

  try {
    assertJwtConfiguration();
  } catch {
    return sendJson(res, 503, { ok: false, error: GENERIC_ERROR });
  }

  const name = normalizeName(body.name);
  const email = readEmail(body.email);
  const password = readPassword(body.password);

  if (!isValidName(name) || !EMAIL_REGEX.test(email) || password === null || !isValidPassword(password)) {
    await audit('signup', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_SIGNUP_ERROR });
  }

  const [ipRate, emailRate] = await Promise.all([
    checkAndIncrement(`signup:ip:${ip}`, MAX_SIGNUPS_PER_IP, 60 * 60 * 1000, { failClosed: true }),
    checkAndIncrement(`signup:email:${email}`, MAX_EMAILS_PER_HOUR, 60 * 60 * 1000, { failClosed: true })
  ]);

  if (ipRate.limited || emailRate.limited) {
    const retryAfter = Math.max(ipRate.retryAfter, emailRate.retryAfter, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await audit('signup', { email, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE_ERROR });
  }

  try {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

    if (existing) {
      await audit('signup', { email, ip, userAgent, success: false, reason: 'email_exists' });
      return sendJson(res, 409, { ok: false, error: 'Este e-mail já está cadastrado.' });
    }

    const passwordHash = await hashPassword(password);

    const [user] = await neonSql`
      INSERT INTO users (
        email, password_hash, name, role, created_at, updated_at
      )
      VALUES (
        ${email}, ${passwordHash}, ${name}, 'CUSTOMER', NOW(), NOW()
      )
      RETURNING id, email, name, role, created_at, updated_at
    `;

    const pair = signTokenPair(user);
    setAuthCookies(res, pair);

    await audit('signup', { email, ip, userAgent, userId: user.id, success: true, reason: 'authenticated' });

    return sendJson(res, 201, {
      ok: true,
      requiresEmailConfirmation: false,
      user: {
        id: String(user.id),
        email: sanitizeEmail(user.email),
        name: sanitizeName(user.name),
        plan: 'free'
      }
    });
  } catch (error) {
    await audit('signup', { email, ip, userAgent, success: false, reason: error.code || 'error' });

    if (
      error.code === '23505' &&
      (error.constraint === 'users_email_key' ||
        String(error.message).includes('users_email_key'))
    ) {
      return sendJson(res, 409, { ok: false, error: 'Este e-mail já está cadastrado.' });
    }

    console.error('[auth/signup]', error.code || error.message);

    const status = DB_DOWN_CODES.has(error.code) ? 503 : 500;
    return sendJson(res, status, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// ACTION: logout
// ─────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  try {
    clearAuthCookies(res);
  } catch (err) {
    console.warn('[auth/logout] falha ao limpar cookies:', err.message);
  }

  // TODO: revogar refresh token persistido em auth_sessions
  // quando a tabela for criada.

  await audit('logout', { ip, userAgent, success: true, reason: null });
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// ACTION: refresh (nova)
// ─────────────────────────────────────────────────────────────
async function handleRefresh(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';

  const cookies = require('./_lib').parseCookies(
    req.headers.cookie || ''
  );
  const IS_PROD = process.env.NODE_ENV === 'production';
  const cookieName = IS_PROD ? '__Host-jm_auth_refresh' : 'jm_auth_refresh';
  const refreshToken = cookies[cookieName] || '';

  if (!refreshToken) {
    return sendJson(res, 401, { ok: false, error: GENERIC_AUTH_ERROR });
  }

  const payload = verifyRefreshToken(refreshToken);
  if (!payload) {
    await audit('refresh', { ip, userAgent, success: false, reason: 'invalid_refresh' });
    return sendJson(res, 401, { ok: false, error: GENERIC_AUTH_ERROR });
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.id, payload.id)).limit(1);

    if (!user) {
      await audit('refresh', { ip, userAgent, success: false, reason: 'user_not_found' });
      return sendJson(res, 401, { ok: false, error: GENERIC_AUTH_ERROR });
    }

    const pair = signTokenPair(user);
    setAuthCookies(res, pair);

    await audit('refresh', { email: user.email, userId: user.id, ip, userAgent, success: true, reason: null });

    return sendJson(res, 200, {
      ok: true,
      user: {
        id: String(user.id),
        email: sanitizeEmail(user.email),
        name: sanitizeName(user.name)
      }
    });
  } catch (error) {
    console.error('[auth/refresh]', error.code || error.message);
    const status = DB_DOWN_CODES.has(error.code) ? 503 : 502;
    return sendJson(res, status, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// ACTION: me
// ─────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const isHead = method === 'HEAD';

  let user = null;
  try {
    user = await getAuthUser(req);
  } catch (err) {
    console.error('[auth/me] sessão:', err.code || err.message);
    return isHead
      ? res.status(503).end()
      : sendJson(res, 503, { ok: false, error: GENERIC_ERROR });
  }

  if (!user) {
    return isHead
      ? res.status(401).end()
      : sendJson(res, 401, { ok: false });
  }

  try {
    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);

    if (!row) {
      return isHead
        ? res.status(401).end()
        : sendJson(res, 401, { ok: false });
    }

    const [planResult, rentalsResult] = await Promise.allSettled([
      getPlanForUserDetailed(row.id),
      getActiveRentals(row.id)
    ]);

    if (
      planResult.status !== 'fulfilled' ||
      planResult.value.degraded ||
      !VALID_PLANS.has(planResult.value.plan)
    ) {
      console.error('[auth/me] plano indisponível');
      return isHead
        ? res.status(503).end()
        : sendJson(res, 503, {
            ok: false,
            error: GENERIC_ERROR,
            code: 'PLAN_STATUS_UNAVAILABLE'
          });
    }

    if (
      rentalsResult.status !== 'fulfilled' ||
      !Array.isArray(rentalsResult.value)
    ) {
      console.error('[auth/me] rentals indisponíveis');
      return isHead
        ? res.status(503).end()
        : sendJson(res, 503, {
            ok: false,
            error: GENERIC_ERROR,
            code: 'RENTALS_UNAVAILABLE'
          });
    }

    const responseBody = {
      ok: true,
      user: {
        id: String(row.id),
        email: sanitizeEmail(row.email),
        name: sanitizeName(row.name),
        plan: planResult.value.plan
      },
      rentals: rentalsResult.value
    };

    if (isHead) {
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end();
    }

    return sendJson(res, 200, responseBody);
  } catch (error) {
    console.error('[auth/me]', error.code || error.message);
    const status = DB_DOWN_CODES.has(error.code) ? 503 : 502;
    return isHead
      ? res.status(status).end()
      : sendJson(res, status, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// Rentals ativos (track OU album)
// ─────────────────────────────────────────────────────────────
async function getActiveRentals(userId) {
  const nowIso = new Date().toISOString();

  const rows = await db.select({
    trackId: rentals.trackId,
    albumId: rentals.albumId,
    expiresAt: rentals.expiresAt,
    trackAlbumId: tracks.albumId,
    trackNumber: tracks.trackNumber,
  })
    .from(rentals)
    .leftJoin(tracks, eq(rentals.trackId, tracks.id))
    .where(and(
      eq(rentals.userId, userId),
      eq(rentals.status, 'ACTIVE'),
      lte(rentals.startsAt, nowIso),
      gt(rentals.expiresAt, nowIso)
    ))
    .limit(MAX_RENTALS);

  return rows
    .map((r) => {
      if (r.trackId && r.trackAlbumId && r.trackNumber != null) {
        return {
          trackKey: `${r.trackAlbumId}:${r.trackNumber}`,
          trackId: r.trackId,
          albumId: r.trackAlbumId,
          expiresAt: r.expiresAt
        };
      }
      if (r.albumId) {
        return {
          trackKey: `album:${r.albumId}`,
          albumId: r.albumId,
          expiresAt: r.expiresAt
        };
      }
      if (r.trackId) {
        return {
          trackId: r.trackId,
          expiresAt: r.expiresAt
        };
      }
      return null;
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// Validação / sanitização
// ─────────────────────────────────────────────────────────────
function parseAction(query) {
  if (!query) return null;
  if (typeof query.action !== 'string') return null;
  const raw = query.action.trim().toLowerCase();
  if (!raw) return null;
  if (!['login', 'signup', 'logout', 'refresh', 'me'].includes(raw)) return null;
  return raw;
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

/**
 * Rejeita e-mail > MAX_EMAIL_LENGTH (não trunca).
 */
function readEmail(value) {
  if (typeof value !== 'string') return '';

  const normalized = value.normalize('NFC').trim().toLowerCase();

  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_LENGTH ||
    Buffer.byteLength(normalized, 'utf8') > MAX_EMAIL_LENGTH
  ) {
    return '';
  }

  return normalized;
}

/**
 * Rejeita senha fora do intervalo (não trunca).
 * Retorna null se inválida.
 */
function readPassword(value) {
  if (typeof value !== 'string') return null;
  if (value.length < MIN_PASSWORD_LENGTH) return null;
  if (value.length > MAX_PASSWORD_LENGTH) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) return null;
  return value;
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
// Helpers
// ─────────────────────────────────────────────────────────────
function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
}

function equalizeTiming(startedAt, minMs) {
  const remaining = minMs - (Date.now() - startedAt);
  if (remaining > 0) return new Promise((r) => setTimeout(r, remaining));
  return Promise.resolve();
}