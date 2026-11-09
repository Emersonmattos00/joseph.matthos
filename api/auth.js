/* ============================================================
   api/auth.js — Autenticação própria (Neon + JWT)
   ------------------------------------------------------------
   POST /api/auth?action=login    → login
   POST /api/auth?action=signup   → cadastro
   POST /api/auth?action=logout   → encerra sessão
   GET  /api/auth?action=me       → dados do usuário + rentals

   - Cookies __Host- em produção (HttpOnly + SameSite=Lax)
   - CSRF: Origin check em métodos mutantes
   - Senhas com scrypt (nativo do Node)
   - Sessão via access token (1h) + refresh token (7d)
   - Rate limit por IP + e-mail (Redis/KV)
   - Auditoria em todas as ações
   ============================================================ */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { eq, and, gt } = require('drizzle-orm');

const {
  users,
  rentals,
  tracks,
  refreshTokens
} = require('../src/schema.js');

const {
  sendJson,
  setAuthCookies,
  clearAuthCookies,
  getAccessToken,
  getRefreshToken,
  getPlanForUserDetailed,
  VALID_PLANS,
  checkAndIncrement,
  resetBucket,
  audit,
  checkOrigin,
} = require('./_lib');

const { db, sql } = require('./_db');

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MAX_NAME_LENGTH = 120;
const MIN_NAME_LENGTH = 2;
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 256;
const MIN_PASSWORD_LENGTH = 8;
const MAX_REFRESH_TOKENS_PER_USER = 5;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NAME_REGEX = /^[\p{L}\p{N}\s.'-]+$/u;

const COMMON_PASSWORDS = new Set([
  '12345678', '123456789', '1234567890', 'password', 'password1',
  'qwerty123', 'qwertyuiop', 'senha123', 'admin123', 'letmein',
  'welcome1', 'iloveyou', 'abc12345', '1q2w3e4r', '1qaz2wsx'
]);

const MAX_EMAILS_PER_HOUR = 3;
const MAX_LOGIN_ATTEMPTS_PER_IP = 60;
const MAX_LOGIN_ATTEMPTS_PER_EMAIL = 8;
const MAX_SIGNUPS_PER_IP = 10;
const MIN_RESPONSE_MS = 350;

const MAX_RENTALS = 100;

const ACCESS_TTL = '1h';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  if (method !== 'GET' && method !== 'HEAD') {
    if (!checkOrigin(req)) {
      console.warn('[auth] Origin rejeitada:', {
        action, method,
        origin: req.headers.origin || null
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

    case 'me':
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
      return handleMe(req, res);

    default:
      return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
  }
};

// ─────────────────────────────────────────────────────────────
// Hash de senha (scrypt)
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');

    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) {
        return reject(err);
      }
      resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    try {
      if (typeof storedHash !== 'string') return resolve(false);

      const parts = storedHash.split('$');
      if (parts.length !== 3) return resolve(false);

      const [algo, salt, hash] = parts;

      if (
        algo !== 'scrypt' ||
        !/^[a-f0-9]{32}$/.test(salt) ||
        !/^[a-f0-9]{128}$/.test(hash)
      ) {
        return resolve(false);
      }

      const expected = Buffer.from(hash, 'hex');

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
// JWT — access + refresh
// ─────────────────────────────────────────────────────────────
function signAccessToken(user) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET ausente ou muito curto.');
  }

  return jwt.sign(
    {
      id: String(user.id),
      email: user.email,
      role: user.role
    },
    secret,
    {
      algorithm: 'HS256',
      expiresIn: ACCESS_TTL
    }
  );
}

function verifyAccessToken(token) {
  try {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret || secret.length < 32) return null;

    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256']
    });

    if (!payload || typeof payload.id !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

async function createRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('base64url');
  const tokenHash = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();

  await db.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId,
    tokenHash,
    expiresAt,
    createdAt: new Date().toISOString()
  });

  // Limita a quantidade de refresh tokens por usuário.
  const rows = await db.select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(eq(refreshTokens.userId, userId))
    .orderBy(refreshTokens.createdAt);

  if (rows.length > MAX_REFRESH_TOKENS_PER_USER) {
    const removeCount = rows.length - MAX_REFRESH_TOKENS_PER_USER;
    for (let i = 0; i < removeCount; i++) {
      await db.delete(refreshTokens).where(eq(refreshTokens.id, rows[i].id));
    }
  }

  return token;
}

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
    typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_REGEX.test(email)) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_AUTH_ERROR });
  }

  if (
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_password_length' });
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
    const [user] = await db.select().from(users)
      .where(eq(users.email, email))
      .limit(1);

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

    const accessToken = signAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);

    setAuthCookies(res, {
      access_token: accessToken,
      refresh_token: refreshToken
    });

    let plan = 'free';
    try {
      const planResult = await getPlanForUserDetailed(user.id);
      plan = planResult.plan;
    } catch (err) {
      console.warn('[auth/login] falha ao obter plano:', err.code || err.message);
    }

    await audit('login', {
      email, userId: user.id, ip, userAgent, success: true, reason: null
    });

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
    typeof body.password === 'string' ? body.password : '';

  if (
    !isValidName(name) ||
    !EMAIL_REGEX.test(email) ||
    !isValidPassword(password)
  ) {
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
    const [existing] = await db.select({ id: users.id })
      .from(users).where(eq(users.email, email)).limit(1);

    if (existing) {
      await audit('signup', { email, ip, userAgent, success: false, reason: 'email_exists' });
      // Mensagem genérica para não revelar cadastro
      return sendJson(res, 400, { ok: false, error: GENERIC_SIGNUP_ERROR });
    }

    const passwordHash = await hashPassword(password);

    const [user] = await sql`
      INSERT INTO users (email, password_hash, name, role, created_at, updated_at)
      VALUES (${email}, ${passwordHash}, ${name}, 'CUSTOMER', NOW(), NOW())
      RETURNING id, email, name, role, created_at, updated_at
    `;

    const accessToken = signAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);

    setAuthCookies(res, {
      access_token: accessToken,
      refresh_token: refreshToken
    });

    await audit('signup', {
      email, ip, userAgent, userId: user.id, success: true, reason: 'authenticated'
    });

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

  // Revoga o refresh token no banco, se existir
  try {
    const refreshToken = getRefreshToken(req);
    if (refreshToken) {
      const tokenHash = crypto
        .createHash('sha256')
        .update(refreshToken)
        .digest('hex');

      await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash));
    }
  } catch (err) {
    console.warn('[auth/logout] falha ao revogar refresh token:', err.message);
  }

  try {
    clearAuthCookies(res);
  } catch (err) {
    console.warn('[auth/logout] falha ao limpar cookies:', err.message);
  }

  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');

  await audit('logout', { ip, userAgent, success: true, reason: null });

  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// ACTION: me
// ─────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const token = getAccessToken(req);

  if (!token) {
    if (method === 'HEAD') {
      res.status(401);
      return res.end();
    }
    return sendJson(res, 401, { ok: false });
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    if (method === 'HEAD') {
      res.status(401);
      return res.end();
    }
    return sendJson(res, 401, { ok: false });
  }

  try {
    const [user] = await db.select().from(users)
      .where(eq(users.id, payload.id))
      .limit(1);

    if (!user) {
      if (method === 'HEAD') {
        res.status(401);
        return res.end();
      }
      return sendJson(res, 401, { ok: false });
    }

    const [planResult, rentalsResult] = await Promise.allSettled([
      getPlanForUserDetailed(user.id),
      getActiveRentals(user.id)
    ]);

    const plan =
      planResult.status === 'fulfilled' && VALID_PLANS.has(planResult.value.plan)
        ? planResult.value.plan
        : 'free';

    const userRentals =
      rentalsResult.status === 'fulfilled' && Array.isArray(rentalsResult.value)
        ? rentalsResult.value
        : [];

    const responseBody = {
      ok: true,
      user: {
        id: String(user.id),
        email: sanitizeEmail(user.email),
        name: sanitizeName(user.name),
        plan
      },
      rentals: userRentals
    };

    if (method === 'HEAD') {
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.end();
    }

    return sendJson(res, 200, responseBody);
  } catch (error) {
    console.error('[auth/me]', error.code || error.message);
    if (method === 'HEAD') {
      res.status(502);
      return res.end();
    }
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// Rentals — trata faixa e álbum
// ─────────────────────────────────────────────────────────────
async function getActiveRentals(userId) {
  const nowIso = new Date().toISOString();

  // Aluguel de faixa
  const trackRows = await db.select({
    trackId: rentals.trackId,
    expiresAt: rentals.expiresAt,
    albumId: tracks.albumId,
    trackNumber: tracks.trackNumber
  })
  .from(rentals)
  .innerJoin(tracks, eq(rentals.trackId, tracks.id))
  .where(and(
    eq(rentals.userId, userId),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, nowIso)
  ))
  .limit(MAX_RENTALS);

  // Aluguel de álbum
  const albumRows = await db.select({
    albumId: rentals.albumId,
    expiresAt: rentals.expiresAt
  })
  .from(rentals)
  .where(and(
    eq(rentals.userId, userId),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, nowIso)
  ))
  .limit(MAX_RENTALS);

  const trackKeys = trackRows
    .filter(r => r.albumId != null && r.trackNumber != null)
    .map(r => ({
      trackKey: `${r.albumId}:${r.trackNumber}`,
      expiresAt: r.expiresAt
    }));

  const albumKeys = albumRows
    .filter(r => r.albumId != null)
    .map(r => ({
      albumId: r.albumId,
      expiresAt: r.expiresAt
    }));

  return [...trackKeys, ...albumKeys];
}

// ─────────────────────────────────────────────────────────────
// Validação / sanitização
// ─────────────────────────────────────────────────────────────
function parseAction(query) {
  if (!query) return null;
  const raw = String(query.action || '').trim().toLowerCase();
  if (!raw) return null;
  if (!['login', 'signup', 'logout', 'me'].includes(raw)) return null;
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
  return value.normalize('NFC').trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
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
  if (typeof password !== 'string') return false;
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
  const trusted = h['x-vercel-forwarded-for'] || h['x-real-ip'];
  if (trusted) return String(trusted).split(',')[0].trim().slice(0, 128);

  if (process.env.NODE_ENV !== 'production') {
    const fwd = h['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim().slice(0, 128);
  }

  return String((req.socket && req.socket.remoteAddress) || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 128);
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
}

function equalizeTiming(startedAt, minMs) {
  const remaining = minMs - (Date.now() - startedAt);
  if (remaining > 0) return new Promise((r) => setTimeout(r, remaining));
  return Promise.resolve();
}