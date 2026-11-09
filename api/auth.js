'use strict';

/* ============================================================
   API: /api/auth — Autenticação (Versão Final Corrigida)
   Contrato:
     POST ?action=signup   { name, email, password }
     POST ?action=login    { email, password }
     POST ?action=refresh  (cookie rt)
     POST ?action=logout   (cookie rt)
     POST ?action=logout-all (auth)
     GET  ?action=me       (auth)
   ⚠️  Toda operação mutável exige checkOrigin (CSRF), inclusive OPTIONS.
   ⚠️  Todo fluxo que cria/revoga sessão usa acquireUserLock().
   ============================================================ */

const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const { eq, and, isNull, gt, inArray, sql } = require('drizzle-orm');
const { db } = require('./_db');
const { users, refreshTokens } = require('../src/schema.js');
const {
  getAuthUser,
  checkOrigin,
  clientIp,
  checkAndIncrement,
  getPlanForUserDetailed,
  VALID_PLANS,
  JWT_ISSUER,
  JWT_AUDIENCE,
  audit,               // [FIX 10.3] auditoria centralizada
} = require('./_lib');

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────
const ACCESS_TTL = '15m';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // ⚠️ CONTRATO: = _lib.REFRESH_MAX_AGE
const MAX_SESSIONS = 5;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_HASH_HEX_LEN = SCRYPT_KEYLEN * 2;
const SCRYPT_SALT_HEX_LEN = SCRYPT_SALT_BYTES * 2;
const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{60,80}$/;
const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 254;
const MAX_PASSWORD_LEN = 200;
const MIN_PASSWORD_LEN = 8;
const MAX_USER_AGENT_LEN = 512;
// ⚠️ CONTRATO: confirmar enum real de users.role ('CUSTOMER' vs 'user')
const DEFAULT_ROLE = 'CUSTOMER';

if (!JWT_ISSUER || !JWT_AUDIENCE) {
  throw new Error(
    '[auth] JWT_ISSUER/JWT_AUDIENCE ausentes em _lib.js — emissão abortada.'
  );
}
const ISSUER = JWT_ISSUER;
const AUDIENCE = JWT_AUDIENCE;

// [FIX 8] Hash fictício pré-computado para equalizar timing em login
// (gerado uma única vez no boot, com os mesmos parâmetros da app).
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

function assertJwtConfig() {
  getJwtSecret();
}

function signAccessToken(user) {
  return jwt.sign(
    { id: String(user.id), email: user.email, role: user.role },
    getJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: ACCESS_TTL,
      issuer: ISSUER,
      audience: AUDIENCE,
    }
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

function normalizeEmail(v) {
  return String(v).trim().toLowerCase();
}

function isValidEmail(v) {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_EMAIL_LEN &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  );
}

function isValidName(v) {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!t || t.length > MAX_NAME_LEN) return false;
  if (/[\u0000-\u001F\u007F]/.test(t)) return false;
  return true;
}

function isValidPassword(v) {
  return (
    typeof v === 'string' &&
    v.length >= MIN_PASSWORD_LEN &&
    v.length <= MAX_PASSWORD_LEN
  );
}

function trimUserAgent(ua) {
  if (typeof ua !== 'string') return null;
  return ua.slice(0, MAX_USER_AGENT_LEN);
}

// [FIX 10.2] Composição de Set-Cookie sem sobrescrever outros cookies
function appendSetCookie(res, cookieStr) {
  const existing = res.getHeader('Set-Cookie');
  const list = existing
    ? Array.isArray(existing) ? existing.slice() : [String(existing)]
    : [];
  list.push(cookieStr);
  res.setHeader('Set-Cookie', list);
}

// ─────────────────────────────────────────────────────────────
// COOKIES (⚠️ CONTRATO com _lib.js)
// ─────────────────────────────────────────────────────────────
function setRefreshCookie(res, raw) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendSetCookie(
    res,
    `rt=${raw}; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=${Math.floor(
      REFRESH_TTL_MS / 1000
    )}${secure}`
  );
}

function clearRefreshCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  appendSetCookie(
    res,
    `rt=; HttpOnly; Path=/api/auth; SameSite=Strict; Max-Age=0${secure}`
  );
}

function readRefreshCookie(req) {
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(/(?:^|;\s*)rt=([^;]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// SENHAS
// ─────────────────────────────────────────────────────────────
function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
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
    if (result?.degraded) {
      planDegraded = true;
    } else if (result && VALID_PLANS.has(result.plan)) {
      plan = result.plan;
    }
  } catch {
    planDegraded = true;
  }
  return { plan, planDegraded };
}

// ─────────────────────────────────────────────────────────────
// RATE LIMIT (⚠️ CONTRATO com checkAndIncrement)
// ─────────────────────────────────────────────────────────────
function rateUnavailable(results) {
  return results.some(
    (r) =>
      r &&
      (r.reason === 'rate_limit_unavailable' ||
        r.reason === 'rate_limit_error' ||
        r.reason === 'internal_error')
  );
}

function rateLimited(results) {
  return results.some(
    (r) =>
      r &&
      r.limited === true &&
      r.reason !== 'rate_limit_unavailable' &&
      r.reason !== 'rate_limit_error'
  );
}

async function applyRateLimit(res, keys) {
  try {
    const results = await Promise.all(
      keys.map((k) => checkAndIncrement(k, { failClosed: true }))
    );
    if (rateUnavailable(results)) {
      return sendJson(res, 503, { ok: false, error: 'Serviço temporariamente indisponível.' });
    }
    if (rateLimited(results)) {
      // [FIX 7] Retry-After do limiter, não inventado
      const limited = results.find((r) => r && r.limited === true) || {};
      const retryAfterMs =
        typeof limited.retryAfterMs === 'number' && limited.retryAfterMs > 0
          ? limited.retryAfterMs
          : null;
      if (retryAfterMs) {
        res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      }
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
// SESSÕES — advisory lock unificado
// ─────────────────────────────────────────────────────────────
async function acquireUserLock(tx, userId) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${String(userId)}))`
  );
}

async function createRefreshTokenLocked(tx, userId, meta) {
  const now = new Date();
  const nowIso = now.toISOString();

  const sessions = await tx
    .select({ id: refreshTokens.id, createdAt: refreshTokens.createdAt })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, nowIso)
      )
    )
    .orderBy(refreshTokens.createdAt);

  if (sessions.length >= MAX_SESSIONS) {
    const toRevoke = sessions.slice(0, sessions.length - MAX_SESSIONS + 1);
    const ids = toRevoke.map((s) => s.id);
    if (ids.length) {
      await tx
        .update(refreshTokens)
        .set({ revokedAt: nowIso })
        .where(inArray(refreshTokens.id, ids));
    }
  }

  const raw = generateRefreshToken();
  const tokenHash = hashRefreshToken(raw);
  const expiresAt = new Date(now.getTime() + REFRESH_TTL_MS).toISOString();

  await tx.insert(refreshTokens).values({
    id: crypto.randomUUID(),
    userId,
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

  // [FIX 4] validação de tipos ANTES de normalizar
  if (
    typeof body.name !== 'string' ||
    typeof body.email !== 'string' ||
    typeof body.password !== 'string'
  ) {
    return sendJson(res, 400, { ok: false, error: 'Dados de cadastro inválidos.' });
  }

  const name = body.name.trim();
  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!isValidName(name)) {
    return sendJson(res, 400, { ok: false, error: 'Nome inválido.' });
  }
  if (!isValidEmail(email)) {
    return sendJson(res, 400, { ok: false, error: 'E-mail inválido.' });
  }
  if (!isValidPassword(password)) {
    return sendJson(res, 400, { ok: false, error: 'Senha inválida.' });
  }

  const ip = clientIp(req);
  if (!ip) {
    return sendJson(res, 400, { ok: false, error: 'Origem não identificada.' });
  }

  if (await applyRateLimit(res, [`signup:ip:${ip}`, `signup:email:${email}`])) return;

  try {
    assertJwtConfig();
  } catch {
    return sendJson(res, 500, { ok: false, error: 'Configuração de autenticação inválida.' });
  }

  const passwordHash = await hashPassword(password);

  let createdUserId = null;
  let accessToken = null;
  let refreshRaw = null;

  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (existing) {
        const err = new Error('EMAIL_TAKEN');
        err.code = 'EMAIL_TAKEN';
        throw err;
      }

      const [insertedUser] = await tx
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          name,
          email,
          passwordHash,
          role: DEFAULT_ROLE,
          createdAt: new Date().toISOString(),
          // ⚠️ CONTRATO: confirmar se users.updatedAt é obrigatório.
          // Se for e não tiver DEFAULT, descomentar a linha abaixo:
          // updatedAt: new Date().toISOString(),
        })
        .returning();

      createdUserId = insertedUser.id;
      accessToken = signAccessToken(insertedUser);

      await acquireUserLock(tx, insertedUser.id);
      const created = await createRefreshTokenLocked(tx, insertedUser.id, {
        ip,
        userAgent: trimUserAgent(req.headers['user-agent']),
      });
      refreshRaw = created.raw;
    });
  } catch (err) {
    // [FIX 3] só trata 23505 como e-mail duplicado se a constraint for a certa
    if (err.code === 'EMAIL_TAKEN') {
      return sendJson(res, 409, { ok: false, error: 'E-mail já cadastrado.' });
    }
    if (err.code === '23505') {
      const constraint = String(err.constraint || err.detail || '').toLowerCase();
      if (constraint.includes('email') || constraint.includes('users_email')) {
        return sendJson(res, 409, { ok: false, error: 'E-mail já cadastrado.' });
      }
      console.error('[auth][signup] unique violation inesperada:', constraint);
      return sendJson(res, 409, { ok: false, error: 'Conflito de dados.' });
    }
    console.error('[auth][signup] erro:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  const { plan, planDegraded } = await resolvePlan(createdUserId);

  setRefreshCookie(res, refreshRaw);
  // [FIX 10.3] auditoria (sem dados sensíveis)
  audit?.('auth.signup', { userId: createdUserId, ip });
  return sendJson(res, 201, { ok: true, accessToken, plan, planDegraded });
}

async function handleLogin(req, res) {
  const body = parseBody(req);
  if (!body) return sendJson(res, 400, { ok: false, error: 'Payload inválido.' });

  // [FIX 4] tipos antes de normalizar
  if (typeof body.email !== 'string' || typeof body.password !== 'string') {
    return sendJson(res, 400, { ok: false, error: 'Credenciais inválidas.' });
  }

  const email = normalizeEmail(body.email);
  const password = body.password;

  if (!isValidEmail(email) || !isValidPassword(password)) {
    return sendJson(res, 400, { ok: false, error: 'Credenciais inválidas.' });
  }

  const ip = clientIp(req);
  if (!ip) {
    return sendJson(res, 400, { ok: false, error: 'Origem não identificada.' });
  }

  if (await applyRateLimit(res, [`login:ip:${ip}`, `login:email:${email}`])) return;

  try {
    assertJwtConfig();
  } catch {
    return sendJson(res, 500, { ok: false, error: 'Configuração de autenticação inválida.' });
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  // [FIX 8] equaliza timing: verifica contra hash fictício se usuário não existe
  const passwordOk = user
    ? await verifyPassword(password, user.passwordHash)
    : (await verifyPassword(password, DUMMY_PASSWORD_HASH), false);

  if (!user || !passwordOk) {
    audit?.('auth.login.failed', { email, ip }); // [FIX 10.3]
    return sendJson(res, 401, { ok: false, error: 'Credenciais inválidas.' });
  }

  let accessToken = null;
  let refreshRaw = null;

  try {
    await db.transaction(async (tx) => {
      accessToken = signAccessToken(user);
      await acquireUserLock(tx, user.id);
      const created = await createRefreshTokenLocked(tx, user.id, {
        ip,
        userAgent: trimUserAgent(req.headers['user-agent']),
      });
      refreshRaw = created.raw;
    });
  } catch (err) {
    console.error('[auth][login] erro:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  const { plan, planDegraded } = await resolvePlan(user.id);

  setRefreshCookie(res, refreshRaw);
  audit?.('auth.login.success', { userId: user.id, ip });
  return sendJson(res, 200, {
    ok: true,
    accessToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    plan,
    planDegraded,
  });
}

async function handleRefresh(req, res) {
  const raw = readRefreshCookie(req);
  if (!isValidRefreshTokenFormat(raw)) {
    clearRefreshCookie(res);
    return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
  }

  const ip = clientIp(req);
  if (!ip) {
    return sendJson(res, 400, { ok: false, error: 'Origem não identificada.' });
  }

  if (await applyRateLimit(res, [`refresh:ip:${ip}`])) return;

  try {
    assertJwtConfig();
  } catch {
    return sendJson(res, 500, { ok: false, error: 'Configuração de autenticação inválida.' });
  }

  const tokenHash = hashRefreshToken(raw);

  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.tokenHash, tokenHash),
        isNull(refreshTokens.revokedAt)
      )
    )
    .limit(1);

  if (!row) {
    clearRefreshCookie(res);
    audit?.('auth.refresh.rejected', { reason: 'not_found', ip });
    return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
  }

  // Pré-checagem rápida (fora da transação) para evitar lock desnecessário
  const preExp = Date.parse(row.expiresAt);
  if (!Number.isFinite(preExp) || preExp <= Date.now()) {
    clearRefreshCookie(res);
    audit?.('auth.refresh.rejected', { reason: 'expired_pre', userId: row.userId, ip });
    return sendJson(res, 401, { ok: false, error: 'Sessão expirada.' });
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user) {
    clearRefreshCookie(res);
    audit?.('auth.refresh.rejected', { reason: 'no_user', userId: row.userId, ip });
    return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
  }

  let newRaw = null;
  let accessToken = null;

  try {
    await db.transaction(async (tx) => {
      await acquireUserLock(tx, user.id);

      // [FIX 5] revalidar expiração DENTRO da transação, após o lock
      const [fresh] = await tx
        .select({ id: refreshTokens.id, expiresAt: refreshTokens.expiresAt, revokedAt: refreshTokens.revokedAt })
        .from(refreshTokens)
        .where(eq(refreshTokens.id, row.id))
        .limit(1);

      if (!fresh || fresh.revokedAt) {
        const err = new Error('REFRESH_RACE');
        err.code = 'REFRESH_RACE';
        throw err;
      }
      const exp = Date.parse(fresh.expiresAt);
      if (!Number.isFinite(exp) || exp <= Date.now()) {
        const err = new Error('REFRESH_EXPIRED');
        err.code = 'REFRESH_EXPIRED';
        throw err;
      }

      const nowIso = new Date().toISOString();
      const revokeResult = await tx
        .update(refreshTokens)
        .set({ revokedAt: nowIso, replacedAt: nowIso })
        .where(
          and(
            eq(refreshTokens.id, row.id),
            isNull(refreshTokens.revokedAt)
          )
        )
        .returning({ id: refreshTokens.id });

      if (!revokeResult.length) {
        const err = new Error('REFRESH_RACE');
        err.code = 'REFRESH_RACE';
        throw err;
      }

      accessToken = signAccessToken(user);

      const created = await createRefreshTokenLocked(tx, user.id, {
        ip,
        userAgent: trimUserAgent(req.headers['user-agent']),
      });
      newRaw = created.raw;
    });
  } catch (err) {
    if (err.code === 'REFRESH_RACE' || err.code === 'REFRESH_EXPIRED') {
      clearRefreshCookie(res);
      audit?.('auth.refresh.rejected', { reason: err.code, userId: user.id, ip });
      return sendJson(res, 401, { ok: false, error: 'Sessão inválida.' });
    }
    console.error('[auth][refresh] erro:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  const { plan, planDegraded } = await resolvePlan(user.id);

  setRefreshCookie(res, newRaw);
  return sendJson(res, 200, {
    ok: true,
    accessToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    plan,
    planDegraded,
  });
}

async function handleLogout(req, res) {
  const raw = readRefreshCookie(req);
  if (isValidRefreshTokenFormat(raw)) {
    const tokenHash = hashRefreshToken(raw);

    // [FIX 1] localiza userId fora da transação para adquirir o lock correto
    let userId = null;
    try {
      const [row] = await db
        .select({ userId: refreshTokens.userId })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash))
        .limit(1);
      userId = row?.userId || null;
    } catch (err) {
      console.error('[auth][logout] lookup falhou:', err.message);
      return sendJson(res, 500, { ok: false, error: 'Logout não confirmado pelo servidor.' });
    }

    if (userId) {
      try {
        await db.transaction(async (tx) => {
          await acquireUserLock(tx, userId);
          // Revogação condicional DENTRO do lock; estado pode ter mudado
          await tx
            .update(refreshTokens)
            .set({ revokedAt: new Date().toISOString() })
            .where(
              and(
                eq(refreshTokens.tokenHash, tokenHash),
                isNull(refreshTokens.revokedAt)
              )
            );
        });
      } catch (err) {
        console.error('[auth][logout] erro:', err.message);
        return sendJson(res, 500, { ok: false, error: 'Logout não confirmado pelo servidor.' });
      }
      audit?.('auth.logout', { userId, ip: clientIp(req) });
    }
  }
  clearRefreshCookie(res);
  return sendJson(res, 200, { ok: true });
}

async function handleLogoutAll(req, res, authUser) {
  try {
    await db.transaction(async (tx) => {
      await acquireUserLock(tx, authUser.id);
      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(
          and(
            eq(refreshTokens.userId, authUser.id),
            isNull(refreshTokens.revokedAt)
          )
        );
    });
  } catch (err) {
    console.error('[auth][logout-all] erro:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }

  clearRefreshCookie(res);
  audit?.('auth.logout-all', { userId: authUser.id, ip: clientIp(req) });
  // Observação: access tokens já emitidos permanecem válidos até expirar.
  return sendJson(res, 200, { ok: true });
}

async function handleMe(req, res, authUser) {
  let user;
  try {
    [user] = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, authUser.id))
      .limit(1);
  } catch (err) {
    console.error('[auth][me] erro:', err.message);
    return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
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

  // [FIX 2] CORS/CSRF aplicados ANTES do OPTIONS
  const allowedOrigin = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const originOk = checkOrigin(req);

  if (req.method === 'OPTIONS') {
    if (!originOk) return res.status(403).end();
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }

  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  // [FIX 2] CSRF em toda operação mutável
  if (req.method === 'POST' && MUTATING_ACTIONS.has(action) && !originOk) {
    return sendJson(res, 403, { ok: false, error: 'Origem não permitida.' });
  }

  try {
    if (action === 'signup' && req.method === 'POST') return await handleSignup(req, res);
    if (action === 'login' && req.method === 'POST') return await handleLogin(req, res);
    if (action === 'refresh' && req.method === 'POST') return await handleRefresh(req, res);
    if (action === 'logout' && req.method === 'POST') return await handleLogout(req, res);

    if (action === 'logout-all') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
      }
      let authUser = null;
      try {
        authUser = await getAuthUser(req);
      } catch {
        return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
      }
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Não autenticado.' });
      return await handleLogoutAll(req, res, authUser);
    }

    if (action === 'me') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
      }
      let authUser = null;
      try {
        authUser = await getAuthUser(req);
      } catch {
        return sendJson(res, 503, { ok: false, error: 'Serviço indisponível.' });
      }
      if (!authUser) return sendJson(res, 401, { ok: false, error: 'Não autenticado.' });
      return await handleMe(req, res, authUser);
    }

    if (KNOWN_ACTIONS.has(action)) {
      return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
    }

    return sendJson(res, 404, { ok: false, error: 'Ação não encontrada.' });
  } catch (err) {
    console.error('[auth] erro não tratado:', err.message);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.' });
  }
};