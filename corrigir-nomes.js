require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// Mapeamento manual dos nomes bagunçados para os nomes corretos
// Baseado no que vimos no banco (Mentalidade de Ouro Vol. 1 e alguns outros)
const correcoes = {
  // Mentalidade de Ouro Vol. 1
  '20conquistarqt 6ey 2677079': '20 Conquistar',
  'Jornadaqt 6ey 2677081': 'Jornada',
  'Minhapretaqt 6ey 2677079': 'Minha Preta',
  'Ninguemqt 6ey 2677080': 'Ninguém',
  'Sernaoserqt 6ey 2677077': 'Ser Não Ser',

  // Outros nomes que podem ter vindo com código
  'Sernaoser.esp': 'Ser Não Ser',
  'Ser Naoser.esp': 'Ser Não Ser',
  
  // Nomes com espaços duplos ou pontuação estranha
  'Palmeirar  Sabiá': 'Palmeirar Sabiá', // Remove espaço duplo
  
  // Nomes que estão em minúsculo ou sem formatação
  'Saiba Mais': 'Saiba Mais', // (exemplo)
};

async function main() {
  console.log('🧹 Corrigindo nomes específicos de músicas...');

  const tracks = await sql`SELECT id, title FROM tracks`;
  let corrigidos = 0;

  for (const track of tracks) {
    const original = track.title;
    let novo = original;

    // 1. Verifica se o título está no mapeamento manual
    if (correcoes[original]) {
      novo = correcoes[original];
    } 
    // 2. Se não estiver, aplica uma limpeza leve apenas em códigos óbvios
    else {
      // Remove códigos como "qt 6ey 2677079" ou ".esp" (mas só se existirem)
      novo = original
        .replace(/\s*qt\s*\d+.*$/i, '') // Remove "qt 6ey ..."
        .replace(/\.esp$/i, '')          // Remove ".esp" no final
        .replace(/\s+/g, ' ')            // Remove espaços duplos
        .trim();
      
      // Se o nome ficou vazio ou muito curto, volta o original
      if (novo.length < 2) novo = original;
    }

    if (novo !== original) {
      await sql`UPDATE tracks SET title = ${novo} WHERE id = ${track.id}`;
      console.log(`✅ "${original}" -> "${novo}"`);
      corrigidos++;
    }
  }

  console.log(`\n🎉 Concluído! ${corrigidos} nomes corrigidos.`);
}

main().catch(console.error);