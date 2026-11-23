'use strict';

/* ============================================================
   api/_cache.js — Redis / Upstash (v1.1)
   ------------------------------------------------------------
   Correções da auditoria de usuários:
   1. invalidateUserCache() centralizado
   2. Expõe versão da chave para auditoria
   3. Trata falha de Redis sem mascarar erro de plano
   ============================================================ */

const { createHash } = require('node:crypto');
const { isIP } = require('node:net');

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

const RATE_LIMIT_REQUESTS = 60;
const RATE_LIMIT_WINDOW = '60 s';
const DEFAULT_CACHE_TTL = 300;
const MAX_CACHE_TTL = 3600;

let redis = null;
let streamRatelimit = null;
let redisConfigured = false;

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

// ─────────────────────────────────────────────────────────────
// VALIDAÇÃO DA CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
function validateRedisConfig() {
  if (!url || !token) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      Boolean(parsed.hostname) &&
      typeof token === 'string' &&
      token.length >= 10
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// INICIALIZAÇÃO DO UPSTASH
// ─────────────────────────────────────────────────────────────
if (validateRedisConfig()) {
  try {
    const { Redis } = require('@upstash/redis');
    const { Ratelimit } = require('@upstash/ratelimit');

    redis = new Redis({ url, token });

    streamRatelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW),
      analytics: true,
      prefix: 'ratelimit:stream'
    });

    redisConfigured = true;
    console.info('[cache] Cliente Upstash inicializado.');
  } catch (error) {
    console.error('[cache] Falha ao inicializar Upstash:', error.message);
  }
} else {
  console.warn('[cache] Configuração Upstash ausente ou inválida.');
}

// ─────────────────────────────────────────────────────────────
// VALIDAÇÃO DE IDENTIFICADORES
// ─────────────────────────────────────────────────────────────
function normalizeIdentifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

// ─────────────────────────────────────────────────────────────
// IDENTIFICAÇÃO PRIVADA DO IP (hash SHA-256)
// ─────────────────────────────────────────────────────────────
function hashIp(ip) {
  if (typeof ip !== 'string') return null;
  const normalized = ip.trim();
  if (!isIP(normalized)) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// RATE LIMIT DE STREAMING
// ─────────────────────────────────────────────────────────────
async function checkStreamRateLimit(ip) {
  const ipHash = hashIp(ip);

  if (!ipHash) {
    return { success: false, reason: 'missing_or_invalid_ip' };
  }

  if (!redisConfigured || !streamRatelimit) {
    return {
      success: !IS_PRODUCTION,
      reason: 'rate_limit_unavailable'
    };
  }

  try {
    const result = await streamRatelimit.limit(ipHash);
    return {
      success: result.success === true,
      reason: result.success === true ? null : 'rate_limit_exceeded',
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset
    };
  } catch (error) {
    console.error('[cache] Falha no rate limit:', error.message);
    return {
      success: !IS_PRODUCTION,
      reason: 'rate_limit_unavailable'
    };
  }
}

// ─────────────────────────────────────────────────────────────
// CACHE DE PERMISSÕES — VERSIONADO
// ─────────────────────────────────────────────────────────────
function accessVersionKey(userId) {
  return `access-version:${userId}`;
}

function accessCacheKey(userId, version, trackId) {
  return `access:${userId}:${version}:${trackId}`;
}

async function getAccessVersion(userId) {
  const version = await redis.get(accessVersionKey(userId));
  return version == null ? 0 : Number(version);
}

// ─────────────────────────────────────────────────────────────
// CONSULTAR CACHE
// ─────────────────────────────────────────────────────────────
async function getCachedAccess(userId, trackId) {
  if (!redisConfigured || !redis) return null;

  const safeUserId = normalizeIdentifier(userId);
  const safeTrackId = normalizeIdentifier(trackId);
  if (!safeUserId || !safeTrackId) return null;

  try {
    const version = await getAccessVersion(safeUserId);
    if (!Number.isSafeInteger(version) || version < 0) return null;

    const key = accessCacheKey(safeUserId, version, safeTrackId);
    return await redis.get(key);
  } catch (error) {
    console.error('[cache] getCachedAccess:', error.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// GRAVAR CACHE
// ─────────────────────────────────────────────────────────────
async function setCachedAccess(userId, trackId, access, ttlSeconds = DEFAULT_CACHE_TTL) {
  if (!redisConfigured || !redis) return false;

  const safeUserId = normalizeIdentifier(userId);
  const safeTrackId = normalizeIdentifier(trackId);
  if (!safeUserId || !safeTrackId) return false;

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_CACHE_TTL) {
    throw new RangeError('TTL do cache deve estar entre 1 e 3600 segundos.');
  }

  if (access === undefined || access === null) return false;

  try {
    const version = await getAccessVersion(safeUserId);
    if (!Number.isSafeInteger(version) || version < 0) return false;

    const key = accessCacheKey(safeUserId, version, safeTrackId);
    await redis.set(key, access, { ex: ttlSeconds });
    return true;
  } catch (error) {
    console.error('[cache] setCachedAccess:', error.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// INVALIDAÇÃO DE PERMISSÕES (barata)
// ─────────────────────────────────────────────────────────────
async function invalidateAccessCache(userId) {
  if (!redisConfigured || !redis) return false;

  const safeUserId = normalizeIdentifier(userId);
  if (!safeUserId) return false;

  try {
    await redis.incr(accessVersionKey(safeUserId));
    return true;
  } catch (error) {
    console.error('[cache] invalidateAccessCache:', error.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// INVALIDAÇÃO DE USUÁRIO (integra com admin.js)
// ─────────────────────────────────────────────────────────────
async function invalidateUserCache(userId) {
  if (!redisConfigured || !redis) return false;

  const safeUserId = normalizeIdentifier(userId);
  if (!safeUserId) return false;

  try {
    const results = await Promise.allSettled([
      redis.incr(accessVersionKey(safeUserId)),
      redis.del(`users:list`)
    ]);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      console.warn('[cache] invalidateUserCache parcial:', failed.map(f => f.reason?.message).join('; '));
    }
    return true;
  } catch (error) {
    console.error('[cache] invalidateUserCache:', error.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// SAÚDE DO CACHE
// ─────────────────────────────────────────────────────────────
async function getCacheHealth() {
  if (!redisConfigured) return { ok: false, reason: 'not_configured' };
  try {
    const pong = await redis.ping();
    return { ok: pong === 'PONG' || pong === true };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTAÇÕES
// ─────────────────────────────────────────────────────────────
module.exports = {
  redis,
  streamRatelimit,

  get redisAvailable() {
    return redisConfigured;
  },

  checkStreamRateLimit,
  getCachedAccess,
  setCachedAccess,
  invalidateAccessCache,
  invalidateUserCache,
  getCacheHealth
};
