const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const sql = neon(process.env.DATABASE_URL);

async function verificar() {
  console.log("🔍 Verificando a ordem das músicas em todos os álbuns...\n");

  const rows = await sql`
    SELECT 
      a.title AS album_title,
      t.track_number,
      t.title AS track_title
    FROM albums a
    LEFT JOIN tracks t ON t.album_id = a.id
    ORDER BY a.title, t.track_number
  `;

  // Agrupa por álbum
  const albums = {};
  for (const row of rows) {
    if (!albums[row.album_title]) {
      albums[row.album_title] = [];
    }
    if (row.track_title) {
      albums[row.album_title].push({
        track_number: row.track_number,
        title: row.track_title
      });
    }
  }

  // Gera o CSV
  let csv = "Álbum;Faixa;Título\n";
  for (const [albumTitle, tracks] of Object.entries(albums)) {
    for (const track of tracks) {
      csv += `"${albumTitle}";"${track.track_number}";"${track.title}"\n`;
    }
  }
  fs.writeFileSync("verificacao-ordem.csv", csv, "utf-8");
  console.log("✅ Relatório salvo em: verificacao-ordem.csv\n");

  // Mostra no terminal
  for (const [albumTitle, tracks] of Object.entries(albums)) {
    console.log(`\n🎵 ${albumTitle} (${tracks.length} faixas)`);
    for (const track of tracks) {
      console.log(`   ${String(track.track_number).padStart(2, '0')}. ${track.title}`);
    }
  }

  console.log("\n🎉 Concluído!");
}

verificar().catch(console.error);