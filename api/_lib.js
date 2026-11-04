/* ============================================================
   api/_lib.js — Módulos internos consolidados
   ------------------------------------------------------------
   CORREÇÕES APLICADAS (Etapa 4 da auditoria):
   1. setAuthCookies: aceita apenas access_token (compatível com auth.js)
   2. getAuthUser: valida algorithm, issuer, audience e UUID
   3. clientIp: prioriza x-real-ip (Render), só confia em x-forwarded-for em dev
   4. resolveAuditTable: reconhece prefixos admin (album., track., etc.)
   5. verifyHmac: rejeita iat no futuro
   6. verifyScrypt: valida formato do hash antes de processar
   ============================================================ */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');

// Guard: impede importação no cliente
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

const ACCESS_MAX_AGE = 60 * 60;              // 1h
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7;    // 7 dias

const VALID_PLANS = new Set(['free', 'premium', 'anual']);

const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ═════════════════════════════════════════════════════════════
// 2. HTTP — helpers
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

// ★ CORREÇÃO P1: prioriza x-real-ip (Render); só confia em x-forwarded-for em dev
function clientIp(req) {
  const h = req.headers || {};

  // x-real-ip é o mais confiável (Render injeta)
  if (h['x-real-ip']) return String(h['x-real-ip']).split(',')[0].trim();

  // x-vercel-forwarded-for só confia se estiver atrás do Vercel
  if (h['x-vercel-forwarded-for']) {
    return String(h['x-vercel-forwarded-for']).split(',')[0].trim();
  }

  // x-forwarded-for só é confiável em desenvolvimento (proxies locais)
  if (!IS_PROD && h['x-forwarded-for']) {
    return String(h['x-forwarded-for']).split(',')[0].trim();
  }

  return String((req.socket && req.socket.remoteAddress) || 'unknown')
    .split(',')[0].trim();
}

// ═════════════════════════════════════════════════════════════
// 4. COOKIES — auth
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

// ★ CORREÇÃO P0: aceita apenas access_token (compatível com auth.js provisório)
function setAuthCookies(res, session) {
  if (!res || !session) {
    throw new Error('Resposta ou sessão inválida.');
  }

  const accessToken = String(session.access_token || '');
  if (!accessToken) {
    throw new Error('Access token ausente.');
  }

  const cookies = [
    buildCookie(AUTH_COOKIE, accessToken, ACCESS_MAX_AGE)
  ];

  // Se refresh_token existir, adiciona ao cookie (compatível com versão futura)
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

// ★ CORREÇÃO P0: valida algorithm, issuer, audience e UUID
async function getAuthUser(req) {
  const accessToken = getAccessToken(req);
  if (!accessToken) return null;

  try {
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret || secret.length < 32) return null;

    const payload = jwt.verify(accessToken, secret, {
      algorithms: ['HS256'],
      issuer: 'josephmatthos',
      audience: 'josephmatthos-platform',
    });

    if (!payload || typeof payload !== 'object' || !UUID_RE.test(String(payload.id || ''))) {
      return null;
    }

    // Verificação leve no banco (sessão de usuário deletado/banido é inválida)
    const { sql } = require('./_db');
    const rows = await sql`SELECT id, role FROM users WHERE id = ${payload.id} LIMIT 1`;
    if (!rows.length) return null;

    return { id: payload.id, email: payload.email || null, role: rows[0].role };
  } catch (error) {
    console.error('[_lib] getAuthUser:', error.code || error.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// 5. RATE LIMIT — KV (Upstash / Vercel KV)
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

async function checkAndIncrement(
  bucket,
  max,
  windowMs = 15 * 60 * 1000,
  options = {}
) {
  const { failClosed = false } = options;

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

    const results = await pipeline.exec();
    const count = Number(results[2]);

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
// 6. AUDITORIA — roteamento entre auth_audit_log e admin_audit
// ═════════════════════════════════════════════════════════════

// ★ CORREÇÃO P1: reconhece prefixos de admin
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

function hashEmail(email) {
  return crypto
    .createHash('sha256')
    .update(String(email).toLowerCase())
    .digest('hex')
    .slice(0, 32);
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
        userAgent: payload.user_agent || payload.userAgent || null
      });
    } else {
      await db.insert(schema.authAuditLog).values({
        event: payload.event,
        emailHash: payload.email_hash || payload.emailHash || null,
        userId: payload.user_id || payload.userId || null,
        ip: payload.ip || null,
        userAgent: payload.user_agent || payload.userAgent || null,
        success: !!payload.success,
        reason: payload.reason || null
      });
    }
  } catch (err) {
    console.error(`[_lib] audit persist erro (${table}):`, err.code || err.message);
  }
}

// ═════════════════════════════════════════════════════════════
// 7. PLANO EFETIVO — com cache KV
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
// 8. CSRF — Origin check
// ═════════════════════════════════════════════════════════════
function checkOrigin(req) {
  const method = (req.method || 'GET').toUpperCase();
  const isMutating = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';

  if (!isMutating) return true;

  if (!ALLOWED_ORIGINS.size) {
    console.warn('[_lib] ALLOWED_ORIGINS não configurado. Bloqueando requisições mutantes.');
    return false;
  }

  const origin = String(req.headers.origin || req.headers.referer || '').trim();
  if (!origin) return false;

  try {
    const url = new URL(origin);
    const originBase = url.origin;

    for (const allowed of ALLOWED_ORIGINS) {
      if (originBase === allowed.replace(/\/+$/, '')) {
        return true;
      }
    }
  } catch (e) {
    return false;
  }

  return false;
}

// ═════════════════════════════════════════════════════════════
// 9. HMAC — sessão admin
// ═════════════════════════════════════════════════════════════
function signHmac(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// ★ CORREÇÃO P1: rejeita iat no futuro
function verifyHmac(token, secret, maxAgeMs = 4 * 3600 * 1000) {
  if (typeof token !== 'string' || !secret || token.length > 4096) return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expected.length !== sig.length) return null;

  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    const now = Date.now();

    if (
      !Number.isSafeInteger(payload.iat) ||
      payload.iat <= 0 ||
      payload.iat > now + 30000 ||  // tolera 30s de clock skew
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
// 10. SENHA — scrypt (nativo do Node)
// ═════════════════════════════════════════════════════════════
function verifyScrypt(password, storedHash) {
  return new Promise((resolve) => {
    try {
      const parts = String(storedHash).split('$');
      if (parts.length !== 3) return resolve(false);

      const [algo, saltHex, hashHex] = parts;

      // ★ CORREÇÃO P1: valida formato do hash antes de processar
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