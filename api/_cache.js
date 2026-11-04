/* api/_cache.js — Redis com fail-closed para operações sensíveis */
'use strict';

let redis = null;
let streamRatelimit = null;
let redisAvailable = false;

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

if (url && token) {
  try {
    const { Redis } = require('@upstash/redis');
    const { Ratelimit } = require('@upstash/ratelimit');

    redis = new Redis({ url, token });
    streamRatelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(60, '60 s'), // 60 req/min por IP
      analytics: true,
      prefix: 'ratelimit:stream',
    });
    redisAvailable = true;
  } catch (err) {
    console.error('[cache] Falha ao inicializar Upstash:', err.message);
  }
} else {
  console.warn('[cache] UPSTASH_REDIS_* não configurado — cache e rate limit desativados.');
}

// ─────────────────────────────────────────────────────────────
// Rate limit com fail-closed (nega em produção se Redis cair)
// ─────────────────────────────────────────────────────────────
async function checkStreamRateLimit(ip) {
  if (!redisAvailable || !streamRatelimit) {
    // Em produção, sem Redis = nega por segurança
    if (process.env.NODE_ENV === 'production') {
      return { success: false, reason: 'rate_limit_unavailable' };
    }
    // Em desenvolvimento, permite para não travar testes
    return { success: true };
  }

  try {
    return await streamRatelimit.limit(ip);
  } catch (err) {
    console.error('[cache] Erro no rate limit:', err.message);
    // Fail-closed em produção
    return { success: process.env.NODE_ENV !== 'production' };
  }
}

// ─────────────────────────────────────────────────────────────
// Cache de acesso (opcional, usado pelo stream.js)
// ─────────────────────────────────────────────────────────────
async function getCachedAccess(userId, trackId) {
  if (!redisAvailable) return null;
  try { return await redis.get(`access:${userId}:${trackId}`); }
  catch { return null; }
}

async function setCachedAccess(userId, trackId, access, ttlSeconds = 300) {
  if (!redisAvailable) return;
  try { await redis.set(`access:${userId}:${trackId}`, access, { ex: ttlSeconds }); }
  catch (err) { console.error('[cache] setCachedAccess:', err.message); }
}

async function invalidateAccessCache(userId) {
  if (!redisAvailable) return;
  try {
    const keys = await redis.keys(`access:${userId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch (err) { console.error('[cache] invalidateAccessCache:', err.message); }
}

module.exports = {
  redis,
  streamRatelimit,
  redisAvailable,
  checkStreamRateLimit,
  getCachedAccess,
  setCachedAccess,
  invalidateAccessCache,
};