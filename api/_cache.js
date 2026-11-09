/* ============================================================
   api/_cache.js — Redis opcional e rate limit de streaming
   ------------------------------------------------------------
   - Upstash Redis
   - Rate limit por identificador confiável
   - Fail-closed em produção
   - Cache de autorização com TTL
   - Invalidação por versão do usuário
   ============================================================ */

'use strict';

let redis = null;
let streamRatelimit = null;
let redisAvailable = false;

const CACHE_TTL = 300;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW = '60 s';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (url && token) {
  try {
    const { Redis } = require('@upstash/redis');
    const { Ratelimit } = require('@upstash/ratelimit');

    redis = new Redis({ url, token });

    streamRatelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(
        RATE_LIMIT_MAX,
        RATE_LIMIT_WINDOW
      ),
      analytics: true,
      prefix: 'ratelimit:stream',
    });

    redisAvailable = true;
  } catch (err) {
    console.error(
      '[cache] Falha ao inicializar Redis:',
      err.message
    );
  }
} else {
  console.warn(
    '[cache] Redis não configurado.'
  );
}

function validId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\s:*]/.test(value)
  );
}

function cacheKey(userId, trackId) {
  if (!validId(userId) || !validId(trackId)) {
    throw new Error('Identificador de cache inválido.');
  }

  return `access:${userId}:${trackId}`;
}

function versionKey(userId) {
  if (!validId(userId)) {
    throw new Error('Identificador de usuário inválido.');
  }

  return `access-version:${userId}`;
}

async function checkStreamRateLimit(identifier) {
  if (
    typeof identifier !== 'string' ||
    identifier.length < 1 ||
    identifier.length > 200
  ) {
    return {
      success: false,
      reason: 'invalid_identifier',
    };
  }

  if (!redisAvailable || !streamRatelimit) {
    return {
      success: process.env.NODE_ENV !== 'production',
      reason: 'rate_limit_unavailable',
    };
  }

  try {
    const result = await streamRatelimit.limit(identifier);

    return {
      ...result,
      success: result.success === true,
    };
  } catch (err) {
    console.error(
      '[cache] Erro no rate limit:',
      err.message
    );

    return {
      success: process.env.NODE_ENV !== 'production',
      reason: 'rate_limit_error',
    };
  }
}

async function getCachedAccess(userId, trackId) {
  if (!redisAvailable) return null;

  try {
    const key = cacheKey(userId, trackId);
    const value = await redis.get(key);

    return value ?? null;
  } catch (err) {
    console.error(
      '[cache] getCachedAccess:',
      err.message
    );

    return null;
  }
}

async function setCachedAccess(
  userId,
  trackId,
  access,
  ttlSeconds = CACHE_TTL
) {
  if (!redisAvailable) return;

  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > 3600
  ) {
    throw new Error('TTL de cache inválido.');
  }

  if (!['full', 'preview', 'denied'].includes(access)) {
    throw new Error('Nível de acesso inválido.');
  }

  try {
    const key = cacheKey(userId, trackId);

    await redis.set(key, access, {
      ex: ttlSeconds,
    });
  } catch (err) {
    console.error(
      '[cache] setCachedAccess:',
      err.message
    );
  }
}

async function getAccessVersion(userId) {
  if (!redisAvailable) return null;

  try {
    const version = await redis.get(versionKey(userId));
    return version ?? '0';
  } catch (err) {
    console.error(
      '[cache] getAccessVersion:',
      err.message
    );

    return null;
  }
}

async function invalidateAccessCache(userId) {
  if (!redisAvailable) return;

  try {
    const key = versionKey(userId);

    await redis.incr(key);
    await redis.expire(key, 86400 * 30);
  } catch (err) {
    console.error(
      '[cache] invalidateAccessCache:',
      err.message
    );
  }
}

module.exports = {
  redis,
  streamRatelimit,
  redisAvailable,
  checkStreamRateLimit,
  getCachedAccess,
  setCachedAccess,
  getAccessVersion,
  invalidateAccessCache,
};