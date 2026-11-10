'use strict';

/* ============================================================
   API: /api/auth — Autenticação (v15 — FINAL DEFINITIVO)
   ------------------------------------------------------------
   Correção sobre v14:
   - P1: isLegacy reavaliado dentro da transação após lock
   ------------------------------------------------------------
   FIM DA ITERAÇÃO ISOLADA. Próximos passos exigem:
   - api/_lib.js: validar sid ativo, propagar erro de DB, HMAC
   - src/schema.js: confirmar colunas
   - endpoint de reset de senha: usar mesmo lock
   ============================================================ */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { eq, and, isNull, gt, inArray, sql, asc, ne } = require('drizzle-orm');
const { db } = require('./_db');
const { users, refreshTokens } = require('../src/schema.js');
const {
  getAuthUser,
  checkOrigin,
  validatedOrigin,
  clientIp,
  checkAndIncrement,
  hashRateLimitKey,
  getPlanForUserDetailed,
  VALID_PLANS,
  setAuthCookies,
  clearAuthCookies,
  getRefreshToken,
  JWT_ISSUER,
  JWT_AUDIENCE,
  REFRESH_MAX_AGE,
  audit,
} = require('./_lib');

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const ACCESS_TTL = '15m';

if (!Number.isInteger(REFRESH_MAX_AGE) || REFRESH_MAX_AGE <= 0) {
  throw new Error('[auth] REFRESH_MAX_AGE inválido em _lib.js.');
}
const REFRESH_TTL_MS = REFRESH_MAX_AGE * 1000;

const MAX_SESSIONS = 5;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_HASH_HEX_LEN = SCRYPT_KEYLEN * 2;
const SCRYPT_SALT_HEX_LEN = SCRYPT_SALT_BYTES * 2;
const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{60,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 254;
const MAX_PASSWORD_LEN = 200;
const MIN_PASSWORD_LEN = 8;
const MAX_USER_AGENT_LEN = 512;
const DEFAULT_ROLE = 'CUSTOMER';

const RL_SIGNUP = { max: 5, windowMs: 15 * 60 * 1000 };
const RL_LOGIN = { max: 10, windowMs: 15 * 60 * 1000 };
const RL_REFRESH = { max: 30, windowMs: 15 * 60 * 1000 };

if (!JWT_ISSUER || !JWT_AUDIENCE) {
  throw new Error('[auth] JWT_ISSUER/JWT_AUDIENCE ausentes em _lib.js.');
}
const ISSUER = JWT_ISSUER;
const AUDIENCE = JWT_AUDIENCE;

const DUMMY_PASSWORD_HASH = (() => {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = crypto.scryptSync(
    crypto.randomBytes(32).toString('hex'),
    salt,
    SCRYPT_KEYLEN
  );
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
})();

// ─────────────────────────────────────────────────────────────
// CLASSIFICAÇÃO DE ERROS
// ─────────────────────────────────────────────────────────────
const NETWORK_ERR_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET',
  'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN',
  '57P01', '57P02', '57P03',
  '53300',
]);

function isDbUnavailable(err) {
  let current = err;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = String(current.code || '');
    if (NETWORK_ERR_CODES.has(code)) return true;
    if (/^08[0-9A-Z]{3}$/i.test(code)) return true;
    if (current.name === 'NeonDbError' && /connect|network|timeout/i.test(current.message || '')) return true;
    current = current.cause;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret.length < 32) {
    const err = new Error('JWT_SECRET ausente ou curto demais.');
    err.code = 'JWT_SECRET_INVALID';
    throw err;
  }
  return secret;
}

function assertJwtConfig() { getJwtSecret(); }

function getSessionVersion(user) {
  const raw = user?.sessionVersion;
  if (raw === null || raw === undefined) {
    const err = new Error('sessionVersion ausente.');
    err.code = 'SESSION_VERSION_INVALID';
    throw err;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    const err = new Error('sessionVersion inválido.');
    err.code = 'SESSION_VERSION_INVALID';
    throw err;
  }
  return value;
}

function signAccessToken(user, sessionId) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new Error('sessionId inválido (não é UUID).');
  }
  return jwt.sign(
    {
      id: String(user.id),
      email: user.email,
      role: user.role,
      sv: getSessionVersion(user),
      sid: sessionId,
    },
    getJwtSecret(),
    { algorithm: 'HS256', expiresIn: ACCESS_TTL, issuer: ISSUER, audience: AUDIENCE }
  );
}

function hashRefreshToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function isValidRefreshTokenFormat(raw) {
  return typeof raw === 'string' && REFRESH_TOKEN_RE.test(raw);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return body;
}

function parseAction(req) {
  return String((req.query && req.query.action) || '');
}

function sendJson(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  return res.status(status).json(payload);
}

async function revokeRefreshSafe(userId, rawRefreshToken) {
  if (!userId || !rawRefreshToken) return false;
  try {
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const result = await db.update(refreshTokens)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(
        eq(refreshTokens.userId, userId),
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt)
      ))
      .returning({ id: refreshTokens.id });
    return result.length === 1;
  } catch (err) {
    console.error('[auth] revokeRefreshSafe falhou:', err.message);
    return false;
  }
}

function safeSetAuthCookies(res, session, operation) {
  try {
    setAuthCookies(res, session);
    return true;
  } catch (err) {
    console.error(`[auth][${operation}] setAuthCookies falhou:`, err.message);
    return false;
  }
}

function normalizeEmail(v) { return String(v).trim().toLowerCase(); }

function isValidEmail(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_EMAIL_LEN
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isValidName(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t || t.length > MAX_NAME_LEN) return false;
  if (/[\u0000-\u001F\u007F]/.test(t)) return false;
  return true;
}

function isValidPassword(v) {
  return typeof v === 'string' && v.length >= MIN_PASSWORD_LEN && v.length <= MAX_PASSWORD_LEN;
}

function trimUserAgent(ua) {
  if (typeof ua !== 'string') return null;
  return ua.slice(0, MAX_USER_AGENT_LEN);
}

// ─────────────────────────────────────────────────────────────
// SENHAS
// ─────────────────────────────────────────────────────────────
function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derived) => {
      if (err) reject(err); else resolve(derived);
    });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !isValidPassword(password)) return false;
  if (typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  if (parts[0] !== 'scrypt') return false;
  if (parts[1].length !== SCRYPT_SALT_HEX_LEN) return false;
  if (parts[2].length !== SCRYPT_HASH_HEX_LEN) return false;
  if (!/^[0-9a-f]+$/i.test(parts[1])) return false;
  if (!/^[0-9a-f]+$/i.test(parts[2])) return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== SCRYPT_SALT_BYTES) return false;
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(derived, expected);
}

// ─────────────────────────────────────────────────────────────
// PLANO
// ─────────────────────────────────────────────────────────────
async function resolvePlan(userId) {
  let plan = 'free';
  let planDegraded = false;
  try {
    const result = await getPlanForUserDetailed(userId);
    if (result?.degraded) planDegraded = true;
    else if (result && VALID_PLANS.has(result.plan)) plan = result.plan;
  } catch { planDegraded = true; }
  return { plan, planDegraded };
}

// ─────────────────────────────────────────────────────────────
// RATE LIMIT
// ─────────────────────────────────────────────────────────────
function rateUnavailable(results) {
  return results.some(r => r && (
    r.reason === 'rate_limit_unavailable' ||
    r.reason === 'rate_limit_error' ||
    r.reason === 'internal_error'
  ));
}

function rateLimited(results) {
  return results.some(r => r && r.limited === true
    && r.reason !== 'rate_limit_unavailable'
    && r.reason !== 'rate_limit_error');
}

async function applyRateLimit(res, buckets) {
  try {
    const results = await Promise.all(
      buckets.map(({ bucket, max, windowMs }) =>
        checkAndIncrement(bucket, max, windowMs, { failClosed: true })
      )
    );
    if (rateUnavailable(results)) {
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    if (rateLimited(results)) {
      const limited = results.find(r => r && r.limited === true) || {};
      const retryAfterMs = typeof limited.retryAfterMs === 'number' && limited.retryAfterMs > 0
        ? limited.retryAfterMs : null;
      if (retryAfterMs) res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return sendJson(res, 429, {
        ok: false,
        error: 'Muitas tentativas. Tente novamente em instantes.',
        retryAfterMs: retryAfterMs ?? undefined,
      });
    }
    return null;
  } catch {
    return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
  }
}

// ─────────────────────────────────────────────────────────────
// SESSÕES
// ─────────────────────────────────────────────────────────────
async function acquireUserLock(tx, userId) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${String(userId)}))`);
}

async function createRefreshTokenLocked(tx, userId, sessionId, meta) {
  const now = new Date();
  const nowIso = now.toISOString();

  const sessions = await tx
    .select({ id: refreshTokens.id, createdAt: refreshTokens.createdAt })
    .from(refreshTokens)
    .where(and(
      eq(refreshTokens.userId, userId),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, nowIso)
    ))
    .orderBy(asc(refreshTokens.createdAt), asc(refreshTokens.id));

  if (sessions.length >= MAX_SESSIONS) {
    const toRevoke = sessions.slice(0, sessions.length - MAX_SESSIONS + 1);
    const ids = toRevoke.map(s => s.id);
    if (ids.length) {
      await tx.update(refreshTokens).set({ revokedAt: nowIso })
        .where(inArray(refreshTokens.id, ids));
    }
  }

  const raw = generateRefreshToken();
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS).toISOString();

  await tx.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId,
    sessionId,
    tokenHash,
    expiresAt,
    ip: meta.ip || null,
    userAgent: meta.userAgent || null,
    createdAt: nowIso,
  });

  return { raw, expiresAt };
}

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────
async function handleSignup(req, res) {
  const body = parseBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });

  if (typeof body.name !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'Dados de cadastro inválidos.' });
  }

  const name = body.name.trim();
  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!isValidName(name)) return sendJson(res, 400, { ok: false, error: 'Nome inválido.' });
  if (!isValidEmail(email)) return sendJson(res, 400, { ok: false, error: 'E-mail inválido.' });
  if (!isValidPassword(password)) return sendJson(res, 400, { ok: false, error: 'Senha inválida.' });

  const ip = clientIp(req);
  if (!ip) return sendJson(res, 400, { ok: false, error: 'Origem não identificada.' });
  const ipHash = hashRateLimitKey(ip);

  if (await applyRateLimit(res, [
    { bucket: `signup:ip:${ipHash}`, ...RL_SIGNUP },
    { bucket: `signup:email:${hashRateLimitKey(email)}`, ...RL_SIGNUP },
  ])) return;

  try { assertJwtConfig(); }
  catch { return sendJson(res, 500, { ok: false, error: 'Configuração de autenticação inválida.' }); }

  let passwordHash;
  try { passwordHash = await hashPassword(password); }
  catch (err) {
    console.error('[auth][signup] hash falhou:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  let createdUserId = null;
  let accessToken = null;
  let refreshRaw = null;
  const sessionId = crypto.randomUUID();

  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users)
        .where(eq(users.email, email)).limit(1);
      if (existing) { const err = new Error('EMAIL_TAKEN'); err.code = 'EMAIL_TAKEN'; throw err; }

      const [insertedUser] = await tx.insert(users).values({
        id: crypto.randomUUID(),
        name, email, passwordHash,
        role: DEFAULT_ROLE,
        sessionVersion: 0,
        createdAt: new Date().toISOString(),
      }).returning({
        id: users.id, email: users.email, role: users.role,
        name: users.name, sessionVersion: users.sessionVersion,
      });

      createdUserId = insertedUser.id;
      accessToken = signAccessToken(insertedUser, sessionId);

      await acquireUserLock(tx, insertedUser.id);
      const created = await createRefreshTokenLocked(tx, insertedUser.id, sessionId, {
        ip, userAgent: trimUserAgent(req.headers['user-agent']),
      });
      refreshRaw = created.raw;
    });
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return sendJson(res, 409, { ok: false, error: 'E-mail já cadastrado.' });
    if (err.code === '23505') {
      const constraint = String(err.constraint || err.detail || '').toLowerCase();
      if (constraint.includes('email') || constraint.includes('users_email')) {
        return sendJson(res, 409, { ok: false, error: 'E-mail já cadastrado.' });
      }
      return sendJson(res, 409, { ok: false, error: 'Conflito de dados.' });
    }
    if (err.code === 'SESSION_VERSION_INVALID') {
      console.error('[auth][signup] sessionVersion inválido após INSERT');
      return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
    }
    if (isDbUnavailable(err)) {
      console.error('[auth][signup] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][signup] erro:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  if (!createdUserId) {
    console.error('[auth][signup] createdUserId ausente após commit');
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  const cookiesOk = safeSetAuthCookies(
    res,
    { access_token: accessToken, refresh_token: refreshRaw },
    'signup'
  );
  if (!cookiesOk) {
    const revoked = await revokeRefreshSafe(createdUserId, refreshRaw);
    if (!revoked) console.error('[auth][signup] CRÍTICO: refresh órfão não revogado');
    return sendJson(res, 503, { ok: false, error: 'Não foi possível iniciar sessão. Tente novamente.' });
  }

  const { plan, planDegraded } = await resolvePlan(createdUserId);
  audit?.('auth.signup', { userId: createdUserId, ip, success: true });

  return sendJson(res, 201, { ok: true, accessToken, plan, planDegraded });
}

async function handleLogin(req, res) {
  const body = parseBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });

  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'Credenciais inválidas.' });
  }

  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!isValidEmail(email) || !isValidPassword(password)) {
    return sendJson(res, 400, { ok: false, error: 'Credenciais inválidas.' });
  }

  const ip = clientIp(req);
  if (!ip) return sendJson(res, 400, { ok: false, error: 'Origem não identificada.' });
  const ipHash = hashRateLimitKey(ip);

  if (await applyRateLimit(res, [
    { bucket: `login:ip:${ipHash}`, ...RL_LOGIN },
    { bucket: `login:email:${hashRateLimitKey(email)}`, ...RL_LOGIN },
  ])) return;

  try { assertJwtConfig(); }
  catch { return sendJson(res, 500, { ok: false, error: 'Configuração de autenticação inválida.' }); }

  let user = null;
  try {
    const [row] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      passwordHash: users.passwordHash,
      sessionVersion: users.sessionVersion,
    }).from(users).where(eq(users.email, email)).limit(1);
    user = row || null;
  } catch (err) {
    if (isDbUnavailable(err)) {
      console.error('[auth][login] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][login] consulta falhou:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  let passwordOk = false;
  try {
    passwordOk = user
      ? await verifyPassword(password, user.passwordHash)
      : (await verifyPassword(password, DUMMY_PASSWORD_HASH), false);
  } catch (err) {
    console.error('[auth][login] verify falhou:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  if (!user || !passwordOk) {
    audit?.('auth.login.failed', { email, ip, success: false, reason: 'invalid_credentials' });
    return sendJson(res, 401, { ok: false, error: 'Credenciais inválidas.' });
  }

  const expectedPasswordHash = user.passwordHash;
  let accessToken = null;
  let refreshRaw = null;
  let freshUser = null;
  const sessionId = crypto.randomUUID();

  try {
    await db.transaction(async (tx) => {
      await acquireUserLock(tx, user.id);

      const [fu] = await tx.select({
        id: users.id,
        email: users.email,
        role: users.role,
        name: users.name,
        sessionVersion: users.sessionVersion,
        passwordHash: users.passwordHash,
      }).from(users).where(eq(users.id, user.id)).limit(1);

      if (!fu) {
        const err = new Error('USER_NOT_FOUND');
        err.code = 'USER_NOT_FOUND';
        throw err;
      }

      if (fu.passwordHash !== expectedPasswordHash) {
        const err = new Error('PASSWORD_CHANGED');
        err.code = 'PASSWORD_CHANGED';
        throw err;
      }

      freshUser = fu;
      accessToken = signAccessToken(fu, sessionId);

      const created = await createRefreshTokenLocked(tx, fu.id, sessionId, {
        ip, userAgent: trimUserAgent(req.headers['user-agent']),
      });
      refreshRaw = created.raw;
    });
  } catch (err) {
    if (err.code === 'SESSION_VERSION_INVALID') {
      console.error('[auth][login] sessionVersion inválido no banco');
      return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
    }
    if (err.code === 'USER_NOT_FOUND' || err.code === 'PASSWORD_CHANGED') {
      audit?.('auth.login.failed', { email, ip, success: false, reason: err.code.toLowerCase() });
      return sendJson(res, 401, { ok: false, error: 'Credenciais inválidas.' });
    }
    if (isDbUnavailable(err)) {
      console.error('[auth][login] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][login] erro:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  const cookiesOk = safeSetAuthCookies(
    res,
    { access_token: accessToken, refresh_token: refreshRaw },
    'login'
  );
  if (!cookiesOk) {
    const revoked = await revokeRefreshSafe(user.id, refreshRaw);
    if (!revoked) console.error('[auth][login] CRÍTICO: refresh órfão não revogado');
    return sendJson(res, 503, { ok: false, error: 'Não foi possível iniciar sessão. Tente novamente.' });
  }

  const { plan, planDegraded } = await resolvePlan(user.id);
  audit?.('auth.login.success', { userId: user.id, ip, success: true });

  return sendJson(res, 200, {
    ok: true,
    accessToken,
    user: {
      id: freshUser.id,
      name: freshUser.name,
      email: freshUser.email,
      role: freshUser.role,
    },
    plan, planDegraded,
  });
}

async function handleRefresh(req, res) {
  const raw = getRefreshToken(req);
  if (!isValidRefreshTokenFormat(raw)) {
    clearAuthCookies(res);
    return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
  }

  const ip = clientIp(req);
  if (!ip) return sendJson(res, 400, { ok: false, error: 'Origem não identificada.' });
  const ipHash = hashRateLimitKey(ip);

  if (await applyRateLimit(res, [{ bucket: `refresh:ip:${ipHash}`, ...RL_REFRESH }])) return;

  try { assertJwtConfig(); }
  catch { return sendJson(res, 500, { ok: false, error: 'Configuração de autenticação inválida.' }); }

  const tokenHash = hashRefreshToken(raw);

  let row = null;
  try {
    const [r] = await db.select({
      id: refreshTokens.id,
      userId: refreshTokens.userId,
      sessionId: refreshTokens.sessionId,
      expiresAt: refreshTokens.expiresAt,
      revokedAt: refreshTokens.revokedAt,
      replacedAt: refreshTokens.replacedAt,
    }).from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
    row = r || null;
  } catch (err) {
    if (isDbUnavailable(err)) {
      console.error('[auth][refresh] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][refresh] consulta falhou:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  if (!row) {
    clearAuthCookies(res);
    audit?.('auth.refresh.rejected', { reason: 'not_found', ip, success: false });
    return sendJson(res, 401, { ok: false, error: 'Sessão inválida.', reason: 'not_found' });
  }

  if (row.revokedAt) {
    const reason = row.replacedAt ? 'REFRESH_RACE' : 'REFRESH_REVOKED';
    audit?.('auth.refresh.rejected', { reason, userId: row.userId, ip, success: false });
    return sendJson(res, 401, {
      ok: false,
      error: reason === 'REFRESH_RACE' ? 'Sessão renovada em outra aba.' : 'Sessão revogada.',
      reason,
    });
  }

  const preExp = Date.parse(row.expiresAt);
  if (!Number.isFinite(preExp) || preExp <= Date.now()) {
    clearAuthCookies(res);
    audit?.('auth.refresh.rejected', { reason: 'REFRESH_EXPIRED', userId: row.userId, ip, success: false });
    return sendJson(res, 401, { ok: false, error: 'Sessão expirada.', reason: 'REFRESH_EXPIRED' });
  }

  let newRaw = null;
  let accessToken = null;

  try {
    await db.transaction(async (tx) => {
      // [FIX P1] lock ANTES de qualquer decisão sobre legado
      await acquireUserLock(tx, row.userId);

      const [freshUser] = await tx.select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        sessionVersion: users.sessionVersion,
      }).from(users).where(eq(users.id, row.userId)).limit(1);

      if (!freshUser) {
        const err = new Error('USER_NOT_FOUND');
        err.code = 'USER_NOT_FOUND';
        throw err;
      }

      // [FIX P1] reavalia estado do token DENTRO da transação
      const [fresh] = await tx.select({
        id: refreshTokens.id,
        sessionId: refreshTokens.sessionId,
        expiresAt: refreshTokens.expiresAt,
        revokedAt: refreshTokens.revokedAt,
      }).from(refreshTokens).where(eq(refreshTokens.id, row.id)).limit(1);

      if (!fresh || fresh.revokedAt) {
        const err = new Error('REFRESH_RACE'); err.code = 'REFRESH_RACE'; throw err;
      }
      const exp = Date.parse(fresh.expiresAt);
      if (!Number.isFinite(exp) || exp <= Date.now()) {
        const err = new Error('REFRESH_EXPIRED'); err.code = 'REFRESH_EXPIRED'; throw err;
      }

      // [FIX P1] decide legado APÓS ler o estado real do token
      const stillLegacy = !fresh.sessionId;
      const finalSessionId = fresh.sessionId || crypto.randomUUID();

      if (stillLegacy) {
        // Revoga apenas OUTROS tokens legados do mesmo usuário.
        // Se a segunda requisição concorrente chegar aqui, o token original
        // já estará revogado (fresh.revokedAt) e o throw acima impede a
        // revogação em massa de tokens legados não relacionados.
        await tx.update(refreshTokens)
          .set({ revokedAt: new Date().toISOString() })
          .where(and(
            eq(refreshTokens.userId, freshUser.id),
            isNull(refreshTokens.sessionId),
            isNull(refreshTokens.revokedAt),
            ne(refreshTokens.id, row.id)
          ));
      }

      const nowIso = new Date().toISOString();
      const revokeResult = await tx.update(refreshTokens)
        .set({ revokedAt: nowIso, replacedAt: nowIso, sessionId: finalSessionId })
        .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
        .returning({ id: refreshTokens.id });

      if (!revokeResult.length) {
        const err = new Error('REFRESH_RACE'); err.code = 'REFRESH_RACE'; throw err;
      }

      accessToken = signAccessToken(freshUser, finalSessionId);

      const created = await createRefreshTokenLocked(tx, freshUser.id, finalSessionId, {
        ip, userAgent: trimUserAgent(req.headers['user-agent']),
      });
      newRaw = created.raw;
    });
  } catch (err) {
    if (err.code === 'REFRESH_RACE') {
      audit?.('auth.refresh.rejected', { reason: 'REFRESH_RACE', userId: row.userId, ip, success: false });
      return sendJson(res, 401, { ok: false, error: 'Sessão renovada em outra aba.', reason: 'REFRESH_RACE' });
    }
    if (err.code === 'REFRESH_EXPIRED') {
      clearAuthCookies(res);
      audit?.('auth.refresh.rejected', { reason: 'REFRESH_EXPIRED', userId: row.userId, ip, success: false });
      return sendJson(res, 401, { ok: false, error: 'Sessão expirada.', reason: 'REFRESH_EXPIRED' });
    }
    if (err.code === 'USER_NOT_FOUND') {
      clearAuthCookies(res);
      return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
    }
    if (err.code === 'SESSION_VERSION_INVALID') {
      console.error('[auth][refresh] sessionVersion inválido no banco');
      return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
    }
    if (isDbUnavailable(err)) {
      console.error('[auth][refresh] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][refresh] erro:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  const cookiesOk = safeSetAuthCookies(
    res,
    { access_token: accessToken, refresh_token: newRaw },
    'refresh'
  );
  if (!cookiesOk) {
    const revoked = await revokeRefreshSafe(row.userId, newRaw);
    if (!revoked) console.error('[auth][refresh] CRÍTICO: novo refresh órfão não revogado');
    return sendJson(res, 503, { ok: false, error: 'Falha ao renovar sessão. Faça login novamente.' });
  }

  const { plan, planDegraded } = await resolvePlan(row.userId);
  audit?.('auth.refresh.success', { userId: row.userId, ip, success: true });

  return sendJson(res, 200, {
    ok: true,
    accessToken,
    user: { id: row.userId },
    plan, planDegraded,
  });
}

async function handleLogout(req, res) {
  const raw = getRefreshToken(req);
  if (!isValidRefreshTokenFormat(raw)) {
    clearAuthCookies(res);
    return sendJson(res, 200, { ok: true });
  }

  const tokenHash = hashRefreshToken(raw);

  let userId = null;
  try {
    const [row] = await db.select({ userId: refreshTokens.userId })
      .from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);
    userId = row?.userId || null;
  } catch (err) {
    if (isDbUnavailable(err)) {
      console.error('[auth][logout] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][logout] lookup falhou:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Logout não confirmado pelo servidor.' });
  }

  if (!userId) {
    clearAuthCookies(res);
    return sendJson(res, 200, { ok: true });
  }

  try {
    await db.transaction(async (tx) => {
      await acquireUserLock(tx, userId);

      const [freshRow] = await tx.select({
        id: refreshTokens.id,
        sessionId: refreshTokens.sessionId,
        revokedAt: refreshTokens.revokedAt,
        replacedAt: refreshTokens.replacedAt,
      }).from(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).limit(1);

      if (!freshRow) return;

      const sessionId = freshRow.sessionId;
      const nowIso = new Date().toISOString();

      if (sessionId) {
        await tx.update(refreshTokens).set({ revokedAt: nowIso })
          .where(and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.sessionId, sessionId),
            isNull(refreshTokens.revokedAt)
          ));
      } else {
        await tx.update(refreshTokens).set({ revokedAt: nowIso })
          .where(and(
            eq(refreshTokens.userId, userId),
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.revokedAt)
          ));
      }
    });
  } catch (err) {
    if (isDbUnavailable(err)) {
      console.error('[auth][logout] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][logout] erro:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Logout não confirmado pelo servidor.' });
  }

  audit?.('auth.logout', { userId, ip: clientIp(req), success: true });
  clearAuthCookies(res);
  return sendJson(res, 200, { ok: true });
}

async function handleLogoutAll(req, res, authUser) {
  try {
    await db.transaction(async (tx) => {
      await acquireUserLock(tx, authUser.id);
      await tx.update(refreshTokens).set({ revokedAt: new Date().toISOString() })
        .where(and(eq(refreshTokens.userId, authUser.id), isNull(refreshTokens.revokedAt)));
      await tx.update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(eq(users.id, authUser.id));
    });
  } catch (err) {
    if (isDbUnavailable(err)) {
      console.error('[auth][logout-all] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    console.error('[auth][logout-all] erro:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  clearAuthCookies(res);
  audit?.('auth.logout-all', { userId: authUser.id, ip: clientIp(req), success: true });
  return sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, authUser) {
  let user;
  try {
    [user] = await db.select({
      id: users.id, name: users.name, email: users.email, role: users.role,
    }).from(users).where(eq(users.id, authUser.id)).limit(1);
  } catch (err) {
    if (isDbUnavailable(err)) {
      console.error('[auth][me] DB indisponível:', err.code);
      return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
    }
    console.error('[auth][me] erro:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  if (!user) return sendJson(res, 401, { ok: false, error: 'Não autenticado.' });

  const { plan, planDegraded } = await resolvePlan(user.id);
  return sendJson(res, 200, { ok: true, user, plan, planDegraded });
}

// ─────────────────────────────────────────────────────────────
// ROTEADOR
// ─────────────────────────────────────────────────────────────
const MUTATING_ACTIONS = new Set(['signup', 'login', 'refresh', 'logout', 'logout-all']);
const KNOWN_ACTIONS = new Set(['signup', 'login', 'refresh', 'logout', 'logout-all', 'me']);

module.exports = async (req, res) => {
  const action = parseAction(req);

  const originOk = checkOrigin(req);
  const origin = validatedOrigin(req);

  if (req.method === 'OPTIONS') {
    if (!originOk) return res.status(403).end();
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }

  if (req.method === 'POST' && MUTATING_ACTIONS.has(action) && !originOk) {
    return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
  }

  try {
    if (action === 'signup' && req.method === 'POST') return await handleSignup(req, res);
    if (action === 'login' && req.method === 'POST') return await handleLogin(req, res);
    if (action === 'refresh' && req.method === 'POST') return await handleRefresh(req, res);
    if (action === 'logout' && req.method === 'POST') return await handleLogout(req, res);

    if (action === 'logout-all') {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
      let authUser = null;
      try { authUser = await getAuthUser(req); }
      catch { return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' }); }
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Não autenticado.' });
      return await handleLogoutAll(req, res, authUser);
    }

    if (action === 'me') {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
      let authUser = null;
      try { authUser = await getAuthUser(req); }
      catch { return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' }); }
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Não autenticado.' });
      return await handleMe(req, res, authUser);
    }

    if (KNOWN_ACTIONS.has(action)) return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
    return sendJson(res, 404, { ok: false, error: 'Ação não encontrada.' });
  } catch (err) {
    console.error('[auth] erro não tratado:', err.code || err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }
};