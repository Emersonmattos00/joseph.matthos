'use strict';

/* ============================================================
   api/auth.js — Autenticação (Neon + JWT + Refresh)
   ------------------------------------------------------------
   - Rotação de refresh atômica (transação com isNull(revokedAt))
   - Limite de 5 sessões atômico (transação)
   - Logout retorna 503 se revogação falhar
   - Signup transacional (user + refresh)
   - inArray em vez de ANY()
   - Revogação não sobrescreve revokedAt
   ============================================================ */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { eq, and, gt, lte, isNull, inArray, sql } = require('drizzle-orm');

const { users, rentals, tracks, refreshTokens } = require('../src/schema.js');

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
  clientIp,
  IS_PROD
} = require('./_lib');

const { db } = require('./_db');

// ─────────────────────────────────────────────────────────────
// CONSTANTES
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

const MAX_LOGIN_PER_IP = 30;
const MAX_LOGIN_PER_EMAIL = 8;
const MAX_SIGNUP_PER_IP = 10;
const MAX_SIGNUP_PER_EMAIL = 3;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

const MIN_RESPONSE_MS = 350;
const MAX_RENTALS = 100;

const ACCESS_TTL = '1h';
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const GENERIC_AUTH_ERROR = 'E-mail ou senha incorretos.';
const GENERIC_SIGNUP_ERROR = 'Não foi possível concluir o cadastro.';
const GENERIC_RATE_ERROR = 'Muitas tentativas. Tente novamente mais tarde.';
const GENERIC_ERROR = 'Serviço indisponível.';

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Vary', 'Cookie');
  res.setHeader('Allow', 'GET, HEAD, POST');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');

  const action = parseAction(req.query);
  if (!action) return sendJson(res, 400, { ok: false, error: 'Ação inválida.' });

  const method = (req.method || 'GET').toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') {
    if (!checkOrigin(req)) {
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
    case 'logout-all':
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      return handleLogoutAll(req, res);
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
// HASH DE SENHA
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derived) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt}$${derived.toString('hex')}`);
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

      if (algo !== 'scrypt') return resolve(false);
      if (!/^[a-f0-9]{32}$/.test(salt)) return resolve(false);
      if (!/^[a-f0-9]{128}$/.test(hash)) return resolve(false);

      const expected = Buffer.from(hash, 'hex');
      crypto.scrypt(password, salt, expected.length, (err, derived) => {
        if (err || !derived) return resolve(false);
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
// JWT
// ─────────────────────────────────────────────────────────────
function signAccessToken(user) {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET ausente ou muito curto.');
  }
  return jwt.sign(
    { id: String(user.id), email: user.email, role: user.role },
    secret,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL }
  );
}

function verifyAccessToken(token) {
  try {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (Buffer.byteLength(secret, 'utf8') < 32) return null;
    const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!payload || typeof payload.id !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// REFRESH TOKENS (com transação)
// ─────────────────────────────────────────────────────────────

/**
 * Gera e persiste um novo refresh token dentro de uma transação.
 * Já aplica o limite de 5 sessões ativas.
 */
async function createRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();
  const nowIso = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.insert(refreshTokens).values({
      id: crypto.randomUUID(),
      userId,
      tokenHash: hash,
      expiresAt,
      revokedAt: null,
      createdAt: nowIso
    });

    // Busca tokens ativos ordenados por criação (mais antigos primeiro)
    const rows = await tx.select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt)
      ))
      .orderBy(refreshTokens.createdAt);

    if (rows.length > MAX_REFRESH_TOKENS_PER_USER) {
      const excess = rows.length - MAX_REFRESH_TOKENS_PER_USER;
      const idsToRevoke = rows.slice(0, excess).map(r => r.id);

      await tx.update(refreshTokens)
        .set({ revokedAt: nowIso })
        .where(inArray(refreshTokens.id, idsToRevoke));
    }
  });

  return raw;
}

/**
 * Busca um refresh token ativo (não revogado).
 */
async function findRefreshToken(raw) {
  if (!raw) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const [row] = await db.select().from(refreshTokens)
    .where(and(
      eq(refreshTokens.tokenHash, hash),
      isNull(refreshTokens.revokedAt)
    ))
    .limit(1);
  return row || null;
}

/**
 * Revoga um refresh token (soft delete).
 * Retorna true se revogou, false se já estava revogado ou não existia.
 */
async function revokeRefreshToken(raw) {
  if (!raw) return false;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  const updated = await db.update(refreshTokens)
    .set({ revokedAt: new Date().toISOString() })
    .where(and(
      eq(refreshTokens.tokenHash, hash),
      isNull(refreshTokens.revokedAt)
    ))
    .returning({ id: refreshTokens.id });

  return updated.length > 0;
}

// ─────────────────────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────────────────────
async function handleLogin(req, res) {
  const startedAt = Date.now();
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const body = parseBody(req);

  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!EMAIL_REGEX.test(email) || password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    await audit('login', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_AUTH_ERROR });
  }

  // Rate limit dentro do try para capturar falhas do Redis
  let ipRate, emailRate;
  try {
    [ipRate, emailRate] = await Promise.all([
      checkAndIncrement(`login:ip:${ip}`, MAX_LOGIN_PER_IP, RATE_WINDOW_MS, { failClosed: true }),
      checkAndIncrement(`login:email:${email}`, MAX_LOGIN_PER_EMAIL, RATE_WINDOW_MS, { failClosed: true })
    ]);
  } catch (rateErr) {
    console.error('[auth/login] rate limit indisponível:', rateErr.message);
    await equalizeTiming(startedAt, MIN_RESPONSE_MS);
    return sendJson(res, 503, { ok: false, error: GENERIC_ERROR });
  }

  if (ipRate.limited || emailRate.limited) {
    const retryAfter = Math.max(ipRate.retryAfter || 1, emailRate.retryAfter || 1, 1);
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

    const accessToken = signAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);

    setAuthCookies(res, { access_token: accessToken, refresh_token: refreshToken });

    let plan = 'free';
    try {
      const planResult = await getPlanForUserDetailed(user.id);
      if (planResult && VALID_PLANS.has(planResult.plan)) plan = planResult.plan;
    } catch {}

    await audit('login', { email, userId: user.id, ip, userAgent, success: true });
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
// SIGNUP (transacional)
// ─────────────────────────────────────────────────────────────
async function handleSignup(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const body = parseBody(req);

  const name = normalizeName(body.name);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  if (!isValidName(name) || !EMAIL_REGEX.test(email) || !isValidPassword(password)) {
    await audit('signup', { email, ip, userAgent, success: false, reason: 'invalid_input' });
    return sendJson(res, 400, { ok: false, error: GENERIC_SIGNUP_ERROR });
  }

  let ipRate, emailRate;
  try {
    [ipRate, emailRate] = await Promise.all([
      checkAndIncrement(`signup:ip:${ip}`, MAX_SIGNUP_PER_IP, SIGNUP_WINDOW_MS, { failClosed: true }),
      checkAndIncrement(`signup:email:${email}`, MAX_SIGNUP_PER_EMAIL, SIGNUP_WINDOW_MS, { failClosed: true })
    ]);
  } catch (rateErr) {
    console.error('[auth/signup] rate limit indisponível:', rateErr.message);
    return sendJson(res, 503, { ok: false, error: GENERIC_ERROR });
  }

  if (ipRate.limited || emailRate.limited) {
    const retryAfter = Math.max(ipRate.retryAfter || 1, emailRate.retryAfter || 1, 1);
    res.setHeader('Retry-After', String(retryAfter));
    await audit('signup', { email, ip, userAgent, success: false, reason: 'rate_limited' });
    return sendJson(res, 429, { ok: false, error: GENERIC_RATE_ERROR });
  }

  try {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);

    if (existing) {
      await audit('signup', { email, ip, userAgent, success: false, reason: 'email_exists' });
      return sendJson(res, 400, { ok: false, error: GENERIC_SIGNUP_ERROR });
    }

    const passwordHash = await hashPassword(password);

    // ★ Transação: user + refresh token juntos
    let user;
    let refreshToken;
    try {
      await db.transaction(async (tx) => {
        const [inserted] = await tx.execute(sql`
          INSERT INTO users (email, password_hash, name, role, created_at, updated_at)
          VALUES (${email}, ${passwordHash}, ${name}, 'CUSTOMER', NOW(), NOW())
          RETURNING id, email, name, role, created_at, updated_at
        `);

        // Adaptador Neon pode retornar { rows: [...] } ou array
        user = inserted?.rows?.[0] || inserted?.[0] || inserted;
        if (!user) throw new Error('INSERT_RETURNED_NOTHING');

        // Cria refresh token na mesma transação
        const raw = crypto.randomBytes(48).toString('base64url');
        const hash = crypto.createHash('sha256').update(raw).digest('hex');
        const expiresAt = new Date(Date.now() + REFRESH_TTL_MS).toISOString();

        await tx.insert(refreshTokens).values({
          id: crypto.randomUUID(),
          userId: user.id,
          tokenHash: hash,
          expiresAt,
          revokedAt: null,
          createdAt: new Date().toISOString()
        });

        refreshToken = raw;
      });
    } catch (txErr) {
      await audit('signup', { email, ip, userAgent, success: false, reason: txErr.code || 'error' });
      console.error('[auth/signup] falha na transação:', txErr.code || txErr.message);
      return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
    }

    const accessToken = signAccessToken(user);
    setAuthCookies(res, { access_token: accessToken, refresh_token: refreshToken });

    await audit('signup', { email, ip, userAgent, userId: user.id, success: true });

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
    console.error('[auth/signup]', error.code || error.message);
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// LOGOUT (retorna 503 se revogação falhar)
// ─────────────────────────────────────────────────────────────
async function handleLogout(req, res) {
  const ip = clientIp(req);
  const userAgent = req.headers['user-agent'] || '';
  const raw = getRefreshToken(req);

  if (raw) {
    try {
      await revokeRefreshToken(raw);
    } catch (err) {
      console.error('[auth/logout] falha ao revogar refresh:', err.message);
      // ★ Não limpa cookies: o token no navegador ainda é válido
      return sendJson(res, 503, { ok: false, error: 'Serviço indisponível. Tente novamente.' });
    }
  }

  clearAuthCookies(res);
  res.setHeader('Clear-Site-Data', '"cookies"');
  await audit('logout', { ip, userAgent, success: true });
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// LOGOUT-ALL
// ─────────────────────────────────────────────────────────────
async function handleLogoutAll(req, res) {
  const token = getAccessToken(req);
  const payload = verifyAccessToken(token);
  if (!payload) return sendJson(res, 401, { ok: false });

  try {
    await db.update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(
        eq(refreshTokens.userId, payload.id),
        isNull(refreshTokens.revokedAt)
      ));
  } catch (err) {
    console.error('[auth/logout-all]', err.message);
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
  }

  clearAuthCookies(res);
  res.setHeader('Clear-Site-Data', '"cookies"');
  await audit('logout_all', { userId: payload.id, ip: clientIp(req), success: true });
  return sendJson(res, 200, { ok: true });
}

// ─────────────────────────────────────────────────────────────
// REFRESH (rotação atômica)
// ─────────────────────────────────────────────────────────────
async function handleRefresh(req, res) {
  const ip = clientIp(req);
  const raw = getRefreshToken(req);

  if (!raw) return sendJson(res, 401, { ok: false, error: 'Sessão ausente.' });

  const hash = crypto.createHash('sha256').update(raw).digest('hex');

  let newRefresh = null;
  let user = null;

  try {
    await db.transaction(async (tx) => {
      // ★ Revoga o antigo atomicamente (só se ainda não revogado)
      const updated = await tx.update(refreshTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(and(
          eq(refreshTokens.tokenHash, hash),
          isNull(refreshTokens.revokedAt)
        ))
        .returning({ userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt });

      if (!updated.length) {
        throw new Error('REFRESH_NOT_FOUND');
      }

      const row = updated[0];

      if (new Date(row.expiresAt).getTime() < Date.now()) {
        throw new Error('REFRESH_EXPIRED');
      }

      const [u] = await tx.select().from(users).where(eq(users.id, row.userId)).limit(1);
      if (!u) throw new Error('USER_NOT_FOUND');
      user = u;

      // Cria novo refresh na mesma transação
      const newRaw = crypto.randomBytes(48).toString('base64url');
      const newHash = crypto.createHash('sha256').update(newRaw).digest('hex');
      const newExpires = new Date(Date.now() + REFRESH_TTL_MS).toISOString();

      await tx.insert(refreshTokens).values({
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: newHash,
        expiresAt: newExpires,
        revokedAt: null,
        createdAt: new Date().toISOString()
      });

      newRefresh = newRaw;
    });
  } catch (err) {
    if (err.message === 'REFRESH_NOT_FOUND' || err.message === 'REFRESH_EXPIRED' || err.message === 'USER_NOT_FOUND') {
      return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
    }
    console.error('[auth/refresh]', err.code || err.message);
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }

  const accessToken = signAccessToken(user);
  setAuthCookies(res, { access_token: accessToken, refresh_token: newRefresh });

  let plan = 'free';
  try {
    const result = await getPlanForUserDetailed(user.id);
    if (result && VALID_PLANS.has(result.plan)) plan = result.plan;
  } catch {}

  await audit('refresh', { userId: user.id, ip, success: true });

  return sendJson(res, 200, {
    ok: true,
    user: {
      id: String(user.id),
      email: sanitizeEmail(user.email),
      name: sanitizeName(user.name),
      plan
    }
  });
}

// ─────────────────────────────────────────────────────────────
// ME
// ─────────────────────────────────────────────────────────────
async function handleMe(req, res) {
  const method = (req.method || 'GET').toUpperCase();
  const token = getAccessToken(req);

  if (!token) {
    if (method === 'HEAD') { res.status(401); return res.end(); }
    return sendJson(res, 401, { ok: false });
  }

  const payload = verifyAccessToken(token);
  if (!payload) {
    if (method === 'HEAD') { res.status(401); return res.end(); }
    return sendJson(res, 401, { ok: false });
  }

  try {
    const [user] = await db.select().from(users).where(eq(users.id, payload.id)).limit(1);
    if (!user) {
      if (method === 'HEAD') { res.status(401); return res.end(); }
      return sendJson(res, 401, { ok: false });
    }

    let plan = 'free';
    let userRentals = [];

    try {
      const planResult = await getPlanForUserDetailed(user.id);
      if (planResult && VALID_PLANS.has(planResult.plan)) plan = planResult.plan;
    } catch (planErr) {
      console.error('[auth/me] plano falhou:', planErr.message);
      return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
    }

    try {
      userRentals = await getActiveRentals(user.id);
    } catch (rentalErr) {
      console.error('[auth/me] aluguéis falharam:', rentalErr.message);
      return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
    }

    const body = {
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

    return sendJson(res, 200, body);
  } catch (error) {
    console.error('[auth/me]', error.code || error.message);
    if (method === 'HEAD') { res.status(502); return res.end(); }
    return sendJson(res, 502, { ok: false, error: GENERIC_ERROR });
  }
}

// ─────────────────────────────────────────────────────────────
// ALUGUÉIS ATIVOS
// ─────────────────────────────────────────────────────────────
async function getActiveRentals(userId) {
  const nowIso = new Date().toISOString();

  const rows = await db.select({
    trackId: rentals.trackId,
    albumId: rentals.albumId,
    expiresAt: rentals.expiresAt
  })
    .from(rentals)
    .where(and(
      eq(rentals.userId, userId),
      eq(rentals.status, 'ACTIVE'),
      lte(rentals.startsAt, nowIso),
      gt(rentals.expiresAt, nowIso)
    ))
    .orderBy(rentals.expiresAt)  // ★ ordena por vencimento
    .limit(MAX_RENTALS);

  const trackIds = rows.map(r => r.trackId).filter(Boolean);
  const trackMeta = new Map();
  if (trackIds.length) {
    const list = await db.select({
      id: tracks.id,
      albumId: tracks.albumId,
      trackNumber: tracks.trackNumber
    }).from(tracks).where(inArray(tracks.id, trackIds));  // ★ inArray

    for (const t of list) trackMeta.set(t.id, t);
  }

  const out = [];
  for (const r of rows) {
    if (r.trackId) {
      const meta = trackMeta.get(r.trackId);
      if (meta && meta.albumId != null && meta.trackNumber != null) {
        out.push({
          kind: 'track',
          trackKey: `${meta.albumId}:${meta.trackNumber}`,
          expiresAt: r.expiresAt
        });
      }
    } else if (r.albumId) {
      out.push({
        kind: 'album',
        albumId: r.albumId,
        expiresAt: r.expiresAt
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// VALIDAÇÃO / SANITIZAÇÃO
// ─────────────────────────────────────────────────────────────
function parseAction(query) {
  if (!query) return null;
  const raw = String(query.action || '').trim().toLowerCase();
  if (!['login', 'signup', 'logout', 'logout-all', 'refresh', 'me'].includes(raw)) return null;
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
  const normalized = value.normalize('NFC').trim().toLowerCase();
  if (normalized.length > MAX_EMAIL_LENGTH) return '';
  return normalized;
}

function sanitizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
}

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  if (normalized.length > MAX_NAME_LENGTH) return '';
  return normalized;
}

function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, '').replace(/<[^>]*>/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

function isValidName(name) {
  return name.length >= MIN_NAME_LENGTH && name.length <= MAX_NAME_LENGTH && NAME_REGEX.test(name);
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
// HELPERS
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