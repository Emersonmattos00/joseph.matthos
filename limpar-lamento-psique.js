require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('🧹 Removendo duplicatas de Lamento e Psique Insana...\n');

  const album = await sql`SELECT id FROM albums WHERE title ILIKE '%Ainda Dá Tempo%'`;
  const albumId = album[0].id;

  // Busca todas as músicas do álbum
  const tracks = await sql`SELECT id, title, preview_key FROM tracks WHERE album_id = ${albumId} ORDER BY title ASC`;

  // Mapeamento: título que DEVE FICAR -> títulos que DEVEM SER DELETADOS
  const manter = new Set(['Lamento', 'Psique Insana']);
  
  let removidas = 0;

  for (const track of tracks) {
    // Se a música não está na lista das que devem ficar, e é uma variação de Lamento ou Psique Insana
    if (
      (track.title.toLowerCase().includes('lamento') && track.title !== 'Lamento') ||
      (track.title.toLowerCase().includes('psique') && track.title !== 'Psique Insana')
    ) {
      await sql`DELETE FROM tracks WHERE id = ${track.id}`;
      console.log(`🗑️ Removida: "${track.title}" (ID ${track.id})`);
      removidas++;
    }
  }

  console.log(`\n✅ ${removidas} duplicatas removidas.`);

  // Renumerar o álbum
  console.log('\n🔢 Renumerando o álbum "Ainda Dá Tempo"...');
  const restantes = await sql`SELECT id FROM tracks WHERE album_id = ${albumId} ORDER BY title ASC`;
  
  await sql`UPDATE tracks SET album_id = NULL WHERE album_id = ${albumId}`;
  
  for (let i = 0; i < restantes.length; i++) {
    await sql`UPDATE tracks SET album_id = ${albumId}, track_number = ${i + 1} WHERE id = ${restantes[i].id}`;
  }

  console.log(`   ✅ Renumerado de 1 a ${restantes.length}`);
  process.exit(0);
}

main().catch(console.error);
