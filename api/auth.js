/* ============================================================
   api/auth.js — Autenticação própria (Neon + JWT)
   ------------------------------------------------------------
   Correções aplicadas:
   - Rate limits mais restritivos
   - Tratamento de e-mail duplicado (409)
   - Suporte a aluguel de álbum
   - Remoção do Clear-Site-Data no logout
   ============================================================ */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { eq, and, gt } = require('drizzle-orm');

const { users, rentals, tracks } = require('../src/schema.js');

const {
  sendJson,
  setAuthCookies,
  clearAuthCookies,
  getPlanForUserDetailed,
  VALID_PLANS,
  checkAndIncrement,
  resetBucket,
  audit,
  checkOrigin,
} = require('./_lib');

const { db, sql } = require('./_db');

// ─────────────────────────────────────────────────────────────
// Constantes (Rate Limits Ajustados)
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

// ★ CORREÇÃO: Limites mais restritivos para segurança
const MAX_EMAILS_PER_HOUR = 3;
const MAX_LOGIN_ATTEMPTS_PER_IP = 60;
const MAX_LOGIN_ATTEMPTS_PER_EMAIL = 10;
const MAX_SIGNUPS_PER_IP = 10;
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

  if (method !== 'GET' && method !== 'HEAD') {
    if (!checkOrigin(req)) {
      console.warn('[auth] Origin rejeitada:', { action, method, origin: req.headers.origin || req.headers.referer || null });
      return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
    }
  }

  switch (action) {
    case 'login': if (method !== 'POST') return methodNotAllowed(res, 'POST'); return handleLogin(req, res);
    case 'signup': if (method !== 'POST') return methodNotAllowed(res, 'POST'); return handleSignup(req, res);
    case 'logout': if (method !== 'POST') return methodNotAllowed(res, 'POST'); return handleLogout(req, res);
    case 'me': if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD'); return handleMe(req, res);
    default: return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });
  }
};

// ─────────────────────────────────────────────────────────────
// Hash de senha (scrypt)
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    try {
      const [algo, salt, hash] = String(storedHash).split('$');
      if (algo !== 'scrypt') return resolve(false);
      const expected = Buffer.from(hash, 'hex');
      crypto.scrypt(password, salt, expected.length, (err, derived) => {
        if (err) return resolve(false);
        resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
      });
    } catch { resolve(false); }
  });
}

// ─────────────────────────────────────────────────────────────
// JWT — par de tokens
// ─────────────────────────────────────────────────────────────
function signTokenPair(user) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret) throw new Error('JWT_SECRET não configurado.');
  const basePayload = { id: user.id, email: user.email, role: user.role };
  return {
    access_token: jwt.sign(basePayload, secret, { expiresIn: '1h' }),
    refresh_token: jwt.sign(basePayload, secret, { expiresIn: '7d' }),
  };
}

function verifyToken(token) {
  try {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) return null;
    return jwt.verify(token, secret);
  } catch { return null; }
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
  const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD_LENGTH) : '';

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
      plan = planResult.plan;
    } catch (err) {
      console.warn('[auth/login] falha ao obter plano:', err.code || err.message);
    }

    await audit('login', { email, userId: user.id, ip, userAgent, success: true, reason: null });
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);

    return sendJson(res, 200, {
      ok: true,
      user: { id: String(user.id), email: sanitizeEmail(user.email), name: sanitizeName(user.name), plan }
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
  const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD_LENGTH) : '';

  if (!isValidName(name) || !EMAIL_REGEX.test(email) || !isValidPassword(password)) {
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
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

    if (existing) {
      await audit('signup', { email, ip, userAgent, success: false, reason: 'email_exists' });
      return sendJson(res, 409, { ok: false, error: 'Este e-mail já está cadastrado.' }); // ★ Mudei para 409
    }

    const passwordHash = await hashPassword(password);

    const [user] = await sql`
    INSERT INTO users (email, password_hash, name, role, created_at, updated_at)
    VALUES (${email}, ${passwordHash}, ${name}, 'CUSTOMER', NOW(), NOW())
    RETURNING id, email, name, role, created_at, updated_at
  `;

    const pair = signTokenPair(user);
    setAuthCookies(res, pair);

    await audit('signup', { email, ip, userAgent, userId: user.id, success: true, reason: 'authenticated' });

    return sendJson(res, 201, {
      ok: true,
      requiresEmailConfirmation: false,
      user: { id: String(user.id), email: sanitizeEmail(user.email), name: sanitizeName(user.name), plan: 'free' }
    });
  } catch (error) {
    await audit('signup', { email, ip, userAgent, success: false, reason: error.code || 'error' });

    // ★ CORREÇÃO: Tratar erro de e-mail duplicado (condição de corrida)
    if (error.code === '23505' && (error.constraint === 'users_email_key' || String(error.message).includes('users_email_key'))) {
      return sendJson(res, 409, { ok: false, error: 'Este e-mail já está cadastrado.' });
    }

    console.error('[auth/signup]', error.code || error.message);
    return sendJson(res, 500, { ok: false, error: GENERIC_ERROR }); // ★ Mudei 502 para 500
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

  // ★ CORREÇÃO: Removido Clear-Site-Data (pode apagar dados locais desnecessariamente)
  await audit('logout', { ip, userAgent, success: true, reason: null });

  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// ACTION: me
// ─────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const token = getAccessTokenFromCookie(req);

  if (!token) return method === 'HEAD' ? res.status(401).end() : sendJson(res, 401, { ok: false });

  const payload = verifyToken(token);
  if (!payload) return method === 'HEAD' ? res.status(401).end() : sendJson(res, 401, { ok: false });

  try {
    const [user] = await db.select().from(users).where(eq(users.id, payload.id)).limit(1);
    if (!user) return method === 'HEAD' ? res.status(401).end() : sendJson(res, 401, { ok: false });

    const [planResult, rentalsResult] = await Promise.allSettled([
      getPlanForUserDetailed(user.id),
      getActiveRentals(user.id)
    ]);

    const plan = planResult.status === 'fulfilled' && VALID_PLANS.has(planResult.value.plan) ? planResult.value.plan : 'free';
    const userRentals = rentalsResult.status === 'fulfilled' && Array.isArray(rentalsResult.value) ? rentalsResult.value : [];

    const responseBody = {
      ok: true,
      user: { id: String(user.id), email: sanitizeEmail(user.email), name: sanitizeName(user.name), plan },
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
    return method === 'HEAD' ? res.status(502).end() : sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers de cookie
// ─────────────────────────────────────────────────────────────
function getAccessTokenFromCookie(req) {
  const header = req.headers.cookie || req.headers.Cookie || '';
  const cookies = {};
  String(header).split(';').forEach((item) => {
    const i = item.indexOf('=');
    if (i < 0) return;
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (k) { try { cookies[k] = decodeURIComponent(v); } catch { cookies[k] = v; } }
  });

  const IS_PROD = process.env.NODE_ENV === 'production';
  const name = IS_PROD ? '__Host-jm_auth_access' : 'jm_auth_access';
  return cookies[name] || '';
}

// ─────────────────────────────────────────────────────────────
// Rentals (Suporte a faixa e álbum)
// ─────────────────────────────────────────────────────────────
async function getActiveRentals(userId) {
  const nowIso = new Date().toISOString();

  const rows = await db.select({
    trackId: rentals.trackId,
    albumId: rentals.albumId, // ★ Pega o albumId do próprio rental
    expiresAt: rentals.expiresAt,
    trackAlbumId: tracks.albumId,
    trackNumber: tracks.trackNumber,
  })
  .from(rentals)
  .leftJoin(tracks, eq(rentals.trackId, tracks.id))
  .where(and(
    eq(rentals.userId, userId),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, nowIso)
  ))
  .limit(MAX_RENTALS);

  // ★ CORREÇÃO: Suporta aluguel de faixa (trackKey) e aluguel de álbum (albumId)
  return rows.map((r) => {
    if (r.trackId && r.trackAlbumId && r.trackNumber != null) {
      return { trackKey: `${r.trackAlbumId}:${r.trackNumber}`, expiresAt: r.expiresAt };
    }
    if (r.albumId) {
      return { albumId: r.albumId, expiresAt: r.expiresAt };
    }
    return null;
  }).filter(Boolean);
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
  if (typeof body === 'string') { try { body = JSON.parse(body || '{}'); } catch { body = {}; } }
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
  return value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/<[^>]*>/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

function isValidName(name) {
  return name.length >= MIN_NAME_LENGTH && name.length <= MAX_NAME_LENGTH && NAME_REGEX.test(name);
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
  const trusted = h['x-vercel-forwarded-for'] || h['x-real-ip'];
  if (trusted) return String(trusted).split(',')[0].trim();
  if (process.env.NODE_ENV !== 'production') {
    const fwd = h['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return String((req.socket && req.socket.remoteAddress) || 'unknown').split(',')[0].trim();
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