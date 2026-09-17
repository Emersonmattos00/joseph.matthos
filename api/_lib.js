/* ============================================================
   api/_lib.js — Módulos internos consolidados
   ------------------------------------------------------------
   Substitui: _supabase.js, _audit.js, _rate-limit.js,
              _plan.js, _csrf-guard.js

   ⚠️  NUNCA importar no cliente. Só serverless functions.
   ============================================================ */

'use strict';

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// Guard: impede importação no cliente
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  throw new Error('[_lib] Este módulo não pode ser importado no cliente.');
}

// ═════════════════════════════════════════════════════════════
// CONSTANTES GLOBAIS
// ═════════════════════════════════════════════════════════════
const FETCH_TIMEOUT = 10000;

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

// ═════════════════════════════════════════════════════════════
// 1. CONFIGURAÇÃO
// ═════════════════════════════════════════════════════════════
function getConfig() {
  const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

  if (!url || !anonKey) {
    const err = new Error('Supabase não configurado.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  return { url, anonKey };
}

function getAdminKey() {
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!key) {
    const err = new Error('SUPABASE_SERVICE_ROLE_KEY ausente.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return key;
}

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

  // Só define no-store se ninguém definiu Cache-Control antes
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

function clientIp(req) {
  const h = req.headers || {};
  const fwd =
    h['x-vercel-forwarded-for'] ||
    h['x-real-ip'] ||
    h['x-forwarded-for'];
  return String(fwd || (req.socket && req.socket.remoteAddress) || 'unknown')
    .split(',')[0].trim();
}

// ═════════════════════════════════════════════════════════════
// 3. SUPABASE — fetch base
// ═════════════════════════════════════════════════════════════
async function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = FETCH_TIMEOUT, signal: extSignal, ...rest } = options;
  const controller = new AbortController();

  if (extSignal) {
    if (extSignal.aborted) controller.abort();
    else extSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const err = new Error('Timeout ao contactar Supabase.');
      err.code = 'TIMEOUT';
      throw err;
    }
    const err = new Error('Falha de rede ao contactar Supabase.');
    err.code = 'NETWORK_ERROR';
    err.cause = error;
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function supabaseFetch(path, options = {}, key, useBearer = false) {
  const { url } = getConfig();

  if (!path || typeof path !== 'string') {
    throw new Error('Caminho inválido para Supabase.');
  }

  const headers = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(useBearer ? { Authorization: 'Bearer ' + key } : {}),
    ...(options.headers || {})
  };

  const response = await fetchWithTimeout(url + path, { ...options, headers });

  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; }
  catch { body = text || null; }

  return { response, body };
}

function supabaseRequest(path, options = {}) {
  const { anonKey } = getConfig();
  return supabaseFetch(path, options, anonKey, false);
}

function supabaseAdminRequest(path, options = {}) {
  const adminKey = getAdminKey();
  return supabaseFetch(path, options, adminKey, true);
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

function setAuthCookies(res, session) {
  if (!res || !session) return;

  const accessToken = String(session.access_token || '');
  const refreshToken = String(session.refresh_token || '');

  if (!accessToken || !refreshToken) {
    throw new Error('Sessão inválida: tokens ausentes.');
  }

  appendSetCookie(res, [
    buildCookie(AUTH_COOKIE, accessToken, ACCESS_MAX_AGE),
    buildCookie(REFRESH_COOKIE, refreshToken, REFRESH_MAX_AGE)
  ]);
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

async function getAuthUser(req) {
  const accessToken = getAccessToken(req);
  if (!accessToken) return null;

  try {
    const result = await supabaseRequest('/auth/v1/user', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken }
    });

    if (!result.response.ok || !result.body || !result.body.id) return null;
    return result.body;
  } catch (error) {
    console.error('[_lib] getAuthUser:', error.code || error.message);
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// 5. RATE LIMIT — KV (Upstash / Vercel KV)
// ═════════════════════════════════════════════════════════════
let _redis = null;

function getRedis() {
  if (_redis) return _redis;

  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    const err = new Error('KV não configurado.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  // Import dinâmico evita erro quando o pacote não está instalado em dev
  try {
    const { Redis } = require('@upstash/redis');
    _redis = new Redis({ url, token });
  } catch {
    const err = new Error('@upstash/redis não instalado.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  return _redis;
}

async function checkAndIncrement(bucket, max, windowMs = 15 * 60 * 1000) {
  try {
    const redis = getRedis();
    const key = `rl:${bucket}`;
    const now = Date.now();
    const windowStart = now - windowMs;

    const pipeline = redis.pipeline();
    pipeline.zremrangebyscore(key, 0, windowStart);
    pipeline.zadd(key, { score: now, member: `${now}:${Math.random()}` });
    pipeline.zcard(key);
    pipeline.expire(key, Math.ceil(windowMs / 1000));

    const [, , count] = await pipeline.exec();

    if (count > max) {
      const oldest = await redis.zrange(key, 0, 0, { withScores: true });
      const retryAfter = oldest?.[0]?.score
        ? Math.ceil((oldest[0].score + windowMs - now) / 1000)
        : Math.ceil(windowMs / 1000);
      return { limited: true, retryAfter: Math.max(retryAfter, 1) };
    }

    return { limited: false, retryAfter: 0 };
  } catch (err) {
    // KV indisponível → fail-open (não bloqueia o usuário)
    console.warn('[_lib] rate limit falhou, permitindo:', err.message);
    return { limited: false, retryAfter: 0 };
  }
}

async function resetBucket(bucket) {
  try {
    const redis = getRedis();
    await redis.del(`rl:${bucket}`);
  } catch (err) {
    console.warn('[_lib] resetBucket falhou:', err.message);
  }
}

// ═════════════════════════════════════════════════════════════
// 6. AUDITORIA
// ═════════════════════════════════════════════════════════════
async function audit(event, options = {}) {
  const {
    email,
    userId,
    ip,
    userAgent,
    success,
    reason,
    actor,
    target,
    metadata
  } = options;

  const payload = {
    event: String(event || 'unknown').slice(0, 64),
    email_hash: email ? hashEmail(email) : null,
    user_id: userId || null,
    ip: ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
    success: !!success,
    reason: reason ? String(reason).slice(0, 200) : null,
    actor: actor || null,
    target: target || null,
    metadata: metadata || null,
    created_at: new Date().toISOString()
  };

  // Log estruturado sempre
  try {
    console.info('[_lib audit]', JSON.stringify({
      event: payload.event,
      success: payload.success,
      reason: payload.reason,
      target: payload.target
    }));
  } catch {}

  // Persiste best-effort
  try {
    await supabaseAdminRequest('/rest/v1/auth_audit_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.error('[_lib] audit persist falhou:', err.code || err.message);
  }
}

function hashEmail(email) {
  return crypto
    .createHash('sha256')
    .update(String(email).toLowerCase())
    .digest('hex')
    .slice(0, 32);
}

// ═════════════════════════════════════════════════════════════
// 7. PLANO EFETIVO — com cache KV
// ═════════════════════════════════════════════════════════════
const PLAN_CACHE_TTL_SEC = 60;

async function getPlanForUser(userId) {
  if (!userId) return 'free';

  const cacheKey = `plan:${userId}`;

  // 1) Cache
  try {
    const redis = getRedis();
    const cached = await redis.get(cacheKey);
    if (cached && VALID_PLANS.has(cached)) return cached;
  } catch { /* cache miss ou KV off */ }

  // 2) Banco
  let plan = 'free';
  try {
    const result = await supabaseAdminRequest(
      `/rest/v1/effective_plan?user_id=eq.${encodeURIComponent(userId)}&select=plan&limit=1`,
      { method: 'GET' }
    );

    if (result.response.ok && Array.isArray(result.body) && result.body[0]) {
      const candidate = result.body[0].plan;
      if (VALID_PLANS.has(candidate)) plan = candidate;
    }
  } catch (err) {
    console.warn('[_lib] getPlanForUser query falhou:', err.code || err.message);
    return 'free';
  }

  // 3) Cacheia
  try {
    const redis = getRedis();
    await redis.set(cacheKey, plan, { ex: PLAN_CACHE_TTL_SEC });
  } catch { /* KV off */ }

  return plan;
}

async function invalidatePlanCache(userId) {
  if (!userId) return;
  try {
    const redis = getRedis();
    await redis.del(`plan:${userId}`);
  } catch {}
}

// ═════════════════════════════════════════════════════════════
// 8. CSRF — Origin check
// ═════════════════════════════════════════════════════════════
function checkOrigin(req) {
  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

  // Se ALLOWED_ORIGINS não estiver configurado, permite (fail-open em dev)
  if (ALLOWED_ORIGINS.size === 0) return true;

  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return false;

  try {
    const { origin: o } = new URL(origin);
    return ALLOWED_ORIGINS.has(o);
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════
// 9. HELPERS DE AUTENTICAÇÃO INTERNA (HMAC)
// ═════════════════════════════════════════════════════════════
function signHmac(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyHmac(token, secret, maxAgeMs = 4 * 3600 * 1000) {
  if (!token || !secret) return null;

  const [body, sig] = String(token).split('.');
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
    if (!payload.iat || Date.now() - payload.iat > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

// ═════════════════════════════════════════════════════════════
// 10. HELPERS DE SENHA — scrypt
// ═════════════════════════════════════════════════════════════
function verifyScrypt(password, storedHash) {
  return new Promise((resolve) => {
    try {
      const [algo, saltHex, hashHex] = String(storedHash).split('$');
      if (algo !== 'scrypt') return resolve(false);

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
  // Constantes
  IS_PROD,
  VALID_PLANS,
  ALLOWED_ORIGINS,

  // Config
  getConfig,
  getAdminKey,

  // HTTP
  sendJson,
  methodNotAllowed,
  parseBody,
  parseCookies,
  clientIp,

  // Supabase
  supabaseRequest,
  supabaseAdminRequest,

  // Cookies
  setAuthCookies,
  clearAuthCookies,
  getAccessToken,
  getRefreshToken,
  getAuthUser,

  // Rate limit
  checkAndIncrement,
  resetBucket,

  // Auditoria
  audit,

  // Plano efetivo
  getPlanForUser,
  invalidatePlanCache,

  // CSRF
  checkOrigin,

  // HMAC (admin/session)
  signHmac,
  verifyHmac,

  // Senha
  verifyScrypt,
  timingSafeEq
};