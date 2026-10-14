const { Redis } = require('@upstash/redis');
const { Ratelimit } = require('@upstash/ratelimit');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Rate limit: 60 requisições por minuto por IP
const streamRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(60, '60 s'),
  analytics: true,
  prefix: 'ratelimit:stream',
});

// Cache de acesso: TTL de 5 minutos
async function getCachedAccess(userId, trackId) {
  const key = `access:${userId}:${trackId}`;
  return redis.get(key);
}

async function setCachedAccess(userId, trackId, access, ttlSeconds = 300) {
  const key = `access:${userId}:${trackId}`;
  await redis.set(key, access, { ex: ttlSeconds });
}

async function invalidateAccessCache(userId) {
  // Quando o usuário compra/aluga, invalida todo o cache dele
  const pattern = `access:${userId}:*`;
  const keys = await redis.keys(pattern);
  if (keys.length > 0) await redis.del(...keys);
}

module.exports = {
  redis,
  streamRatelimit,
  getCachedAccess,
  setCachedAccess,
  invalidateAccessCache,
};
