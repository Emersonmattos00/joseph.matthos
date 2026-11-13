const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigirOrdem() {
  console.log("🔍 Corrigindo a ordem do álbum 'Ainda Dá Tempo' conforme o Spotify...\n");

  const albumTitle = "Ainda Dá Tempo";
  const [album] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${albumTitle}%`} LIMIT 1`;

  if (!album) {
    console.log("❌ Álbum não encontrado.");
    return;
  }

  // Nova ordem extraída dos prints do Spotify
  const novaOrdem = [
    { title: "Servo", isrc: "QRAUM2600019" },
    { title: "Apreensivo", isrc: "QRAUM2600020" },
    { title: "Ainda Dá Tempo", isrc: "QRAUM2600022" },
    { title: "Aqui Jaz Um Sentimento", isrc: "QRAUM2600025" },
    { title: "Ciclo", isrc: "QRAUM2600021" },
    { title: "Psiquê Insana", isrc: "QRAUM2600023" },
    { title: "Pra Amar", isrc: "QRAUM2600024" },
    { title: "O Fechar Das Cortinas", isrc: "QRAUM2600026" },
    { title: "Loucura Sana", isrc: "QRAUM2600027" },
    { title: "Eu Lamento", isrc: "QRAUM2600028" },
    { title: "Saudade De Você", isrc: "QRAUM2600029" }
  ];

  // 1. Move todas as faixas para números negativos (para evitar conflito)
  await sql`UPDATE tracks SET track_number = -track_number WHERE album_id = ${album.id}`;

  // 2. Aplica a nova ordem e os ISRCs
  for (let i = 0; i < novaOrdem.length; i++) {
    const faixa = novaOrdem[i];
    const novoTrackNumber = i + 1;

    const res = await sql`
      UPDATE tracks 
      SET track_number = ${novoTrackNumber}, 
          isrc = ${faixa.isrc}
      WHERE album_id = ${album.id} 
      AND title ILIKE ${`%${faixa.title}%`}
      RETURNING id, title, track_number
    `;

    if (res.length > 0) {
      console.log(`✅ ${novoTrackNumber}. ${res[0].title}`);
    } else {
      console.log(`⚠️ Não encontrada: "${faixa.title}"`);
    }
  }

  console.log("\n🎉 Concluído!");
}

corrigirOrdem().catch(console.error);