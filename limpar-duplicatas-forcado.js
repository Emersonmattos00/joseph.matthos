require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('🧹 Buscando e removendo duplicatas (modo forçado)...\n');

  // Pega todas as músicas, ordenadas por álbum e título
  const tracks = await sql`SELECT id, title, album_id, preview_key FROM tracks ORDER BY album_id, title ASC`;

  const vistos = new Set();
  let removidas = 0;

  for (const track of tracks) {
    // Cria uma chave única para cada música: album_id + título normalizado
    const key = `${track.album_id}|${track.title.toLowerCase().trim()}`;

    if (vistos.has(key)) {
      // Se já vimos essa música, é duplicata. Verifica se a que já está salva tem preview
      // Se a duplicata atual tiver preview e a salva não, troca (mantém a melhor)
      
      // Simplificando: só deleta a duplicata
      await sql`DELETE FROM tracks WHERE id = ${track.id}`;
      console.log(`🗑️ Removida duplicata: "${track.title}" (ID ${track.id})`);
      removidas++;
    } else {
      vistos.add(key);
    }
  }

  console.log(`\n🎉 Concluído! ${removidas} músicas duplicadas removidas.`);
  
  // Agora renumera cada álbum de 1 a X
  console.log('\n🔢 Renumerando as faixas...');
  const albums = await sql`SELECT id, title FROM albums`;
  
  for (const album of albums) {
    const albumTracks = await sql`SELECT id FROM tracks WHERE album_id = ${album.id} ORDER BY title ASC`;
    
    for (let i = 0; i < albumTracks.length; i++) {
      await sql`UPDATE tracks SET track_number = ${i + 1} WHERE id = ${albumTracks[i].id}`;
    }
    console.log(`   ✅ ${album.title}: renumerado de 1 a ${albumTracks.length}`);
  }

  process.exit(0);
}

main().catch(console.error);
