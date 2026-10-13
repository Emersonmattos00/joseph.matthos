cat > api/_lib.js << 'EOF'
const jwt = require('jsonwebtoken');
const { eq, and, gt, isNull, or } = require('drizzle-orm');
const { db } = require('./_db');
const { users, subscriptions, rentals, tracks } = require('../src/schema.js');
const { getCachedAccess, setCachedAccess } = require('./_cache');

async function verifyUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;

  try {
    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const [user] = await db.select().from(users).where(eq(users.id, decoded.userId));
    return user || null;
  } catch (err) {
    return null;
  }
}

/**
 * Verifica acesso do usuário a uma faixa
 * Retorna { hasSubscription, hasRental, expiresAt }
 */
async function getUserAccess(userId, trackId) {
  const now = new Date().toISOString();

  // 1. Buscar a faixa para saber o albumId
  const [track] = await db.select().from(tracks).where(eq(tracks.id, trackId)).limit(1);
  if (!track) return { hasSubscription: false, hasRental: false, expiresAt: null };

  // 2. Verificar assinatura ativa
  const [subscription] = await db
    .select()
    .from(subscriptions)
    .where(and(
      eq(subscriptions.userId, userId),
      eq(subscriptions.status, 'ACTIVE'),
      gt(subscriptions.currentPeriodEnd, now)
    ))
    .limit(1);

  if (subscription) {
    return {
      hasSubscription: true,
      hasRental: false,
      expiresAt: subscription.currentPeriodEnd,
    };
  }

  // 3. Verificar aluguel ativo (por track OU por album)
  const rentalConditions = [
    eq(rentals.userId, userId),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, now),
  ];

  const rentalWhere = track.albumId
    ? and(...rentalConditions, or(
        eq(rentals.trackId, trackId),
        eq(rentals.albumId, track.albumId)
      ))
    : and(...rentalConditions, eq(rentals.trackId, trackId));

  const [rental] = await db.select().from(rentals).where(rentalWhere).limit(1);

  if (rental) {
    return {
      hasSubscription: false,
      hasRental: true,
      expiresAt: rental.expiresAt,
    };
  }

  return { hasSubscription: false, hasRental: false, expiresAt: null };
}

async function getUserAccessCached(userId, trackId) {
  const cached = await getCachedAccess(userId, trackId);
  if (cached) return cached;

  const access = await getUserAccess(userId, trackId);
  await setCachedAccess(userId, trackId, access, 300);
  return access;
}

module.exports = { verifyUser, getUserAccess, getUserAccessCached };
EOF