require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('🧹 Removendo duplicatas exatas (mantendo Eu Lamento e Psiquê Insana)...\n');

  const album = await sql`SELECT id FROM albums WHERE title ILIKE '%Ainda Dá Tempo%'`;
  const albumId = album[0].id;

  // Busca todas as músicas do álbum
  const tracks = await sql`SELECT id, title FROM tracks WHERE album_id = ${albumId} ORDER BY title ASC`;

  console.log(`Total de faixas antes: ${tracks.length}\n`);

  // Títulos exatos que NÃO devem ficar (remover)
  const removerTitulos = [
    'Lamento',
    'Psique Insana'
  ];

  let removidas = 0;

  for (const track of tracks) {
    if (removerTitulos.includes(track.title)) {
      await sql`DELETE FROM tracks WHERE id = ${track.id}`;
      console.log(`🗑️ Removida: "${track.title}"`);
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
  
  // Mostra a lista final
  console.log('\n📀 Faixas finais do álbum:');
  const finais = await sql`SELECT title FROM tracks WHERE album_id = ${albumId} ORDER BY track_number ASC`;
  finais.forEach((t, i) => console.log(`   ${i + 1}. ${t.title}`));

  process.exit(0);
}

main().catch(console.error);
