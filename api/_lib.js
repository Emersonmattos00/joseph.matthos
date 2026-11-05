/* ============================================================
   api/_lib.js — Módulos internos consolidados
   ------------------------------------------------------------
   CORREÇÕES APLICADAS (auditoria _lib 2):
   - getAuthUser: rejeita iat no futuro, exp <= iat,
     exp - iat > ACCESS_MAX_AGE
   - checkAndIncrement: valida max e windowMs
   - setAuthCookies: usa tempo RESTANTE do token
   - verifyHmac: exige segredo >= 32 bytes e maxAgeMs válido
   - verifyHmac: contrato administrativo preservado (type)
   - sanitizeMetadata: recursivo, profundidade limitada,
     tamanho em BYTES
   - hashEmail: HMAC obrigatório em produção
   - normalizeOrigin: exige HTTPS em produção
   - signHmac: rejeita payload.type divergente
   - getPlanForUser: documentado (use Detailed p/ Premium)
   - clientIp: nota de infraestrutura
   ============================================================ */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');

if (typeof window !== 'undefined') {
  throw new Error('[_lib] Este módulo não pode ser importado no cliente.');
}

// ═════════════════════════════════════════════════════════════
// CONSTANTES
// ═════════════════════════════════════════════════════════════
const IS_PROD = process.env.NODE_ENV === 'production';

const AUTH_COOKIE_PROD = '__Host-jm_auth_access';
const REFRESH_COOKIE_PROD = '__Host-jm_auth_refresh';
const AUTH_COOKIE_DEV = 'jm_auth_access';
const REFRESH_COOKIE_DEV = 'jm_auth_refresh';

const AUTH_COOKIE = IS_PROD ? AUTH_COOKIE_PROD : AUTH_COOKIE_DEV;
const REFRESH_COOKIE = IS_PROD ? REFRESH_COOKIE_PROD : REFRESH_COOKIE_DEV;

const ACCESS_MAX_AGE = 60 * 60;              // 1h
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7;    // 7 dias
const ACCESS_CLOCK_SKEW = 30;                // segundos

const VALID_PLANS = new Set(['free', 'premium', 'anual']);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ADMIN_SESSION_TYPE = 'admin_session';

// ═════════════════════════════════════════════════════════════
// ORIGENS
// ═════════════════════════════════════════════════════════════
function normalizeOrigin(value) {
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (IS_PROD && url.protocol !== 'https:') return null;
    return url.origin;
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
// HTTP helpers
// ═════════════════════════════════════════════════════════════
function sendJson(res, status, body) {
  if (res.headersSent) {
    console.warn('[_lib] sendJson após headers enviados');
    return;
  }

  res.status(status);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!res.getHeader('Cache-Control')) {
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, proxy-revalidate'
    );
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

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }

  return body;
}

const MAX_COOKIE_HEADER = 8192;
const MAX_COOKIES = 64;

function parseCookies(header) {
  const out = {};
  if (!header) return out;

  const raw = String(header);
  if (raw.length > MAX_COOKIE_HEADER) {
    console.warn('[_lib] parseCookies: header grande ignorado');
    return out;
  }

  let count = 0;

  raw.split(';').forEach((item) => {
    if (count >= MAX_COOKIES) return;
    const i = item.indexOf('=');
    if (i < 0) return;
    const k = item.slice(0, i).trim();
    const v = item.slice(i + 1).trim();
    if (k && !Object.prototype.hasOwnProperty.call(out, k)) {
      count++;
      try { out[k] = decodeURIComponent(v); }
      catch { out[k] = v; }
    }
  });

  return out;
}

/**
 * clientIp:
 *   1. Vercel: 'x-vercel-forwarded-for' (Vercel sobrescreve)
 *   2. Render: 'x-real-ip' (Render sobrescreve)
 *   3. dev:    'x-forwarded-for'
 *   4. sempre: socket.remoteAddress
 *
 * ⚠️ A confiança depende da infraestrutura sobrescrever o header.
 *    Se a plataforma mudar, revisar esta função.
 */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const firstOf = (v) => String(v || '').split(',')[0].trim();

  if (process.env.VERCEL && h['x-vercel-forwarded-for']) {
    return firstOf(h['x-vercel-forwarded-for']) || 'unknown';
  }

  if (process.env.RENDER && h['x-real-ip']) {
    return firstOf(h['x-real-ip']) || 'unknown';
  }

  if (!IS_PROD && h['x-forwarded-for']) {
    return firstOf(h['x-forwarded-for']) || 'unknown';
  }

  return firstOf((req && req.socket && req.socket.remoteAddress) || 'unknown');
}

// ═════════════════════════════════════════════════════════════
// COOKIES
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

/**
 * setAuthCookies: usa o tempo RESTANTE do token
 * (não a duração original). Se exp já passou, Max-Age=0.
 */
function setAuthCookies(res, session) {
  if (!res || !session) {
    throw new Error('Resposta ou sessão inválida.');
  }

  const accessToken = String(session.access_token || '');
  if (!accessToken) {
    throw new Error('Access token ausente.');
  }

  const now = Math.floor(Date.now() / 1000);
  let accessMaxAge = ACCESS_MAX_AGE;

  if (
    Number.isInteger(session.iat) &&
    Number.isInteger(session.exp) &&
    session.exp > session.iat
  ) {
    const remaining = session.exp - now;
    accessMaxAge = Math.min(Math.max(remaining, 0), ACCESS_MAX_AGE);
  }

  const cookies = [
    buildCookie(AUTH_COOKIE, accessToken, accessMaxAge)
  ];

  const refreshToken = String(session.refresh_token || '');
  if (refreshToken) {
    cookies.push(buildCookie(REFRESH_COOKIE, refreshToken, REFRESH_MAX_AGE));
  }

  appendSetCookie(res, cookies);
}

function clearAuthCookies(res) {
  if (!res) return;
  appendSetCookie(res, [
    buildCookie(AUTH_COOKIE, '', 0),
    buildCookie(REFRESH_COOKIE, '', 0)
  ]);
}

function getAccessToken(req) {
  const cookies = parseCookies(
    req && req.headers && (req.headers.cookie || req.headers.Cookie)
  );
  return cookies[AUTH_COOKIE] || '';
}

function getRefreshToken(req) {
  const cookies = parseCookies(
    req && req.headers && (req.headers.cookie || req.headers.Cookie)
  );
  return cookies[REFRESH_COOKIE] || '';
}

/**
 * getAuthUser:
 * - Retorna null em JWT inválido, expirado, com iat no futuro,
 *   duração acima de ACCESS_MAX_AGE, ou usuário inexistente.
 * - Lança AUTH_DATABASE_UNAVAILABLE quando a consulta ao banco falha.
 *   Chamadores devem tratar como 503, NÃO como 401.
 */
async function getAuthUser(req) {
  const accessToken = getAccessToken(req);
  if (!accessToken) return null;

  const secret = String(process.env.JWT_SECRET || '').trim();
  if (!secret || secret.length < 32) return null;

  let payload;
  try {
    payload = jwt.verify(accessToken, secret, {
      algorithms: ['HS256'],
      issuer: 'josephmatthos',
      audience: 'josephmatthos-platform',
      maxAge: '1h',
      clockTolerance: ACCESS_CLOCK_SKEW
    });
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.tokenType !== 'access' ||      // ← NOVO
      !UUID_RE.test(String(payload.id || '')) ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat <= 0 ||
      payload.iat > now + ACCESS_CLOCK_SKEW ||
      payload.exp <= now ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > ACCESS_MAX_AGE
    ) {
      return null;
    }

  try {
    const { sql } = require('./_db');
    const rows = await sql`SELECT id, role FROM users WHERE id = ${payload.id} LIMIT 1`;
    if (!rows.length) return null;

    return {
      id: payload.id,
      email: payload.email || null,
      role: rows[0].role
    };
  } catch (error) {
    console.error('[_lib] Falha ao consultar usuário autenticado:',
      error.code || error.message);

    const dbError = new Error('Não foi possível validar a sessão.');
    dbError.code = 'AUTH_DATABASE_UNAVAILABLE';
    throw dbError;
  }
}

// ═════════════════════════════════════════════════════════════
// RATE LIMIT
// ═════════════════════════════════════════════════════════════
let _redis = null;
let _redisInitFailed = false;

function getRedis() {
  if (_redis) return _redis;
  if (_redisInitFailed) return null;

  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    _redisInitFailed = true;
    return null;
  }

  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
    return _redis;
  } catch (err) {
    console.warn(
      '[_lib] @upstash/redis não instalado — rate limit desativado.',
      'Execute: npm install @upstash/redis'
    );
    _redisInitFailed = true;
    return null;
  }
}

const RATE_LIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local member = ARGV[4]

local window_start = now - window

redis.call('ZREMRANGEBYSCORE', key, 0, window_start)
redis.call('ZADD', key, now, member)
local count = redis.call('ZCARD', key)
redis.call('EXPIRE', key, math.ceil(window / 1000))

if count > max then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest_score = 0
  if oldest[2] then oldest_score = tonumber(oldest[2]) end
  local retry = math.ceil((oldest_score + window - now) / 1000)
  if retry < 1 then retry = 1 end
  return { 1, count, retry }
end

return { 0, count, 0 }
`;

async function checkAndIncrement(
  bucket,
  max,
  windowMs = 15 * 60 * 1000,
  options = {}
) {
  const { failClosed = false } = options;

  if (!bucket || typeof bucket !== 'string') {
    return { limited: true, retryAfter: 60, reason: 'INVALID_BUCKET' };
  }

  if (
    !Number.isSafeInteger(max) ||
    max < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1000
  ) {
    return {
      limited: true,
      retryAfter: 60,
      reason: 'INVALID_RATE_LIMIT_CONFIG'
    };
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
    const member = `${now}:${crypto.randomBytes(8).toString('hex')}`;

    const result = await redis.eval(
      RATE_LIMIT_LUA,
      [key],
      [String(now), String(windowMs), String(max), member]
    );

    const limitedFlag = Number(Array.isArray(result) ? result[0] : 0);
    const retryAfter = Number(Array.isArray(result) ? result[2] : 0);

    if (limitedFlag === 1) {
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
  if (!bucket || typeof bucket !== 'string') return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`rl:${bucket}`);
  } catch (err) {
    console.warn('[_lib] resetBucket falhou:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════
// AUDITORIA
// ═════════════════════════════════════════════════════════════
function resolveAuditTable(event, override) {
  if (override === 'admin') return 'admin_audit';
  if (override === 'auth') return 'auth_audit_log';

  const e = String(event || '').toLowerCase();

  const adminPrefixes = [
    'admin_', 'admin.',
    'content.', 'upload',
    'user.plan', 'user.',
    'album.', 'track.', 'plan.',
    'rental.', 'subscription.',
    'payment.', 'sales.'
  ];

  if (adminPrefixes.some(prefix => e.startsWith(prefix))) {
    return 'admin_audit';
  }

  return 'auth_audit_log';
}

/**
 * hashEmail: HMAC obrigatório em produção.
 * Em dev, cai para SHA-256 (com aviso).
 */
function hashEmail(email) {
  const secret = String(process.env.AUDIT_HASH_SECRET || '');
  const normalized = String(email).trim().toLowerCase();

  if (Buffer.byteLength(secret, 'utf8') < 32) {
    if (IS_PROD) {
      console.error(
        '[_lib] AUDIT_HASH_SECRET ausente/curto em produção. ' +
        'Auditoria não será persistida com pseudonimização segura.'
      );
      throw new Error('AUDIT_HASH_SECRET mal configurado.');
    }

    return crypto
      .createHash('sha256')
      .update(normalized)
      .digest('hex')
      .slice(0, 32);
  }

  return crypto
    .createHmac('sha256', secret)
    .update(normalized)
    .digest('hex')
    .slice(0, 32);
}

const MAX_AUDIT_METADATA_BYTES = 4096;
const MAX_AUDIT_DEPTH = 5;
const MAX_AUDIT_KEYS = 50;
const MAX_AUDIT_ARRAY = 30;
const MAX_AUDIT_STRING = 1000;

const BLOCKED_AUDIT_KEYS = new Set([
  'password', 'pass',
  'token', 'access_token', 'refresh_token',
  'cookie', 'authorization',
  'secret', 'client_secret',
  'card', 'cvv', 'pan',
  'application_key'
]);

function cleanAuditValue(value, depth = 0) {
  if (depth > MAX_AUDIT_DEPTH) return '[depth_limit]';

  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.slice(0, MAX_AUDIT_STRING);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_AUDIT_ARRAY)
      .map(item => cleanAuditValue(item, depth + 1));
  }

  if (typeof value !== 'object') return undefined;

  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_AUDIT_KEYS)) {
    if (BLOCKED_AUDIT_KEYS.has(key.toLowerCase())) continue;
    const cleaned = cleanAuditValue(item, depth + 1);
    if (cleaned !== undefined) {
      result[key.slice(0, 100)] = cleaned;
    }
  }

  return result;
}

function sanitizeMetadata(metadata) {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata)
  ) {
    return null;
  }

  try {
    const cleaned = cleanAuditValue(metadata);

    if (!cleaned || !Object.keys(cleaned).length) {
      return null;
    }

    const json = JSON.stringify(cleaned);
    if (Buffer.byteLength(json, 'utf8') > MAX_AUDIT_METADATA_BYTES) {
      return { _truncated: true };
    }

    return cleaned;
  } catch {
    return null;
  }
}

function buildAuthAuditPayload(event, opts) {
  const { email, userId, ip, userAgent, success, reason } = opts || {};

  return {
    event: String(event || 'unknown').slice(0, 64),
    email_hash: email ? hashEmail(email) : null,
    user_id: userId && UUID_RE.test(String(userId)) ? userId : null,
    ip: ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    success: !!success,
    reason: reason ? String(reason).slice(0, 200) : null,
    created_at: new Date().toISOString()
  };
}

function buildAdminAuditPayload(event, opts) {
  const { actor, target, ip, userAgent, success, reason, metadata } = opts || {};

  const meta = sanitizeMetadata(metadata) || {};

  if (typeof success === 'boolean') meta.success = success;
  if (reason) meta.reason = String(reason).slice(0, 200);

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
  const table = resolveAuditTable(event, options.table);

  let payload;
  try {
    payload = table === 'admin_audit'
      ? buildAdminAuditPayload(event, options)
      : buildAuthAuditPayload(event, options);
  } catch (err) {
    console.error('[_lib] audit payload falhou:', err.code || err.message);
    return;
  }

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
}

// ═════════════════════════════════════════════════════════════
// PLANO EFETIVO
// ═════════════════════════════════════════════════════════════
const PLAN_CACHE_TTL_SEC = 60;

async function getPlanForUserDetailed(userId) {
  if (!userId || !UUID_RE.test(String(userId))) {
    return { plan: 'free', degraded: false, reason: 'invalid_user_id' };
  }

  const cacheKey = `plan:${userId}`;
  const redis = getRedis();

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && VALID_PLANS.has(cached)) {
        return { plan: cached, degraded: false, reason: 'cache_hit' };
      }
    } catch { /* cache miss */ }
  }

  let plan = 'free';
  let degraded = false;
  let reason = null;

  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`
      SELECT plan
      FROM effective_plan
      WHERE user_id = ${userId}
      LIMIT 1
    `;

    if (!Array.isArray(rows) || rows.length === 0) {
      plan = 'free';
      reason = 'no_row';
    } else {
      const candidate = rows[0].plan;
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
    } catch { /* KV off */ }
  }

  return { plan, degraded, reason };
}

/**
 * getPlanForUser: retorna apenas a string do plano.
 * ⚠️ Em falha de banco retorna 'free' (degraded=true).
 *    Para decisões de acesso Premium use getPlanForUserDetailed()
 *    e trate `degraded` como 503 no endpoint.
 */
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
// CSRF — Origin
// ═════════════════════════════════════════════════════════════
function checkOrigin(req) {
  const method = String(req?.method || 'GET').toUpperCase();

  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    return true;
  }

  if (!ALLOWED_ORIGINS.size) {
    console.warn('[_lib] ALLOWED_ORIGINS não configurado. Bloqueando mutações.');
    return false;
  }

  const originHeader = req?.headers?.origin;

  if (originHeader) {
    const origin = normalizeOrigin(originHeader);
    return !!origin && ALLOWED_ORIGINS.has(origin);
  }

  const refererHeader = req?.headers?.referer;
  if (!refererHeader) return false;

  const refererOrigin = normalizeOrigin(refererHeader);
  return !!refererOrigin && ALLOWED_ORIGINS.has(refererOrigin);
}

// ═════════════════════════════════════════════════════════════
// HMAC — sessão admin
// ═════════════════════════════════════════════════════════════
function signHmac(payload, secret) {
  if (!secret || typeof secret !== 'string' || secret.length < 32) {
    throw new Error('[_lib] segredo HMAC fraco.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('[_lib] payload HMAC inválido.');
  }

  if (payload.type && payload.type !== ADMIN_SESSION_TYPE) {
    throw new Error('[_lib] payload HMAC com finalidade divergente.');
  }

  const body = Buffer.from(
    JSON.stringify({ ...payload, type: ADMIN_SESSION_TYPE })
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');

  return `${body}.${sig}`;
}

function verifyHmac(token, secret, maxAgeMs = 4 * 3600 * 1000) {
  if (
    typeof token !== 'string' ||
    typeof secret !== 'string' ||
    Buffer.byteLength(secret, 'utf8') < 32 ||
    token.length > 4096
  ) {
    return null;
  }

  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');

  if (expected.length !== sig.length) return null;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const now = Date.now();

    if (
      !payload ||
      typeof payload !== 'object' ||
      payload.type !== ADMIN_SESSION_TYPE ||
      !Number.isSafeInteger(payload.iat) ||
      payload.iat <= 0 ||
      payload.iat > now + 30000 ||
      now - payload.iat > maxAgeMs
    ) {
      return null;
    }

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