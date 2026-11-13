const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function remover() {
  console.log("🔍 Buscando constraints...");

  const constraints = await sql`
    SELECT conname 
    FROM pg_constraint 
    WHERE conrelid = 'tracks'::regclass 
    AND contype = 'u'
  `;

  if (constraints.length === 0) {
    console.log("✅ Nenhuma constraint encontrada.");
    return;
  }

  for (const row of constraints) {
    console.log(`🔧 Removendo: ${row.conname}`);
    // Usa template literal para rodar o DDL
    await sql`ALTER TABLE tracks DROP CONSTRAINT IF EXISTS "${sql.unsafe ? sql.unsafe(row.conname) : row.conname}"`;
    console.log(`   ✅ Removida.`);
  }

  console.log("\n✅ Concluído!");
}

remover();