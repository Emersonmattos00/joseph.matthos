const { db } = require('./api/_db');
const { users, subscriptions, plans } = require('./src/schema.js');
const { eq } = require('drizzle-orm');
const { randomUUID } = require('crypto');

async function ativarPremium() {
  const email = 'emerson.mattos01@gmail.com';
  
  // 1. Busca o usuário pelo e-mail
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) { console.log('❌ Usuário não encontrado:', email); return; }

  // 2. Busca o plano anual (ou o primeiro ativo)
  const [plan] = await db.select().from(plans).where(eq(plans.intervalUnit, 'YEAR')).limit(1);
  const planoUsado = plan || (await db.select().from(plans).limit(1))[0];
  
  if (!planoUsado) { console.log('❌ Nenhum plano encontrado no banco'); return; }

  // 3. Cria a assinatura ACTIVE
  const now = new Date();
  const end = new Date(now);
  end.setFullYear(end.getFullYear() + 1); // 1 ano

  const id = randomUUID();
  await db.insert(subscriptions).values({
    id,
    userId: user.id,
    planId: planoUsado.id,
    status: 'ACTIVE',
    currentPeriodStart: now.toISOString(),
    currentPeriodEnd: end.toISOString(),
    initPoint: null,
    payerEmail: email,
  });

  console.log('✅ Assinatura ativada para:', email);
  console.log('   Plano:', planoUsado.name);
  console.log('   Válida até:', end.toISOString());
}
ativarPremium().catch(console.error);
