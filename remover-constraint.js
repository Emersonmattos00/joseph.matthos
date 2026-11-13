const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function removerConstraint() {
  console.log("🔍 Procurando constraint de unicidade na tabela tracks...");
  
  try {
    // Tenta rodar o SQL puro como uma string. 
    // O driver neon aceita sql("SELECT ...") ou sql`SELECT ...`
    const res = await sql(`
      SELECT conname 
      FROM pg_constraint 
      WHERE conrelid = 'tracks'::regclass 
      AND contype = 'u';
    `);
    
    if (!res || res.length === 0) {
      console.log("✅ Nenhuma constraint de unicidade encontrada.");
      process.exit(0);
    }

    for (const row of res) {
      console.log(`Removendo constraint: ${row.conname}`);
      await sql(`ALTER TABLE tracks DROP CONSTRAINT IF EXISTS "${row.conname}"`);
    }
    
    console.log("✅ Constraint(s) removida(s) com sucesso!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Erro:", err.message);
    process.exit(1);
  }
}

removerConstraint();