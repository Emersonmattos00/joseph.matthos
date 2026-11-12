const crypto = require('crypto');
const { db } = require('./api/_db');
const { users } = require('./src/schema.js');
const { eq } = require('drizzle-orm');

function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derived) => err ? reject(err) : resolve(derived));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function main() {
  const email = process.argv[2] || 'admin@josephmatthos.com';
  const password = process.argv[3] || 'Admin@2026!Seguro';

  if (password.length < 8) {
    console.error('Senha muito curta (mínimo 8).');
    process.exit(1);
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (existing) {
    await db.update(users).set({ role: 'ADMIN' }).where(eq(users.id, existing.id));
    console.log('✅ Usuário existente promovido a ADMIN.');
    console.log('   email:', email);
    console.log('   senha: (a que você já usa)');
    console.log('   ⚠️  Se você não lembra a senha, use outro e-mail ou redefina.');
    return;
  }

  const passwordHash = await hashPassword(password);
  const [created] = await db.insert(users).values({
    id: crypto.randomUUID(),
    email,
    name: 'Administrador',
    passwordHash,
    role: 'ADMIN',
    sessionVersion: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }).returning({ id: users.id, email: users.email, role: users.role });

  console.log('✅ Admin criado.');
  console.log('   email:', created.email);
  console.log('   senha:', password);
  console.log('   role:', created.role);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
