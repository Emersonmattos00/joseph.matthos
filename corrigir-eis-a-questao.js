const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigir() {
  console.log("🔄 Corrigindo os caminhos da música 'Eis a Questão!'...");

  // O caminho correto do áudio completo no R2 (baseado na estrutura premium/mentalidadedeourov2/...)
  const streamKeyCorreto = "premium/mentalidadedeourov2/eis-a-questao.mp3";
  
  // O caminho correto do preview no R2
  const previewKeyCorreto = "previews/eis-a-questao.mp3";

  // Atualiza o banco
  const result = await sql`
    UPDATE tracks 
    SET stream_key = ${streamKeyCorreto}, 
        preview_key = ${previewKeyCorreto} 
    WHERE title = ${"Eis a Questão!"}
    RETURNING id, title, stream_key, preview_key
  `;

  if (result.length > 0) {
    console.log("✅ Música atualizada com sucesso!");
    console.table(result);
  } else {
    console.log("❌ Música 'Eis a Questão!' não encontrada no banco. Verifique o título exato.");
  }
}

corrigir().catch(console.error);