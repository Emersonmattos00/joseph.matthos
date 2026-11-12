const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento manual: Título no banco -> Arquivo de preview no R2
const mapeamento = {
  "Eu Lamento": "previews/eu-lamento.mp3",
  "A Lógica da Consciência": "previews/a-logica-da-consciencia.mp3",
  "O Fechar Das Cortinas": "previews/o-fechar-das-cortinas.mp3", // ou o-fechar-das-cortinas-9.mp3
  "Psiquê Insana": "previews/psique-insana.mp3",
  "Fique Perto de Mim": "previews/fique-perto-de-mim.mp3",
  "Sociedade Melindrosa": "previews/sociedade-melindrosa.mp3",
  "Aquela Janela": "previews/aquela-janela.mp3",
  "A Vida Bela": "previews/a-vida-e-bela.mp3",
  "Factual Sonho": "previews/factual-sonho.mp3",
  "Saudosa Lembrança": "previews/saudosa-lembranca.mp3",
  "Ser Ou Não Ser": "previews/ser-ou-nao-ser.mp3",
  "Ah Deus!": "previews/ah-deus.mp3",
  "Incessante Inspiração": "previews/incessante-inspiracao.mp3",
  "Ilação": "previews/ilacao.mp3",
  "Pedra Meio Caminho": "previews/pedra-meio-caminho.mp3",
  "Rainha da Noite": "previews/rainha-da-noite.mp3",
  "Benefício do Amor": "previews/beneficio-do-amor.mp3",
  "Jornada": "previews/jornada.mp3",
  "20 Conquistar": "previews/20-conquistar.mp3",
  "Minha Preta": "previews/minha-preta.mp3",
  "Ser ou Não Ser": "previews/ser-ou-nao-ser.mp3",
  "Ninguém": "previews/ninguem.mp3",
  "Ser Ou Não Ser": "previews/ser-ou-nao-ser.mp3",
  "Meio do Tempo": "previews/meio-do-tempo.mp3",
  "Passo a Passo": "previews/passo-a-passo.mp3",
  "Razão vs Coração": "previews/razao-vs-coracao.mp3",
  "Uma Canção": "previews/uma-cancao.mp3",
  "Mentalidade de Ouro": "previews/mentalidade-de-ouro.mp3",
  "Ninguém?": "previews/ninguem..mp3",
  "Sei Lá!?": "previews/sei-la.mp3",
  "Traz de Volta": "previews/traz-de-volta.mp3",
  "Vida do Tempo": "previews/vida-do-tempo.mp3",
  "Hoje; Só Hoje": "previews/hoje-so-hoje.mp3",
  "Lua Molhada de Céu": "previews/lua-molhada-de-ceu.mp3",
  "Aqui Jaz Um Sentimento": "previews/aqui-jaz-um-sentimento.mp3", // ou -2.mp3
  "Será": "previews/sera.mp3",
  "A Questão É! Full": "previews/a-questao-e.mp3",
  "Sumidouro Social": "previews/sumidouro-social.mp3",
  "A Folha": "previews/a-folha.mp3",
  "Pressas Da Vida": "previews/pressoes-da-vida.mp3"
};

async function corrigir() {
  console.log("🔄 Corrigindo os 40 previews restantes...\n");
  const tracks = await sql`SELECT id, title FROM tracks`;
  let atualizados = 0;
  let falhas = [];

  for (const [tituloBanco, caminhoPreview] of Object.entries(mapeamento)) {
    const track = tracks.find(t => t.title === tituloBanco);
    
    if (!track) {
      console.log(`❌ Música "${tituloBanco}" não encontrada no banco.`);
      falhas.push(tituloBanco);
      continue;
    }

    await sql`UPDATE tracks SET preview_key = ${caminhoPreview} WHERE id = ${track.id}`;
    atualizados++;
    console.log(`✅ [Atualizado] "${track.title}" -> ${caminhoPreview}`);
  }

  console.log(`\n🎉 Concluído! ${atualizados} músicas corrigidas.`);
  if (falhas.length > 0) {
    console.log(`⚠️ ${falhas.length} falhas:`, falhas);
  }
}

corrigir().catch(console.error);