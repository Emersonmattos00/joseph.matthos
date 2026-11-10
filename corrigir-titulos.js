require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

// Mapeamento manual dos casos mais críticos
const correcoesManuais = {
  'jornadaqt6ey2677081': 'Jornada',
  'minhapretaqt6ey2677079': 'Minha Preta',
  'ninguemqt6ey2677080': 'Ninguém',
  'sernaoserqt6ey2677077': 'Ser, Não Ser',
  '20conquistarqt6ey2677079': '20 Conquistar',
  'SerNaoser.Esp': 'Ser ou Não Ser',
  'eulamento': 'Eu Lamento',
  'ofechardascortinas': 'O Fechar das Cortinas',
  'psiqueinsana': 'Psique Insana',
  'saudadedevoce': 'Saudade de Você',
  'Aquelajanela': 'Aquela Janela',
  'BenefíciodoAmor': 'Benefício do Amor',
  'FactualSonho': 'Factual Sonho',
  'FiquePertodeMim': 'Fique Perto de Mim',
  'PressaesdaVida': 'Pressões da Vida',
  'Razaovs.Coracao': 'Razão vs. Coração',
  'SaudosaLembrança': 'Saudosa Lembrança',
  'SumidouroSocial': 'Sumidouro Social',
  'IncessanteInspiracao': 'Incessante Inspiração',
  'Areia  Lua e Mar': 'Areia, Lua e Mar',
  'Palmeirar  Sabiá': 'Palmeirar Sabiá',
  'Ser; Não ser': 'Ser; Não Ser',
  'Será !': 'Será!',
  'Será': 'Será?',
  'Ilação': 'Ilação',
  'História': 'História Infinita',
  'Instante do Momento': 'Instante do Momento',
  'O Despertar': 'O Despertar da Consciência',
  'Modo de Viver': 'Modo de Viver',
  'Limite da Imaginação': 'Limite da Imaginação',
  'Quem Ama Vive': 'Quem Ama Vive',
  'Sonhar Insano': 'Sonhar Insano',
  'Velho Homem': 'Velho Homem',
  'Único, Singular': 'Único, Singular',
  'Olhos de Prazer': 'Olhos de Prazer',
  'Pra Amar': 'Pra Amar',
  'Quem Ama Vive': 'Quem Ama Vive',
  'Onde Estou': 'Onde Estou',
  'UmLindoMomento': 'Um Lindo Momento',
  'Ainda há Sonhos': 'Ainda há Sonhos',
  'Sociedade Melindroso': 'Sociedade Melindrosa',
  'A Mente é Livre': 'A Mente é Livre',
  'Viver na Verdade': 'Viver na Verdade',
  'Favela Viva': 'Favela Viva',
};

// Função para separar palavras grudadas (CamelCase)
function separarCamelCase(str) {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

async function main() {
  console.log('🧹 Corrigindo títulos...\n');
  
  const tracks = await sql`SELECT id, title FROM tracks`;
  let corrigidos = 0;

  for (const track of tracks) {
    let novo = track.title;
    const original = track.title;

    // 1. Verifica se está no mapeamento manual
    if (correcoesManuais[original]) {
      novo = correcoesManuais[original];
    } else {
      // 2. Remove códigos "qt 6ey..." e ".esp"
      novo = novo.replace(/\s*qt\s*\d+.*$/i, '').replace(/\.esp$/i, '');
      
      // 3. Corrige CamelCase (BenefícioDoAmor -> Benefício Do Amor)
      novo = separarCamelCase(novo);
      
      // 4. Remove espaços duplos
      novo = novo.replace(/\s+/g, ' ');
      
      // 5. Remove pontos finais e vírgulas no final
      novo = novo.replace(/[.,;!?]+$/, '');
      
      // 6. Capitaliza a primeira letra de cada palavra
      novo = novo.split(' ').map(word => {
        if (!word) return '';
        if (word.length === 1) return word.toUpperCase();
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      }).join(' ');
      
      // 7. Corrige palavras específicas que ficaram estranhas
      novo = novo.replace(/\bVs\b/gi, 'vs.');
    }

    // Se mudou, atualiza
    if (novo !== original) {
      await sql`UPDATE tracks SET title = ${novo} WHERE id = ${track.id}`;
      console.log(`✅ "${original}" -> "${novo}"`);
      corrigidos++;
    }
  }

  console.log(`\n🎉 Concluído! ${corrigidos} títulos corrigidos.`);
  console.log('\nExecute o script "vincular-previews.js" novamente para religar os previews com os novos nomes.');
}

main().catch(console.error);