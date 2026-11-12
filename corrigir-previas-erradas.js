const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento: ID da música -> Caminho correto do preview no R2
const correcoes = {
  // 1. "Só Ame" (Caminho, Direção) -> previews/so-ame.mp3
  '5d7c9442-22c1-46b1-8f05-b6eba48d11b6': 'previews/so-ame.mp3',

  // 3. "Só o Amor" (Espelho da Alma) -> previews/so-o-amor.mp3
  '7aa5197d-56b9-447c-b8a0-ae1ad64a4ead': 'previews/so-o-amor.mp3',

  // 4. "Eu Comigo" (Eu Comigo) -> previews/eu-comigo.mp3
  'be2716d9-59bd-4a63-96c9-e1a360481eaf': 'previews/eu-comigo.mp3',

  // 5. "O Ciclo" (Eu Comigo) -> previews/o-ciclo.mp3
  'b3946e33-1452-4032-88c6-b6cf441671ca': 'previews/o-ciclo.mp3',

  // 6. "Razão vs Coração" (Mentalidade de Ouro Vol. 2) -> previews/razao-vs-coracao.mp3
  'c127347e-7b91-459c-a6e4-f817b6425ebb': 'previews/razao-vs-coracao.mp3',

  // 7. "Sei Lá!?" (Mentalidade de Ouro Vol. 3) -> previews/sei-la.mp3
  '65c97343-988f-492f-b890-d6878615f231': 'previews/sei-la.mp3',

  // 8. "O Instante" (O Instante) -> previews/o-instante.mp3
  '05702046-fa0f-4344-9f33-b20848358829': 'previews/o-instante.mp3',

  // 9. "Ser ou Não" (O Instante) -> previews/ser-ou-nao-ser.mp3 (ou ser-nao-ser.mp3?)
  // ATENÇÃO: O título é "Ser ou Não", então o correto pode ser "ser-ou-nao.mp3".
  // Mas se o arquivo no R2 for "ser-nao-ser.mp3", ajuste aqui.
  '5959e6e9-0fa5-4e5c-9eed-2eb9e4f7816e': 'previews/ser-ou-nao-ser.mp3',
};

async function corrigir() {
  console.log("🔍 Corrigindo as prévias erradas...\n");
  let atualizados = 0;

  for (const [trackId, previewKey] of Object.entries(correcoes)) {
    const result = await sql`
      UPDATE tracks 
      SET preview_key = ${previewKey},
          preview_path = ${previewKey}
      WHERE id = ${trackId}
      RETURNING id, title, preview_key
    `;

    if (result.length > 0) {
      console.log(`✅ [Corrigido] "${result[0].title}" -> ${previewKey}`);
      atualizados++;
    } else {
      console.log(`❌ [Não encontrado] ID: ${trackId}`);
    }
  }

  console.log(`\n🎉 Concluído! ${atualizados} músicas corrigidas.`);
}

corrigir().catch(console.error);