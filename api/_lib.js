/* ============================================================
   api/_lib.js — Módulos internos consolidados
   ------------------------------------------------------------
   Substitui: módulos legados de auth, audit, rate-limit e plan.
   ⚠️ NUNCA importar no cliente. Só serverless functions.
   ============================================================ */

'use strict';

const crypto = require('crypto');
const { isIP } = require('node:net');
const jwt = require('jsonwebtoken');

if (typeof window !== 'undefined') {
  throw new Error('[_lib] Este módulo não pode ser importado no cliente.');
}

// ═════════════════════════════════════════════════════════════
// CONSTANTES GLOBAIS
// ═════════════════════════════════════════════════════════════
const IS_PROD = process.env.NODE_ENV === 'production';

const AUTH_COOKIE_PROD = '__Host-jm_auth_access';
const REFRESH_COOKIE_PROD = '__Host-jm_auth_refresh';
const AUTH_COOKIE_DEV = 'jm_auth_access';
const REFRESH_COOKIE_DEV = 'jm_auth_refresh';

const AUTH_COOKIE = IS_PROD ? AUTH_COOKIE_PROD : AUTH_COOKIE_DEV;
const REFRESH_COOKIE = IS_PROD ? REFRESH_COOKIE_PROD : REFRESH_COOKIE_DEV;

const ACCESS_MAX_AGE = 60 * 60;
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7;

const VALID_PLANS = new Set(['free', 'premium', 'anual']);

function normalizeOrigin(value) {
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return null;
  }
}

const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean)
);

// ═════════════════════════════════════════════════════════════
// HTTP — helpers
// ═════════════════════════════════════════════════════════════
function sendJson(res, status, body) {
  if (res.headersSent) {
    console.warn('[_lib] sendJson após headers enviados');
    return;
  }

  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!res.getHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  res.end(JSON.stringify(body));
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); } catch { body = {}; }
  }
  return body && typeof body === 'object' ? body : {};
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  String(header).split(';').forEach((item) => {
    const i = item.indexOf('=');
    if (i < 0) return;
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); }
      catch { out[k] = v; }
    }
  });

  return out;
}

function clientIp(req) {
  const headers = req.headers || {};

  const trustedProxyHeader =
    headers['x-real-ip'] ||
    headers['x-vercel-forwarded-for'];

  if (trustedProxyHeader) {
    const candidate = String(trustedProxyHeader).split(',')[0].trim();
    if (isIP(candidate)) return candidate.slice(0, 128);
  }

  if (!IS_PROD) {
    const forwarded = headers['x-forwarded-for'];
    if (forwarded) {
      const candidate = String(forwarded).split(',')[0].trim();
      if (isIP(candidate)) return candidate.slice(0, 128);
    }
  }

  const remote = req.socket?.remoteAddress;
  return remote && isIP(remote) ? remote.slice(0, 128) : '';
}

// ═════════════════════════════════════════════════════════════
// COOKIES — auth
// ═════════════════════════════════════════════════════════════
function buildCookie(name, value, maxAge) {
  const safeMaxAge = Math.max(0, Number(maxAge) || 0);
  const encoded = value ? encodeURIComponent(value) : '';

  const parts = [
    name + '=' + encoded,
    'Max-Age=' + safeMaxAge,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];

  if (IS_PROD) parts.push('Secure');

  return parts.join('; ');
}

function appendSetCookie(res, cookies) {
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(cookies) ? cookies : [cookies];

  if (!existing) res.setHeader('Set-Cookie', list);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', existing.concat(list));
  else res.setHeader('Set-Cookie', [existing].concat(list));
}

function setAuthCookies(res, session) {
  if (!res || !session) {
    throw new Error('Sessão inválida.');
  }

  const accessToken = String(session.access_token || '');
  const refreshToken = String(session.refresh_token || '');

  if (!accessToken) {
    throw new Error('Token de acesso ausente.');
  }

  const list = [buildCookie(AUTH_COOKIE, accessToken, ACCESS_MAX_AGE)];

  if (refreshToken) {
    list.push(buildCookie(REFRESH_COOKIE, refreshToken, REFRESH_MAX_AGE));
  }

  appendSetCookie(res, list);
}

function clearAuthCookies(res) {
  if (!res) return;
  appendSetCookie(res, [
    buildCookie(AUTH_COOKIE, '', 0),
    buildCookie(REFRESH_COOKIE, '', 0)
  ]);
}

function getAccessToken(req) {
  const cookies = parseCookies(req?.headers?.cookie || req?.headers?.Cookie);
  return cookies[AUTH_COOKIE] || '';
}

function getRefreshToken(req) {
  const cookies = parseCookies(req?.headers?.cookie || req?.headers?.Cookie);
  return cookies[REFRESH_COOKIE] || '';
}

async function getAuthUser(req) {
  const accessToken = getAccessToken(req);
  if (!accessToken) return null;

  const secret = String(process.env.JWT_SECRET || '').trim();
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    console.error('[_lib] JWT_SECRET ausente ou muito curto.');
    return null;
  }

  try {
    const payload = jwt.verify(accessToken, secret, {
      algorithms: ['HS256'],
      clockTolerance: 5
    });

    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.id)
    ) {
      return null;
    }

    return {
      id: payload.id,
      email: typeof payload.email === 'string' ? payload.email : null,
      role: typeof payload.role === 'string' ? payload.role : 'user'
    };
  } catch (error) {
    if (
      error.name !== 'TokenExpiredError' &&
      error.name !== 'JsonWebTokenError' &&
      error.name !== 'NotBeforeError'
    ) {
      console.error('[_lib] Erro inesperado na autenticação:', error.message);
    }
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// RATE LIMIT — KV (Upstash / Vercel KV)
// ═════════════════════════════════════════════════════════════
let _redis = null;
let _redisInitFailed = false;

function getRedis() {
  if (_redis) return _redis;
  if (_redisInitFailed) return null;

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    _redisInitFailed = true;
    return null;
  }

  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    return _redis;
  } catch (err) {
    console.warn('[_lib] @upstash/redis não instalado — rate limit desativado.');
    _redisInitFailed = true;
    return null;
  }
}

async function checkAndIncrement(bucket, max, windowMs = 15 * 60 * 1000, options = {}) {
  const { failClosed = false } = options;

  if (typeof bucket !== 'string' || !bucket.trim() || bucket.length > 200) {
    return { limited: true, retryAfter: 1, reason: 'INVALID_BUCKET' };
  }
  if (!Number.isInteger(max) || max < 1) {
    return { limited: true, retryAfter: 1, reason: 'INVALID_MAX' };
  }
  if (!Number.isFinite(windowMs) || windowMs < 1000) {
    return { limited: true, retryAfter: 1, reason: 'INVALID_WINDOW' };
  }

  const redis = getRedis();

  if (!redis) {
    if (failClosed) {
      return {
        limited: true,
        retryAfter: Math.ceil(windowMs / 1000),
        reason: 'RATE_LIMIT_UNAVAILABLE'
      };
    }
    return { limited: false, retryAfter: 0, reason: 'KV_NOT_CONFIGURED' };
  }

  try {
    const key = `rl:${bucket}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, {
      score: now,
      member: `${now}:${crypto.randomBytes(8).toString('hex')}`
    });
    pipeline.zcard(key);
    pipeline.expire(key, Math.ceil(windowMs / 1000));

    const [, , count] = await pipeline.exec();

    if (count > max) {
      const oldest = await redis.zrange(key, 0, 0, { withScores: true });
      const retryAfter = oldest?.[0]?.score
        ? Math.ceil((oldest[0].score + windowMs - now) / 1000)
        : Math.ceil(windowMs / 1000);
      return {
        limited: true,
        retryAfter: Math.max(retryAfter, 1),
        reason: 'TOO_MANY_REQUESTS'
      };
    }

    return { limited: false, retryAfter: 0 };
  } catch (err) {
    console.warn('[_lib] rate limit falhou:', err.message);
    if (failClosed) {
      return {
        limited: true,
        retryAfter: Math.ceil(windowMs / 1000),
        reason: 'RATE_LIMIT_ERROR'
      };
    }
    return { limited: false, retryAfter: 0, reason: 'KV_ERROR' };
  }
}

async function resetBucket(bucket) {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`rl:${bucket}`);
  } catch (err) {
    console.warn('[_lib] resetBucket falhou:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════
// AUDITORIA — com try/catch externo (nunca quebra o fluxo)
// ═════════════════════════════════════════════════════════════
function resolveAuditTable(event, override) {
  if (override === 'admin') return 'admin_audit';
  if (override === 'auth') return 'auth_audit_log';

  const e = String(event || '').toLowerCase();
  const adminPrefixes = [
    'admin_', 'admin.', 'content.', 'upload',
    'user.plan', 'album.', 'track.', 'plan.', 'payment.', 'sales.'
  ];

  if (adminPrefixes.some(prefix => e.startsWith(prefix))) {
    return 'admin_audit';
  }

  return 'auth_audit_log';
}

function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 32);
}

function buildAuthAuditPayload(event, opts) {
  const { email, userId, ip, userAgent, success, reason } = opts;
  return {
    event: String(event || 'unknown').slice(0, 64),
    email_hash: email ? hashEmail(email) : null,
    user_id: userId || null,
    ip: ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    success: !!success,
    reason: reason ? String(reason).slice(0, 200) : null,
    created_at: new Date().toISOString()
  };
}

function buildAdminAuditPayload(event, opts) {
  const { actor, target, ip, userAgent, success, reason, metadata } = opts;

  const meta = {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    ...(typeof success === 'boolean' ? { success } : {}),
    ...(reason ? { reason: String(reason).slice(0, 200) } : {})
  };

  return {
    action: String(event || 'unknown').slice(0, 64),
    actor: actor ? String(actor).slice(0, 120) : null,
    target: target ? String(target).slice(0, 200) : null,
    metadata: Object.keys(meta).length ? meta : null,
    ip: ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    created_at: new Date().toISOString()
  };
}

async function audit(event, options = {}) {
  try {
    const table = resolveAuditTable(event, options.table);
    const payload = table === 'admin_audit'
      ? buildAdminAuditPayload(event, options)
      : buildAuthAuditPayload(event, options);

    try {
      console.info('[_lib audit]', JSON.stringify({
        table,
        event: payload.event || payload.action,
        success: options.success,
        reason: options.reason
      }));
    } catch {}

    try {
      const { db } = require('./_db');
      const schema = require('../src/schema.js');

      if (table === 'admin_audit') {
        await db.insert(schema.adminAudit).values({
          actor: payload.actor || null,
          action: payload.action,
          target: payload.target || null,
          metadata: payload.metadata || null,
          ip: payload.ip || null,
          userAgent: payload.user_agent || null
        });
      } else {
        await db.insert(schema.authAuditLog).values({
          event: payload.event,
          emailHash: payload.email_hash || null,
          userId: payload.user_id || null,
          ip: payload.ip || null,
          userAgent: payload.user_agent || null,
          success: !!payload.success,
          reason: payload.reason || null
        });
      }
    } catch (err) {
      console.error(`[_lib] audit persist erro (${table}):`, err.code || err.message);
    }
  } catch (err) {
    // ★ Auditoria NUNCA relança — não pode quebrar operação principal
    console.error('[_lib] audit unexpected error:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════
// PLANO EFETIVO — com cache KV
// ═════════════════════════════════════════════════════════════
const PLAN_CACHE_TTL_SEC = 60;

async function getPlanForUserDetailed(userId) {
  if (!userId) {
    return { plan: 'free', degraded: false, reason: 'no_user_id' };
  }

  const cacheKey = `plan:${userId}`;
  const redis = getRedis();

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && VALID_PLANS.has(cached)) {
        return { plan: cached, degraded: false, reason: 'cache_hit' };
      }
    } catch {}
  }

  let plan = 'free';
  let degraded = false;
  let reason = null;

  try {
    const { sql } = require('./_db');
    const rows = await sql`
      SELECT plan
      FROM effective_plan
      WHERE user_id = ${userId}
      LIMIT 1
    `;

    const list = Array.isArray(rows) ? rows : (rows.rows || []);

    if (!list.length) {
      plan = 'free';
      reason = 'no_row';
    } else {
      const candidate = list[0].plan;
      if (VALID_PLANS.has(candidate)) {
        plan = candidate;
        reason = 'ok';
      } else {
        degraded = true;
        reason = 'invalid_plan_value';
      }
    }
  } catch (err) {
    degraded = true;
    reason = err.code || 'query_error';
    console.warn('[_lib] getPlanForUserDetailed query falhou:', reason);
  }

  if (redis && !degraded) {
    try {
      await redis.set(cacheKey, plan, { ex: PLAN_CACHE_TTL_SEC });
    } catch {}
  }

  return { plan, degraded, reason };
}

async function getPlanForUser(userId) {
  const result = await getPlanForUserDetailed(userId);
  return result.plan;
}

async function invalidatePlanCache(userId) {
  if (!userId) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`plan:${userId}`);
  } catch {}
}

// ═════════════════════════════════════════════════════════════
// CSRF — Origin check
// ═════════════════════════════════════════════════════════════
function checkOrigin(req) {
  if (!ALLOWED_ORIGINS.size) {
    console.warn('[_lib] ALLOWED_ORIGINS não configurado. Bloqueando requisições mutantes.');
    return false;
  }

  const rawOrigin = req.headers?.origin;
  if (!rawOrigin) return false;

  const origin = normalizeOrigin(rawOrigin);
  if (!origin) return false;

  return ALLOWED_ORIGINS.has(origin);
}

// ═════════════════════════════════════════════════════════════
// HMAC — sessão admin
// ═════════════════════════════════════════════════════════════
function signHmac(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyHmac(token, secret, maxAgeMs = 4 * 3600 * 1000) {
  if (
    typeof token !== 'string' ||
    typeof secret !== 'string' ||
    !secret ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0
  ) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  if (!body || !sig) return null;

  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const actualBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));

    if (!payload || typeof payload !== 'object' || !Number.isFinite(payload.iat)) {
      return null;
    }

    const now = Date.now();

    if (payload.iat > now + 30_000) return null;
    if (now - payload.iat > maxAgeMs) return null;

    return payload;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// SENHA — scrypt
// ═════════════════════════════════════════════════════════════
function verifyScrypt(password, storedHash) {
  return new Promise((resolve) => {
    try {
      if (typeof password !== 'string' || password.length < 1 || password.length > 200) {
        return resolve(false);
      }
      if (typeof storedHash !== 'string') return resolve(false);

      const parts = storedHash.split('$');
      if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);

      const [, saltHex, hashHex] = parts;

      if (!/^[a-f0-9]{32,128}$/i.test(saltHex)) return resolve(false);
      if (!/^[a-f0-9]{128}$/i.test(hashHex)) return resolve(false);

      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');

      crypto.scrypt(
        password,
        salt,
        expected.length,
        { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (err, derived) => {
          if (err || !derived) return resolve(false);
          try {
            resolve(
              derived.length === expected.length &&
              crypto.timingSafeEqual(derived, expected)
            );
          } catch {
            resolve(false);
          }
        }
      );
    } catch {
      resolve(false);
    }
  });
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ═════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════
module.exports = {
  IS_PROD,
  VALID_PLANS,
  ALLOWED_ORIGINS,

  sendJson,
  methodNotAllowed,
  parseBody,
  parseCookies,
  clientIp,

  setAuthCookies,
  clearAuthCookies,
  getAccessToken,
  getRefreshToken,
  getAuthUser,

  checkAndIncrement,
  resetBucket,

  audit,

  getPlanForUser,
  getPlanForUserDetailed,
  invalidatePlanCache,

  checkOrigin,

  signHmac,
  verifyHmac,

  verifyScrypt,
  timingSafeEq
};