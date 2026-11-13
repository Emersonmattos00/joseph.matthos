const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento manual: Título no banco -> Arquivo real no R2 (premium/)
const mapeamento = {
  "Fé Indestrutível": "premium/alogicadaconsciencia/fe-indescritivel.mp3",
  "Acordado No Escuro": "premium/abismodocoracao/desperto-no-escuro.mp3",
  "Encarcerado": "premium/abismodocoracao/carcere.mp3",
  "Sentimento Sepultado": "premium/abismodocoracao/peleja.mp3", 
  "Família Ingrata": "premium/contraditorio/famlia-ingrata.mp3",
  "Meu Lugar No Mundo": "premium/nadaacabou/meu-mugar-no-mundo.mp3",
  "Ser Inocência": "premium/mardeinquiricoes/ser-crianca.mp3",
  "Gritos Silenciosos": "premium/mardeinquiricoes/gritos-gritados.mp3",
  "A Questão É! Full": "premium/mentalidadedeourov5/a-questao-e.mp3",
  "Pressas Da Vida": "premium/mentalidadedeourov5/pressoes-da-vida.mp3"
};

async function corrigir() {
  console.log("🔄 Corrigindo os áudios completos restantes...\n");
  
  const tracks = await sql`SELECT id, title FROM tracks`;
  let atualizados = 0;
  let falhas = [];

  for (const [tituloBanco, caminhoPremium] of Object.entries(mapeamento)) {
    const track = tracks.find(t => t.title === tituloBanco);
    
    if (!track) {
      console.log(`❌ Música "${tituloBanco}" não encontrada no banco.`);
      falhas.push(tituloBanco);
      continue;
    }

    // Atualiza tanto stream_key quanto full_path para garantir compatibilidade
    await sql`
      UPDATE tracks 
      SET stream_key = ${caminhoPremium}, 
          full_path = ${caminhoPremium}
      WHERE id = ${track.id}
    `;
    
    atualizados++;
    console.log(`✅ [Atualizado] "${track.title}" -> ${caminhoPremium}`);
  }

  console.log(`\n🎉 Concluído! ${atualizados} músicas corrigidas.`);
  
  if (falhas.length > 0) {
    console.log(`⚠️ ${falhas.length} falhas:`, falhas);
  }
}

corrigir().catch(console.error);