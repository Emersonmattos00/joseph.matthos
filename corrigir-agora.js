require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

const correcoes = {
  'Hojesohoje': 'Hoje; Só Hoje',
  'Luamolhadadeceu': 'Lua Molhada de Céu',
  'Meiodotempo': 'Meio do Tempo',
  'Passoa Passo': 'Passo a Passo',
  'PassoaPasso': 'Passo a Passo',
  'Sei La': 'Sei Lá!',
  'SeiLa': 'Sei Lá!',
  'Vidadotempo': 'Vida do Tempo'
};

async function run() {
  console.log('🧹 Buscando e corrigindo títulos...\n');
  let c = 0;

  for (const [errado, certo] of Object.entries(correcoes)) {
    // Usa ILIKE para ignorar maiúsculas/minúsculas e buscar o nome exato
    const res = await sql`UPDATE tracks SET title = ${certo} WHERE title ILIKE ${errado}`;
    
    if (res.count > 0 || res.length > 0) {
      console.log(`✅ Corrigido: "${errado}" -> "${certo}"`);
      c++;
    } else {
      // Se não achou exato, tenta buscar qualquer coisa parecida
      const fallback = await sql`UPDATE tracks SET title = ${certo} WHERE title ILIKE ${'%' + errado + '%'}`;
      if (fallback.count > 0 || fallback.length > 0) {
        console.log(`✅ Corrigido (busca parcial): "${errado}" -> "${certo}"`);
        c++;
      } else {
        console.log(`❌ Não encontrado: "${errado}"`);
      }
    }
  }

  console.log(`\n🎉 Fim! ${c} títulos corrigidos.`);
  process.exit(0);
}

run();