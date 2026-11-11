'use strict';

/* ============================================================
   api/_lib.js — Módulos internos consolidados (v10 — FINAL)
   ------------------------------------------------------------
   - getAuthUser valida sv (session_version) e sid (sessão ativa)
   - hashEmail falha em produção sem AUDIT_HASH_SECRET
   - checkOrigin aceita requests same-origin sem Origin/Referer
     (proteção CSRF via SameSite=Lax/Strict nos cookies)
   ============================================================ */

const crypto = require('crypto');
const { isIP } = require('node:net');
const jwt = require('jsonwebtoken');

if (typeof window !== 'undefined') {
  throw new Error('[_lib] Este módulo não pode ser importado no cliente.');
}

const IS_PROD = process.env.NODE_ENV === 'production';

// ─── JWT ────────────────────────────────────────────────────
const JWT_ISSUER = 'josephmatthos';
const JWT_AUDIENCE = 'josephmatthos-platform';
const ACCESS_TTL_SECONDS = 15 * 60;
const ACCESS_TTL = '15m';
const CLOCK_TOLERANCE_SEC = 5;

// ─── Cookies ────────────────────────────────────────────────
const AUTH_COOKIE = IS_PROD && process.env.ALLOW_INSECURE_COOKIE !== 'true'
  ? '__Host-jm_auth_access'
  : 'jm_auth_access';

const REFRESH_COOKIE = IS_PROD && process.env.ALLOW_INSECURE_COOKIE !== 'true'
  ? '__Secure-jm_auth_refresh'
  : 'jm_auth_refresh';

const AUTH_COOKIE_PATH = '/';
const REFRESH_COOKIE_PATH = '/api/auth';

const ACCESS_MAX_AGE = ACCESS_TTL_SECONDS;
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

const VALID_PLANS = new Set(['free', 'premium', 'anual']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AUDIT_BLOCKED_FIELDS = new Set([
  'password', 'pass', 'senha', 'password_hash', 'current_password', 'new_password',
  'token', 'access_token', 'refresh_token', 'jwt',
  'secret', 'client_secret', 'private_key',
  'authorization', 'cookie',
  'apikey', 'api_key', 'api-key',
  'passwordhash', 'refreshtoken', 'accesstoken', 'jwttoken',
]);

const AUDIT_MAX_METADATA_KEYS = 30;

const AUDIT_BLOCKED_NORMALIZED = new Set(
  [...AUDIT_BLOCKED_FIELDS].map(f => f.replace(/[_-]/g, '').toLowerCase())
);

const VALID_REASON_CODES = new Set([
  'ok', 'success',
  'invalid', 'invalid_input', 'invalid_credentials', 'invalid_password_length',
  'invalid_track_id', 'invalid_album_id', 'invalid_query',
  'rate_limited', 'rate_limit_unavailable', 'rate_limit_error',
  'email_exists', 'user_not_found', 'plan_not_found', 'artist_not_found',
  'album_not_found', 'track_not_found', 'not_found',
  'version_conflict', 'slug_conflict',
  'query_error', 'database_error', 'internal_error',
  'no_user_id', 'invalid_user_id', 'no_row', 'invalid_plan_value',
  'token_expired', 'token_invalid', 'session_invalid',
  'upload_failed', 'storage_error', 'not_configured',
  'forbidden', 'unauthorized', 'origin_not_allowed',
  'idempotent_replay', 'payment_failed', 'payment_pending',
  'refresh_race', 'refresh_expired', 'jwt_secret_invalid',
  'signup_ok', 'login_ok', 'refresh_ok', 'logout_ok',
  'mp_not_configured', 'value_mismatch', 'currency_mismatch',
  'order_not_found', 'product_not_found', 'rental_duplicate',
  'gateway_unavailable', 'preapproval_failed',
  'session_version_mismatch'
]);

function normalizeReason(reason) {
  if (!reason) return null;
  const code = String(reason).toLowerCase().trim().slice(0, 64);
  if (VALID_REASON_CODES.has(code)) return code;
  return 'other';
}

function normalizeOrigin(value) {
  try {
    const origin = new URL(String(value).trim()).origin;
    if (IS_PROD && !origin.startsWith('https://')) {
      console.warn('[_lib] ALLOWED_ORIGINS em produção deve usar HTTPS:', origin);
      return null;
    }
    return origin;
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

if (IS_PROD && ALLOWED_ORIGINS.size === 0) {
  console.error('[_lib] ALLOWED_ORIGINS não configurado em produção — CSRF bloqueará tudo.');
}

// ─── HTTP helpers ──────────────────────────────────────────
function sendJson(res, status, body) {
  if (res.headersSent) return;
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
  const body = req?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

const MAX_COOKIE_HEADER_LEN = 16 * 1024;
const MAX_COOKIE_COUNT = 32;
const AUTH_COOKIE_NAMES = new Set([AUTH_COOKIE, REFRESH_COOKIE]);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const raw = String(header);
  if (raw.length > MAX_COOKIE_HEADER_LEN) return out;
  let count = 0;
  let authDuplicate = false;
  raw.split(';').forEach((item) => {
    if (count >= MAX_COOKIE_COUNT) return;
    const i = item.indexOf('=');
    if (i < 0) return;
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (!k) return;

    if (AUTH_COOKIE_NAMES.has(k) && Object.prototype.hasOwnProperty.call(out, k)) {
      console.warn('[_lib] cookie de autenticação duplicado:', k);
      authDuplicate = true;
      return;
    }
    count++;
    try { out[k] = decodeURIComponent(v); }
    catch { out[k] = v; }
  });

  if (authDuplicate) {
    delete out[AUTH_COOKIE];
    delete out[REFRESH_COOKIE];
  }
  return out;
}

function clientIp(req) {
  if (!req || typeof req !== 'object') return '';
  const headers = req.headers || {};

  const trustedProxyHeader = headers['x-real-ip'] || headers['x-vercel-forwarded-for'];
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

// ─── Cookies ───────────────────────────────────────────────
const SAFE_COOKIE_PATHS = new Set(['/', '/api/auth']);
const SAFE_SAME_SITE = new Set(['Lax', 'Strict', 'None']);

function buildCookie(name, value, maxAge, opts = {}) {
  const safeMaxAge = Math.max(0, Number(maxAge) || 0);
  const encoded = value ? encodeURIComponent(value) : '';

  const path = SAFE_COOKIE_PATHS.has(opts.path) ? opts.path : '/';
  const sameSite = SAFE_SAME_SITE.has(opts.sameSite) ? opts.sameSite : 'Lax';

  const parts = [
    name + '=' + encoded,
    'Max-Age=' + safeMaxAge,
    'Path=' + path,
    'HttpOnly',
    'SameSite=' + sameSite,
  ];

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_INSECURE_COOKIE !== 'true') {
    parts.push('Secure');
  }

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
  if (!res || !session) throw new Error('Sessão inválida.');
  const accessToken = String(session.access_token || '');
  const refreshToken = String(session.refresh_token || '');
  if (!accessToken) throw new Error('Token de acesso ausente.');

  const list = [
    buildCookie(AUTH_COOKIE, accessToken, ACCESS_MAX_AGE, {
      path: AUTH_COOKIE_PATH,
      sameSite: 'Lax',
    }),
  ];
  if (refreshToken) {
    list.push(buildCookie(REFRESH_COOKIE, refreshToken, REFRESH_MAX_AGE, {
      path: REFRESH_COOKIE_PATH,
      sameSite: 'Strict',
    }));
  } else {
    list.push(buildCookie(REFRESH_COOKIE, '', 0, {
      path: REFRESH_COOKIE_PATH,
      sameSite: 'Strict',
    }));
  }
  appendSetCookie(res, list);
}

function clearAuthCookies(res) {
  if (!res) return;
  appendSetCookie(res, [
    buildCookie(AUTH_COOKIE, '', 0, { path: AUTH_COOKIE_PATH, sameSite: 'Lax' }),
    buildCookie(REFRESH_COOKIE, '', 0, { path: REFRESH_COOKIE_PATH, sameSite: 'Strict' }),
  ]);
}

function getAccessToken(req) {
  return parseCookies(req?.headers?.cookie || req?.headers?.Cookie)[AUTH_COOKIE] || '';
}

function getRefreshToken(req) {
  return parseCookies(req?.headers?.cookie || req?.headers?.Cookie)[REFRESH_COOKIE] || '';
}

// ─── getAuthUser com validação de sv + sid ─────────────────
async function getAuthUser(req) {
  const accessToken = getAccessToken(req);
  if (!accessToken) return null;

  const secret = String(process.env.JWT_SECRET || '').trim();
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    console.error('[_lib] JWT_SECRET ausente ou muito curto.');
    return null;
  }

  let payload;
  try {
    payload = jwt.verify(accessToken, secret, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      clockTolerance: CLOCK_TOLERANCE_SEC,
      ignoreExpiration: false,
    });
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

  const now = Math.floor(Date.now() / 1000);
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.id !== 'string' ||
    !UUID_RE.test(payload.id) ||
    !Number.isFinite(payload.exp) ||
    !Number.isFinite(payload.iat) ||
    payload.exp <= payload.iat ||
    payload.iat > now + CLOCK_TOLERANCE_SEC ||
    now - payload.iat > ACCESS_TTL_SECONDS + CLOCK_TOLERANCE_SEC ||
    payload.exp - payload.iat > ACCESS_TTL_SECONDS + CLOCK_TOLERANCE_SEC ||
    typeof payload.sv !== 'number' ||
    typeof payload.sid !== 'string' ||
    !UUID_RE.test(payload.sid)
  ) {
    return null;
  }

  try {
    const { db } = require('./_db');
    const { users, refreshTokens } = require('../src/schema.js');
    const { eq, and, isNull, gt } = require('drizzle-orm');

    const [dbUser] = await db.select({
      id: users.id,
      email: users.email,
      role: users.role,
      sessionVersion: users.sessionVersion,
    }).from(users).where(eq(users.id, payload.id)).limit(1);

    if (!dbUser) return null;
    if (Number(dbUser.sessionVersion) !== payload.sv) return null;

    const nowIso = new Date().toISOString();
    const [activeSession] = await db.select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(
        eq(refreshTokens.userId, payload.id),
        eq(refreshTokens.sessionId, payload.sid),
        isNull(refreshTokens.revokedAt),
        gt(refreshTokens.expiresAt, nowIso)
      ))
      .limit(1);

    if (!activeSession) return null;

    return {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
    };
  } catch (err) {
    const code = String(err.code || '');
    const networkCodes = new Set([
      'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET',
      'EHOSTUNREACH', 'EPIPE', 'EAI_AGAIN',
      '57P01', '57P02', '57P03', '53300',
    ]);
    if (networkCodes.has(code) || /^08[0-9A-Z]{3}$/i.test(code)) {
      const dbErr = new Error('DB_UNAVAILABLE');
      dbErr.code = 'DB_UNAVAILABLE';
      throw dbErr;
    }
    console.error('[_lib] getAuthUser consulta falhou:', code || err.message);
    return null;
  }
}

// ─── Rate limit ───────────────────────────────────────────
let _redis = null;
let _redisInitFailed = false;

function getRedis() {
  if (_redis) return _redis;
  if (_redisInitFailed) return null;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    if (IS_PROD) console.error('[_lib] Redis não configurado em produção — operações protegidas vão falhar.');
    _redisInitFailed = true;
    return null;
  }
  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    return _redis;
  } catch (err) {
    console.error('[_lib] @upstash/redis não instalado — operações protegidas vão falhar.');
    _redisInitFailed = true;
    return null;
  }
}

async function checkAndIncrement(bucket, max, windowMs = 15 * 60 * 1000, options = {}) {
  const failClosed =
    options && typeof options === 'object'
      ? options.failClosed !== false
      : true;

  if (typeof bucket !== 'string' || !bucket.trim() || bucket.length > 200) {
    return { limited: true, retryAfterMs: 1000, reason: 'invalid_input' };
  }
  if (!Number.isInteger(max) || max < 1) {
    return { limited: true, retryAfterMs: 1000, reason: 'internal_error' };
  }
  if (!Number.isFinite(windowMs) || windowMs < 1000) {
    return { limited: true, retryAfterMs: 1000, reason: 'internal_error' };
  }

  const redis = getRedis();
  if (!redis) {
    if (failClosed) {
      return { limited: true, retryAfterMs: windowMs, reason: 'rate_limit_unavailable' };
    }
    return { limited: false, retryAfterMs: 0, reason: 'rate_limit_unavailable' };
  }

  try {
    const key = `rl:${bucket}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    const multi = redis.multi();
    multi.zremrangebyscore(key, 0, windowStart);
    multi.zadd(key, { score: now, member: `${now}:${crypto.randomBytes(8).toString('hex')}` });
    multi.zcard(key);
    multi.expire(key, Math.ceil(windowMs / 1000));

    const result = await multi.exec();
    if (!Array.isArray(result) || result.length < 3) {
      throw new Error('Resposta inválida do Redis.');
    }

    const count = Number(result[2]);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Contagem inválida do rate limit.');
    }

    if (count > max) {
      const oldest = await redis.zrange(key, 0, 0, { withScores: true });
      let retryAfterMs = windowMs;
      if (Array.isArray(oldest) && oldest[0]) {
        const scoreRaw = Array.isArray(oldest[0]) ? oldest[0][1] : oldest[0].score;
        const score = Number(scoreRaw);
        if (Number.isFinite(score) && score > 0) {
          retryAfterMs = Math.max(score + windowMs - now, 1000);
        }
      }
      return { limited: true, retryAfterMs, reason: 'rate_limited' };
    }
    return { limited: false, retryAfterMs: 0, reason: null };
  } catch (err) {
    console.warn('[_lib] rate limit falhou:', err.message);
    if (failClosed) {
      return { limited: true, retryAfterMs: windowMs, reason: 'rate_limit_error' };
    }
    return { limited: false, retryAfterMs: 0, reason: 'rate_limit_error' };
  }
}

async function resetBucket(bucket) {
  if (typeof bucket !== 'string' || !bucket.trim() || bucket.length > 200) return;
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(`rl:${bucket}`); }
  catch (err) { console.warn('[_lib] resetBucket falhou:', err.message); }
}

const RATE_LIMIT_HASH_SECRET = () => {
  const s = String(process.env.RATE_LIMIT_HASH_SECRET || '').trim();
  if (s.length >= 32) return s;
  const j = String(process.env.JWT_SECRET || '').trim();
  if (j.length >= 32) return `rl:${j}`;
  return null;
};

function hashRateLimitKey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('Identificador de rate limit inválido.');
  }

  const normalized = value.trim().toLowerCase();
  const secret = RATE_LIMIT_HASH_SECRET();

  if (!secret) {
    if (IS_PROD) {
      throw new Error('[_lib] RATE_LIMIT_HASH_SECRET/JWT_SECRET ausente em produção.');
    }
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  }

  return crypto.createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 32);
}

// ─── Auditoria ────────────────────────────────────────────
const AUDIT_HASH_SECRET = () => {
  const s = String(process.env.AUDIT_HASH_SECRET || '').trim();
  if (s.length < 32) return null;
  return s;
};

function resolveAuditTable(event, override) {
  if (override === 'admin') return 'admin_audit';
  if (override === 'auth') return 'auth_audit_log';
  const e = String(event || '').toLowerCase();
  const adminPrefixes = ['admin_', 'admin.', 'content.', 'upload', 'user.plan', 'album.', 'track.', 'plan.', 'payment.', 'sales.'];
  if (adminPrefixes.some(prefix => e.startsWith(prefix))) return 'admin_audit';
  return 'auth_audit_log';
}

function hashEmail(email) {
  const value = String(email).toLowerCase();
  const secret = AUDIT_HASH_SECRET();
  if (!secret) {
    if (IS_PROD) {
      throw new Error('[_lib] AUDIT_HASH_SECRET ausente em produção.');
    }
    console.warn('[_lib] AUDIT_HASH_SECRET ausente em dev — usando SHA-256.');
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
  }
  return crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

function isBlockedAuditKey(key) {
  const norm = String(key).toLowerCase().replace(/[_-]/g, '');
  return AUDIT_BLOCKED_NORMALIZED.has(norm);
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const clean = Object.create(null);
  let count = 0;
  for (const [k, v] of Object.entries(metadata)) {
    if (count >= AUDIT_MAX_METADATA_KEYS) break;
    if (isBlockedAuditKey(k)) continue;
    if (v === null || v === undefined) continue;

    const key = String(k).slice(0, 64);
    if (typeof v === 'string') clean[key] = v.slice(0, 500);
    else if (typeof v === 'number' && Number.isFinite(v)) clean[key] = v;
    else if (typeof v === 'boolean') clean[key] = v;
    else if (typeof v === 'object') clean[key] = '[object]';
    count++;
  }
  return count > 0 ? clean : null;
}

function buildAuthAuditPayload(event, opts) {
  const { email, userId, ip, userAgent, success, reason } = opts;
  return {
    event: String(event || 'unknown').slice(0, 64),
    email_hash: email ? hashEmail(email) : null,
    user_id: userId && UUID_RE.test(String(userId)) ? String(userId) : null,
    ip: ip && isIP(ip) ? ip : null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    success: !!success,
    reason: normalizeReason(reason),
    created_at: new Date().toISOString(),
  };
}

function buildAdminAuditPayload(event, opts) {
  const { actor, target, ip, userAgent, success, reason, metadata } = opts;
  const meta = {
    ...(sanitizeMetadata(metadata) || {}),
    ...(typeof success === 'boolean' ? { success } : {}),
  };
  const code = normalizeReason(reason);
  if (code) meta.reason = code;

  return {
    action: String(event || 'unknown').slice(0, 64),
    actor: actor ? String(actor).slice(0, 120) : null,
    target: target ? String(target).slice(0, 200) : null,
    metadata: Object.keys(meta).length ? meta : null,
    ip: ip && isIP(ip) ? ip : null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    created_at: new Date().toISOString(),
  };
}

async function audit(event, options = {}) {
  try {
    const table = resolveAuditTable(event, options.table);
    const opts = { ...options };
    if (
      typeof opts.success !== 'boolean' &&
      /\.(success|ok)$|_ok$|\.signup$|\.login\.success$/.test(String(event))
    ) {
      opts.success = true;
    }
    const payload = table === 'admin_audit'
      ? buildAdminAuditPayload(event, opts)
      : buildAuthAuditPayload(event, opts);

    try {
      console.info('[_lib audit]', JSON.stringify({
        table,
        event: payload.event || payload.action,
        success: opts.success,
        reason: normalizeReason(opts.reason),
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
          userAgent: payload.user_agent || null,
        });
      } else {
        await db.insert(schema.authAuditLog).values({
          event: payload.event,
          emailHash: payload.email_hash || null,
          userId: payload.user_id || null,
          ip: payload.ip || null,
          userAgent: payload.user_agent || null,
          success: !!payload.success,
          reason: payload.reason || null,
        });
      }
    } catch (err) {
      console.error(`[_lib] audit persist erro (${table}):`, err.code || err.message);
    }
  } catch (err) {
    console.error('[_lib] audit unexpected error:', err.message);
  }
}

// ─── Plano efetivo ────────────────────────────────────────
const PLAN_CACHE_TTL_SEC = 60;

function resolveDbSql() {
  try {
    const dbMod = require('./_db');
    if (typeof dbMod.sql === 'function') return dbMod.sql;
    if (typeof dbMod.sqlNeon === 'function') return dbMod.sqlNeon;
    if (typeof dbMod.default === 'function') return dbMod.default;
    return null;
  } catch {
    return null;
  }
}

async function getPlanForUserDetailed(userId) {
  if (!userId) {
    return { plan: 'free', degraded: true, reason: 'no_user_id' };
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    return { plan: 'free', degraded: true, reason: 'invalid_user_id' };
  }

  const cacheKey = `plan:${userId}`;
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && VALID_PLANS.has(cached)) {
        return { plan: cached, degraded: false, reason: 'ok' };
      }
    } catch {}
  }

  let plan = 'free';
  let degraded = false;
  let reason = 'ok';
  try {
    const sql = resolveDbSql();
    if (!sql) throw new Error('DB_SQL_UNAVAILABLE');
    const rows = await sql`SELECT plan FROM effective_plan WHERE user_id = ${userId} LIMIT 1`;
    const list = Array.isArray(rows) ? rows : (rows?.rows || []);
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
    reason = 'query_error';
    console.warn('[_lib] getPlanForUserDetailed query falhou:', err.message);
  }

  if (redis && !degraded) {
    try { await redis.set(cacheKey, plan, { ex: PLAN_CACHE_TTL_SEC }); } catch {}
  }
  return { plan, degraded, reason };
}

/** NUNCA use para autorizar compras/assinaturas. Use getPlanForUserDetailed. */
async function getPlanForUser(userId) {
  const result = await getPlanForUserDetailed(userId);
  return result.plan;
}

async function invalidatePlanCache(userId) {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) return;
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(`plan:${userId}`); } catch {}
}

// ─── CSRF (aceita same-origin sem Origin/Referer) ─────────
function checkOrigin(req) {
  if (!ALLOWED_ORIGINS.size) {
    console.warn('[_lib] ALLOWED_ORIGINS não configurado. Bloqueando requisições mutantes.');
    return false;
  }

  const rawOrigin = req.headers?.origin;
  const referer = req.headers?.referer;

  // 1) Origin presente → precisa estar em ALLOWED_ORIGINS
  if (rawOrigin) {
    const origin = normalizeOrigin(rawOrigin);
    if (!origin) return false;
    return ALLOWED_ORIGINS.has(origin);
  }

  // 2) Referer presente → precisa bater com ALLOWED_ORIGINS
  if (referer) {
    try {
      const refOrigin = new URL(String(referer).trim()).origin;
      if (ALLOWED_ORIGINS.has(refOrigin)) return true;
    } catch {}
    return false;
  }

  // 3) Origin e Referer ausentes = request same-origin do navegador
  // (o navegador só envia Origin em cross-origin).
  // CSRF permanece protegido por SameSite=Lax/Strict nos cookies.
  return true;
}

function validatedOrigin(req) {
  if (!req || typeof req !== 'object') return null;
  const raw = req.headers?.origin;
  if (!raw) return null;
  const origin = normalizeOrigin(raw);
  if (!origin) return null;
  return ALLOWED_ORIGINS.has(origin) ? origin : null;
}

// ─── HMAC ─────────────────────────────────────────────────
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

function signHmac(payload, secret) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('Segredo HMAC inválido.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Payload HMAC inválido.');
  }
  if (!Number.isFinite(payload.iat) || payload.iat <= 0) {
    throw new Error('Payload HMAC deve ter iat numérico positivo (ms).');
  }

  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyHmac(token, secret, maxAgeMs = 4 * 3600 * 1000) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  if (typeof secret !== 'string' || secret.length < 16) return null;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  if (!BASE64URL_RE.test(body) || !BASE64URL_RE.test(sig)) return null;

  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const actualBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !Number.isFinite(payload.iat) ||
      payload.iat <= 0
    ) return null;

    const now = Date.now();
    if (payload.iat > now + 30_000) return null;
    if (now - payload.iat > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Senha ────────────────────────────────────────────────
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function verifyScrypt(password, storedHash) {
  return new Promise((resolve) => {
    try {
      if (typeof password !== 'string' || password.length < 1 || password.length > 200) return resolve(false);
      if (typeof storedHash !== 'string') return resolve(false);
      const parts = storedHash.split('$');
      if (parts.length !== 3 || parts[0] !== 'scrypt') return resolve(false);
      const [, saltHex, hashHex] = parts;
      if (!/^[a-f0-9]{32,128}$/i.test(saltHex)) return resolve(false);
      if (!/^[a-f0-9]{128}$/i.test(hashHex)) return resolve(false);
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      crypto.scrypt(password, salt, expected.length, SCRYPT_OPTS, (err, derived) => {
        if (err || !derived) return resolve(false);
        try {
          resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
        } catch { resolve(false); }
      });
    } catch { resolve(false); }
  });
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ─── Exports ──────────────────────────────────────────────
module.exports = {
  IS_PROD, VALID_PLANS, ALLOWED_ORIGINS,
  JWT_ISSUER, JWT_AUDIENCE, ACCESS_TTL, ACCESS_TTL_SECONDS,
  sendJson, methodNotAllowed, parseBody, parseCookies, clientIp,
  setAuthCookies, clearAuthCookies, getAccessToken, getRefreshToken, getAuthUser,
  AUTH_COOKIE, REFRESH_COOKIE, AUTH_COOKIE_PATH, REFRESH_COOKIE_PATH,
  ACCESS_MAX_AGE, REFRESH_MAX_AGE,
  checkAndIncrement, resetBucket, hashRateLimitKey,
  audit,
  getPlanForUser, getPlanForUserDetailed, invalidatePlanCache,
  checkOrigin, validatedOrigin,
  signHmac, verifyHmac,
  verifyScrypt, timingSafeEq,
};