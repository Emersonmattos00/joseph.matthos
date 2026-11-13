const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigir() {
  console.log("🔍 Corrigindo a ordem das músicas 'Reflexão' e 'Vivendo a Reflexão'...\n");

  // 1. Move "Vivendo a Reflexão" para 12 (já está 12, mas garante)
  await sql`
    UPDATE tracks 
    SET track_number = 12 
    WHERE title = 'Vivendo a Reflexão'
  `;
  console.log("✅ 'Vivendo a Reflexão' -> Faixa 12");

  // 2. Move "Reflexão" para 11 e adiciona o ISRC
  const res = await sql`
    UPDATE tracks 
    SET track_number = 11, 
        isrc = 'QTE6HT2667684'
    WHERE title = 'Reflexão'
    RETURNING id, title, track_number, isrc
  `;

  if (res.length > 0) {
    console.log("✅ 'Reflexão' -> Faixa 11, ISRC: QTE6HT2667684");
  } else {
    console.log("❌ 'Reflexão' não encontrada.");
  }

  console.log("\n🎉 Concluído!");
}

corrigir().catch(console.error);
