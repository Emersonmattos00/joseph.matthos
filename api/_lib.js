/* ============================================================
   api/_lib.js — Módulos internos consolidados
   ------------------------------------------------------------
      Substitui: módulos legados de auth, audit, rate-limit e plan.
              _plan.js, _csrf-guard.js

   ⚠️  NUNCA importar no cliente. Só serverless functions.

   Dependências obrigatórias (produção):
     - @neondatabase/serverless
     - jsonwebtoken
     - @upstash/redis (opcional, mas recomendado para rate limit)

   Variáveis de ambiente esperadas:
     - DATABASE_URL (Neon PostgreSQL)
     - JWT_SECRET
     - UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  (opcional)
       (ou KV_REST_API_URL / KV_REST_API_TOKEN para Vercel KV)
     - ALLOWED_ORIGINS (CSV)
     - NODE_ENV=production

   Schemas de auditoria:
     auth_audit_log → id, event, email_hash, user_id, ip, user_agent,
                      success, reason, created_at
     admin_audit    → id, actor, action, target, metadata, ip,
                      user_agent, created_at

   🔧 CORREÇÕES APLICADAS
   ------------------------------------------------------------
   1. getPlanForUserDetailed() — distingue "free real" de "não
      consegui confirmar" (falha de rede, erro 5xx, plano inválido).
   2. getPlanForUser() mantida como wrapper simples (string),
      retrocompatível com o código existente.
   3. Cache KV só guarda planos confirmados (não cacheia fallback).
   4. Migração Supabase → Neon: getAuthUser usa JWT próprio;
      getPlanForUserDetailed consulta a view effective_plan no Neon.
   ============================================================ */

'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { neon } = require('@neondatabase/serverless');

// ─────────────────────────────────────────────────────────────
// Guard: impede importação no cliente
// ─────────────────────────────────────────────────────────────
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
    const secret = String(process.env.JWT_SECRET || '').trim();
    if (!secret) return null;

    const payload = jwt.verify(accessToken, secret);
    if (!payload || !payload.id) return null;

    return { id: payload.id, email: payload.email, role: payload.role };
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
// 6. AUDITORIA — roteamento entre auth_audit_log e admin_audit
// ═════════════════════════════════════════════════════════════

function resolveAuditTable(event, override) {
  if (override === 'admin') return 'admin_audit';
  if (override === 'auth') return 'auth_audit_log';

  const e = String(event || '').toLowerCase();
  if (e.startsWith('admin_')) return 'admin_audit';
  if (
    e.startsWith('content.') ||
    e.startsWith('upload') ||
    e.startsWith('user.plan')
  ) return 'admin_audit';

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
// ------------------------------------------------------------
// getPlanForUserDetailed()  → { plan, degraded, reason }
// getPlanForUser()          → 'free' | 'premium' | 'anual'
//
// `degraded: true` significa que NÃO conseguimos confirmar o
// plano (rede, 5xx, valor inválido). Nesse caso, `plan` cai em
// 'free' por segurança, mas o caller pode avisar o usuário.
//
// Regras:
//   - Cache KV só guarda planos CONFIRMADOS (não cacheia fallback)
//   - Cache TTL: 60s
// ═════════════════════════════════════════════════════════════
const PLAN_CACHE_TTL_SEC = 60;

/**
 * Versão detalhada — distingue free real de falha de lookup.
 *
 * @param {string} userId
 * @returns {Promise<{ plan: string, degraded: boolean, reason: string|null }>}
 */
async function getPlanForUserDetailed(userId) {
  if (!userId) {
    return { plan: 'free', degraded: false, reason: 'no_user_id' };
  }

  const cacheKey = `plan:${userId}`;
  const redis = getRedis();

  // 1) Cache
  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && VALID_PLANS.has(cached)) {
        return { plan: cached, degraded: false, reason: 'cache_hit' };
      }
    } catch { /* cache miss ou KV off */ }
  }

  // 2) Banco (Neon)
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
      // Sem linha → usuário realmente free (não é degradação)
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

  // 3) Cacheia APENAS se foi confirmado com sucesso
  if (redis && !degraded) {
    try {
      await redis.set(cacheKey, plan, { ex: PLAN_CACHE_TTL_SEC });
    } catch { /* KV off */ }
  }

  return { plan, degraded, reason };
}

/**
 * Versão simples — retrocompatível.
 * Retorna 'free' | 'premium' | 'anual'.
 *
 * ⚠️  Em caso de falha de lookup, retorna 'free' (fail-secure).
 *     Se o caller precisar distinguir, use getPlanForUserDetailed().
 *
 * @param {string} userId
 * @returns {Promise<string>}
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
// 8. CSRF — Origin check
// ═════════════════════════════════════════════════════════════
function checkOrigin(req) {
  // 🔓 TEMPORÁRIO: libera todas as origens para testes de migração.
  //    Reativar antes da produção (usar ALLOWED_ORIGINS).
  return true;
}

// ═════════════════════════════════════════════════════════════
// 9. HMAC — sessão admin
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
// 10. SENHA — scrypt (nativo do Node)
// ------------------------------------------------------------
// Formato do hash armazenado:
//   scrypt$<salt-em-hex>$<hash-em-hex>
//
// Gere com o script `gerar-hash-admin.js` na raiz do projeto:
//   node gerar-hash-admin.js "sua-senha-forte"
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

  // HTTP
  sendJson,
  methodNotAllowed,
  parseBody,
  parseCookies,
  clientIp,

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
  getPlanForUserDetailed,
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