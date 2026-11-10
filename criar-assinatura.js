const { db } = require('./api/_db');
const { orders, subscriptions, plans } = require('./src/schema.js');
const { eq } = require('drizzle-orm');
const { randomUUID } = require('crypto');

async function criarAssinatura() {
  const userId = '76d03a84-5952-4f6b-9be1-fc0339111034';
  
  // Pega o primeiro plano premium do banco
  const [plan] = await db.select().from(plans).limit(1);
  if (!plan) { console.log('Nenhum plano encontrado'); return; }

  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + 30);

  const id = randomUUID();
  await db.insert(subscriptions).values({
    id,
    userId,
    planId: plan.id,
    status: 'ACTIVE',
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: end.toISOString(),
    initPoint: null,
    payerEmail: 'emerson.mattos01@gmail.com',
  });

  console.log('✅ Assinatura criada e ativa:', id);
}
criarAssinatura().catch(console.error);
