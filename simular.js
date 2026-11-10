const { db } = require('./api/_db');
const { orders, subscriptions } = require('./src/schema.js');
const { eq } = require('drizzle-orm');

async function simularAprovacao() {
  const [order] = await db.select().from(orders).where(eq(orders.status, 'PENDING')).orderBy(orders.createdAt).limit(1);
  if (!order) { console.log('Nenhum pedido PENDING'); return; }

  const now = new Date();
  const isSubscription = order.idempotency_key && order.idempotency_key.startsWith('sub:');

  await db.transaction(async (tx) => {
    await tx.update(orders).set({ status: 'PAID', paidAt: now.toISOString() }).where(eq(orders.id, order.id));
    
    if (isSubscription) {
      const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.userId, order.userId)).orderBy(subscriptions.createdAt).limit(1);
      if (sub) {
        const end = new Date(now);
        end.setDate(end.getDate() + 30);
        await tx.update(subscriptions).set({ status: 'ACTIVE', currentPeriodStart: now.toISOString(), currentPeriodEnd: end.toISOString() }).where(eq(subscriptions.id, sub.id));
        console.log('✅ Assinatura ativada!');
      }
    } else {
      console.log('✅ Pedido de aluguel pago (simulação).');
    }
  });
}

simularAprovacao().catch(console.error);
