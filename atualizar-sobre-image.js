const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function atualizar() {
  console.log("🔍 Atualizando a imagem da seção Sobre...");

  const R2_PUBLIC_URL = "https://pub-9eaf26fd8c784a62bae2457a45edc7d2.r2.dev";
  const novaImagem = `${R2_PUBLIC_URL}/assets/img/josephmatthos.webp`;

  try {
    // 1. Busca o conteúdo atual
    const [row] = await sql`SELECT data FROM site_content WHERE key = 'default'`;
    if (!row) {
      console.log("❌ Conteúdo não encontrado.");
      process.exit(1);
    }

    const data = row.data;
    
    // 2. Atualiza o campo sobre.image
    if (!data.sobre) data.sobre = {};
    data.sobre.image = novaImagem;

    // 3. Salva de volta no banco
    await sql`
      UPDATE site_content 
      SET data = ${data}, version = version + 1, updated_at = ${new Date().toISOString()}
      WHERE key = 'default'
    `;

    console.log("✅ Imagem da seção Sobre atualizada para:", novaImagem);
    process.exit(0);
  } catch (err) {
    console.error("❌ Erro:", err.message);
    process.exit(1);
  }
}

atualizar();