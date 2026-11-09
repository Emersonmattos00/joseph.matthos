require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('🧹 Limpando duplicatas do álbum "Ainda Dá Tempo"...\n');

  const album = await sql`SELECT id, title FROM albums WHERE title ILIKE '%Ainda Dá Tempo%'`;

  if (album.length === 0) {
    console.log('❌ Álbum não encontrado.');
    process.exit(0);
  }

  const albumId = album[0].id;
  console.log(`💿 Álbum encontrado: ${album[0].title} (ID: ${albumId})\n`);

  const tracks = await sql`SELECT id, title FROM tracks WHERE album_id = ${albumId} ORDER BY title ASC`;
  console.log(`Total de faixas antes da limpeza: ${tracks.length}\n`);

  const vistos = new Set();
  let removidas = 0;

  for (const track of tracks) {
    const key = track.title.toLowerCase().trim();
    
    if (vistos.has(key)) {
      await sql`DELETE FROM tracks WHERE id = ${track.id}`;
      console.log(`🗑️ Removida duplicata: "${track.title}" (ID ${track.id})`);
      removidas++;
    } else {
      vistos.add(key);
    }
  }

  console.log(`\n✅ Limpeza concluída! ${removidas} duplicatas removidas.`);
  process.exit(0);
}

main().catch(console.error);