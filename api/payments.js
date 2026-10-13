cat > api/payments.js << 'EOF'
const { eq, and, gt } = require('drizzle-orm');
const { randomUUID } = require('crypto');
const { db } = require('./_db');
const { rentals, rentalProducts, subscriptions, plans, orders, orderItems, users } = require('../src/schema.js');
const { verifyUser } = require('./_lib');
const { invalidateAccessCache } = require('./_cache');
const { sendRentalConfirmation, sendSubscriptionConfirmation } = require('./_email');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await verifyUser(req);
  if (!user) return res.status(401).json({ error: 'Não autenticado' });

  const { action } = req.query;

  switch (action) {
    case 'rent':
      return handleRent(req, res, user);
    case 'subscribe':
      return handleSubscribe(req, res, user);
    default:
      return res.status(400).json({ error: 'Ação inválida' });
  }
};

async function handleRent(req, res, user) {
  const { rentalProductId } = req.body;
  if (!rentalProductId) return res.status(400).json({ error: 'rentalProductId obrigatório' });

  // 1. Buscar produto de aluguel
  const [product] = await db.select().from(rentalProducts).where(
    eq(rentalProducts.id, rentalProductId)
  ).limit(1);

  if (!product || !product.active) {
    return res.status(404).json({ error: 'Produto de aluguel não encontrado' });
  }

  // 2. Verificar se já tem aluguel ativo para o mesmo track/album
  const now = new Date();
  const existingConditions = [
    eq(rentals.userId, user.id),
    eq(rentals.status, 'ACTIVE'),
    gt(rentals.expiresAt, now.toISOString()),
  ];
  if (product.trackId) existingConditions.push(eq(rentals.trackId, product.trackId));
  if (product.albumId) existingConditions.push(eq(rentals.albumId, product.albumId));

  const [existing] = await db.select().from(rentals).where(and(...existingConditions)).limit(1);
  if (existing) {
    return res.status(409).json({ 
      error: 'Você já tem um aluguel ativo deste item',
      expiresAt: existing.expiresAt 
    });
  }

  // 3. TODO: Integrar com gateway de pagamento
  // const charge = await stripe.charges.create({...});
  // if (!charge.paid) return res.status(402).json({ error: 'Pagamento recusado' });

  // 4. Criar pedido
  const orderId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    userId: user.id,
    status: 'PAID', // em produção: 'PENDING' até confirmar pagamento
    totalCents: product.priceCents,
    currency: product.currency,
    paidAt: now.toISOString(),
  });

  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId,
    productType: 'RENTAL',
    productId: product.id,
    quantity: 1,
    unitPriceCents: product.priceCents,
  });

  // 5. Criar aluguel
  const expiresAt = new Date(now.getTime() + product.durationHours * 60 * 60 * 1000);
  const rentalCode = `RENT-${randomUUID().slice(0, 8).toUpperCase()}`;

  const [rental] = await db.insert(rentals).values({
    id: randomUUID(),
    rentalCode,
    userId: user.id,
    trackId: product.trackId,
    albumId: product.albumId,
    orderId,
    status: 'ACTIVE',
    startsAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  }).returning();

  await invalidateAccessCache(user.id);

  // 6. Enviar e-mail (não falha se der erro)
  try {
    await sendRentalConfirmation(user.email, product.name, expiresAt);
  } catch (emailError) {
    console.error('Erro ao enviar e-mail:', emailError);
  }

  return res.status(200).json({
    success: true,
    message: 'Aluguel confirmado',
    rental,
    expiresAt: expiresAt.toISOString(),
  });
}

async function handleSubscribe(req, res, user) {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId obrigatório' });

  const [plan] = await db.select().from(plans).where(eq(plans.id, planId)).limit(1);
  if (!plan || !plan.active) return res.status(404).json({ error: 'Plano não encontrado' });

  // TODO: Integrar com gateway de pagamento recorrente

  const now = new Date();
  const periodEnd = new Date(now);
  if (plan.intervalUnit === 'MONTH') periodEnd.setMonth(periodEnd.getMonth() + plan.intervalCount);
  else if (plan.intervalUnit === 'YEAR') periodEnd.setFullYear(periodEnd.getFullYear() + plan.intervalCount);
  else if (plan.intervalUnit === 'DAY') periodEnd.setDate(periodEnd.getDate() + plan.intervalCount);

  const orderId = randomUUID();
  await db.insert(orders).values({
    id: orderId,
    userId: user.id,
    status: 'PAID',
    totalCents: plan.priceCents,
    currency: plan.currency,
    paidAt: now.toISOString(),
  });

  await db.insert(orderItems).values({
    id: randomUUID(),
    orderId,
    productType: 'SUBSCRIPTION',
    productId: plan.id,
    quantity: 1,
    unitPriceCents: plan.priceCents,
  });

  const [subscription] = await db.insert(subscriptions).values({
    id: randomUUID(),
    userId: user.id,
    planId: plan.id,
    status: 'ACTIVE',
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: periodEnd.toISOString(),
  }).returning();

  await invalidateAccessCache(user.id);

  try {
    await sendSubscriptionConfirmation(user.email, plan.name, periodEnd);
  } catch (emailError) {
    console.error('Erro ao enviar e-mail:', emailError);
  }

  return res.status(200).json({
    success: true,
    subscription,
    expiresAt: periodEnd.toISOString(),
  });
}
EOF