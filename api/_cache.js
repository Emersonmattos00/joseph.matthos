'use strict';

/* ============================================================
   api/_cache.js — Redis / Upstash (v1.2 — Auditoria corrigida)
   ------------------------------------------------------------
   Correções da auditoria v1.1:
   1. invalidateUserCache() retorna false quando falha parcial
   2. Integra invalidação de plano (invalidatePlanCache)
   3. hashIp() usa HMAC com segredo
   4. normalizeIdentifier() valida UUID
   5. Expõe redisConfigured (não disponibilidade)
   6. Padroniza variáveis de ambiente (KV_* e UPSTASH_*)
   7. Valida estrutura do cache lido
   ============================================================ */

const { createHash, createHmac } = require('node:crypto');
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let redis = null;
let streamRatelimit = null;
let redisConfigured = false;

// P2.6: padroniza variáveis (KV_* como fallback)
const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

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
// VALIDAÇÃO DE IDENTIFICADORES (P2.4)
// ─────────────────────────────────────────────────────────────
function normalizeIdentifier(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200 || /[\r\n]/.test(normalized)) return null;
  return normalized;
}

// P2.4: valida UUID antes de montar chave de cache
function normalizeUuid(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!UUID_RE.test(normalized)) return null;
  return normalized;
}

// ─────────────────────────────────────────────────────────────
// HASH DE IP (P2.3: HMAC com segredo)
// ─────────────────────────────────────────────────────────────
function getHashSecret() {
  const s = String(process.env.RATE_LIMIT_HASH_SECRET || '').trim();
  if (s.length >= 32) return s;
  const j = String(process.env.JWT_SECRET || '').trim();
  if (j.length >= 32) return `cache:${j}`;
  return null;
}

function hashIp(ip) {
  if (typeof ip !== 'string') return null;
  const normalized = ip.trim();
  if (!isIP(normalized)) return null;

  const secret = getHashSecret();
  if (!secret) {
    if (IS_PRODUCTION) {
      console.error('[cache] RATE_LIMIT_HASH_SECRET/JWT_SECRET ausente — hash inseguro bloqueado.');
      return null;
    }
    console.warn('[cache] Hash de IP sem segredo (dev).');
    return createHash('sha256').update(normalized).digest('hex');
  }
  return createHmac('sha256', secret).update(normalized).digest('hex');
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
// CONSULTAR CACHE (P2.7: valida estrutura)
// ─────────────────────────────────────────────────────────────
async function getCachedAccess(userId, trackId) {
  if (!redisConfigured || !redis) return null;

  const safeUserId = normalizeUuid(userId);
  const safeTrackId = normalizeUuid(trackId);
  if (!safeUserId || !safeTrackId) return null;

  try {
    const version = await getAccessVersion(safeUserId);
    if (!Number.isSafeInteger(version) || version < 0) return null;

    const key = accessCacheKey(safeUserId, version, safeTrackId);
    const raw = await redis.get(key);
    if (raw === null || raw === undefined) return null;

    // P2.7: valida estrutura do cache
    let parsed = raw;
    if (typeof raw === 'string') {
      try { parsed = JSON.parse(raw); } catch { return null; }
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.allowed !== 'boolean') return null;

    return parsed;
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

  const safeUserId = normalizeUuid(userId);
  const safeTrackId = normalizeUuid(trackId);
  if (!safeUserId || !safeTrackId) return false;

  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_CACHE_TTL) {
    throw new RangeError('TTL do cache deve estar entre 1 e 3600 segundos.');
  }

  if (!access || typeof access !== 'object' || typeof access.allowed !== 'boolean') return false;

  try {
    const version = await getAccessVersion(safeUserId);
    if (!Number.isSafeInteger(version) || version < 0) return false;

    const key = accessCacheKey(safeUserId, version, safeTrackId);
    await redis.set(key, JSON.stringify(access), { ex: ttlSeconds });
    return true;
  } catch (error) {
    console.error('[cache] setCachedAccess:', error.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// INVALIDAÇÃO DE PERMISSÕES
// ─────────────────────────────────────────────────────────────
async function invalidateAccessCache(userId) {
  if (!redisConfigured || !redis) return false;

  const safeUserId = normalizeUuid(userId);
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
// INVALIDAÇÃO DE USUÁRIO (P1.1 + P1.2)
// ─────────────────────────────────────────────────────────────
async function invalidateUserCache(userId) {
  const safeUserId = normalizeUuid(userId);
  if (!safeUserId) return false;

  if (!redisConfigured || !redis) {
    // Sem Redis configurado, não há nada a invalidar
    return false;
  }

  try {
    const results = await Promise.allSettled([
      redis.incr(accessVersionKey(safeUserId)),
      redis.del(`users:list`),
      redis.del(`plan:${safeUserId}`)
    ]);

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length) {
      const msg = failed.map(f => f.reason?.message || 'erro').join('; ');
      console.error('[cache] invalidateUserCache falhou parcialmente:', msg);
      // P1.1: retorna false quando qualquer operação obrigatória falha
      return false;
    }

    return true;
  } catch (error) {
    console.error('[cache] invalidateUserCache:', error.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// SAÚDE DO CACHE (P2.5)
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

  // P2.5: nome reflete o que realmente é (config vs disponibilidade)
  get redisConfigured() {
    return redisConfigured;
  },

  // Mantido por compatibilidade — use getCacheHealth() para disponibilidade real
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
