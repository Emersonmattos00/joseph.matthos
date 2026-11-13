const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigirOrdem() {
  console.log("🔍 Corrigindo a ordem do álbum 'O Instante' conforme o Spotify...\n");

  const albumTitle = "O Instante";
  const [album] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${albumTitle}%`} LIMIT 1`;

  if (!album) {
    console.log("❌ Álbum não encontrado.");
    return;
  }

  // Nova ordem extraída da imagem do Spotify
  const novaOrdem = [
    { title: "Ânimo", isrc: "QRAUM2600037" },
    { title: "Ser ou Não", isrc: "QRAUM2600038" },
    { title: "Cotejo da Vida", isrc: "QRAUM2600039" },
    { title: "Vento", isrc: "QRAUM2600040" },
    { title: "Palmeirar Sabiá", isrc: "QRAUM2600041" },
    { title: "O Sentido", isrc: "QRAUM2600043" },
    { title: "Sonhar", isrc: "QRAUM2600044" },
    { title: "Maior", isrc: "QRAUM2600045" },
    { title: "A Lua Me Disse", isrc: "QRAUM2600046" },
    { title: "O Exórdio", isrc: "QRAUM2600032" },
    { title: "Queria Sonhar", isrc: "QRAUM2600033" },
    { title: "Brunas Vozes", isrc: "QRAUM2600034" },
    { title: "Vou Amar", isrc: "QRAUM2600035" },
    { title: "O Instante", isrc: "QRAUM2600036" },
    { title: "O Momento", isrc: "QRAUM2600042" }
  ];

  // 1. Move todas as faixas para números negativos (evita conflito)
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