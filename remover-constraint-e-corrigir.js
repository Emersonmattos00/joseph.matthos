const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

// Mapeamento de TODOS os álbuns com as ordens corretas (Spotify/DistroKid)
const dados = {
  "O Instante": [
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
  ]
};

async function removerConstraint() {
  console.log("🔧 Removendo constraint de unicidade...");
  try {
    // Busca o nome da constraint
    const constraints = await sql`
      SELECT conname FROM pg_constraint 
      WHERE conrelid = 'tracks'::regclass AND contype = 'u'
    `;
    
    for (const row of constraints) {
      console.log(`   Removendo: ${row.conname}`);
      // Usa a tag sql diretamente com a string interpolada
      await sql`ALTER TABLE tracks DROP CONSTRAINT IF EXISTS ${sql.unsafe ? sql.unsafe(row.conname) : row.conname}`;
    }
    console.log("✅ Constraint removida!");
  } catch (err) {
    console.log("⚠️ Erro ao remover constraint:", err.message);
    // Se falhar, continua mesmo assim
  }
}

async function corrigirOrdem() {
  console.log("\n🔍 Corrigindo ordens...\n");

  for (const [albumTitle, tracks] of Object.entries(dados)) {
    console.log(`🎵 Álbum: ${albumTitle}`);
    
    const [album] = await sql`SELECT id FROM albums WHERE title ILIKE ${`%${albumTitle}%`} LIMIT 1`;
    if (!album) {
      console.log(`   ❌ Álbum não encontrado.`);
      continue;
    }

    // Move todas as faixas para números negativos (evita conflito)
    await sql`UPDATE tracks SET track_number = -track_number WHERE album_id = ${album.id}`;

    // Aplica a nova ordem
    for (let i = 0; i < tracks.length; i++) {
      const { title, isrc } = tracks[i];
      const novoTrackNumber = i + 1;
      
      try {
        const res = await sql`
          UPDATE tracks 
          SET track_number = ${novoTrackNumber}, isrc = ${isrc}
          WHERE album_id = ${album.id} AND title ILIKE ${`%${title}%`}
          RETURNING title
        `;
        if (res.length > 0) {
          console.log(`   ✅ ${novoTrackNumber}. ${res[0].title}`);
        } else {
          console.log(`   ⚠️ Não encontrada: "${title}"`);
        }
      } catch (err) {
        console.log(`   ❌ Erro em "${title}": ${err.message}`);
      }
    }
    console.log("");
  }

  console.log("🎉 Concluído!");
}

async function main() {
  await removerConstraint();
  await corrigirOrdem();
}

main().catch(console.error);
