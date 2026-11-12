const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento dos ISRCs faltantes (extraídos dos seus prints)
const dados = {
  "Ainda Dá Tempo": [
    { title: "Ainda Dá Tempo", isrc: "QRAUM2600022" },
    { title: "Apreensivo", isrc: "QRAUM2600020" },
    { title: "Aqui Jaz Um Sentimento", isrc: "QRAUM2600025" },
    { title: "Ciclo", isrc: "QRAUM2600021" },
    { title: "Eu Lamento", isrc: "QRAUM2600028" },
    { title: "Loucura Sana", isrc: "QRAUM2600027" },
    { title: "O Fechar Das Cortinas", isrc: "QRAUM2600026" },
    { title: "Pra Amar", isrc: "QRAUM2600024" },
    { title: "Psiquê Insana", isrc: "QRAUM2600023" },
    { title: "Saudade De Você", isrc: "QRAUM2600029" },
    { title: "Servo", isrc: "QRAUM2600019" }
  ],
  "Apocalipse da Emoção": [
    { title: "A Velha", isrc: "QRAUM2600055" },
    { title: "Apocalipse da Emoção", isrc: "QRAUM2600052" },
    { title: "Começo, Meio e Fim", isrc: "QRAUM2600060" },
    { title: "Comigo Mesmo", isrc: "QRAUM2600063" },
    { title: "Final", isrc: "QRAUM2600056" },
    { title: "Idílio", isrc: "QRAUM2600062" },
    { title: "Mar", isrc: "QRAUM2600057" },
    { title: "Morrer Vivendo", isrc: "QRAUM2600054" },
    { title: "Quem Ama Vive", isrc: "QRAUM2600061" },
    { title: "Quem Vai Responder", isrc: "QRAUM2600058" },
    { title: "Tormenta", isrc: "QRAUM2600053" },
    { title: "Viver Morrendo", isrc: "QRAUM2600059" }
  ]
};

async function preencher() {
  console.log("🔍 Preenchendo ISRCs faltantes...\n");

  let atualizados = 0;
  let naoEncontrados = 0;

  for (const [albumTitle, tracks] of Object.entries(dados)) {
    console.log(`\n🎵 Álbum: ${albumTitle}`);

    // Busca o ID do álbum
    const [album] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${albumTitle}%`} LIMIT 1`;
    if (!album) {
      console.log(`   ❌ Álbum não encontrado. Pulando.`);
      continue;
    }

    for (const { title, isrc } of tracks) {
      try {
        const res = await sql`
          UPDATE tracks 
          SET isrc = ${isrc}
          WHERE album_id = ${album.id} 
          AND title ILIKE ${`%${title}%`}
          RETURNING id, title
        `;

        if (res.length > 0) {
          console.log(`   ✅ "${res[0].title}" -> ISRC: ${isrc}`);
          atualizados++;
        } else {
          console.log(`   ⚠️ Não encontrada: "${title}"`);
          naoEncontrados++;
        }
      } catch (err) {
        console.log(`   ❌ Erro em "${title}": ${err.message}`);
        naoEncontrados++;
      }
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído!`);
  console.log(`✅ Músicas atualizadas: ${atualizados}`);
  console.log(`⚠️ Não encontradas: ${naoEncontrados}`);
}

preencher().catch(console.error);
