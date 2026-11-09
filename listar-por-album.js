require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');

const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('📀 Buscando álbuns e músicas...\n');

  // Busca todos os álbuns e suas músicas relacionadas
  const rows = await sql`
    SELECT 
      a.title AS album_title,
      a.id AS album_id,
      t.title AS track_title,
      t.id AS track_id,
      t.stream_key,
      t.preview_key
    FROM tracks t
    LEFT JOIN albums a ON t.album_id = a.id
    ORDER BY a.title ASC, t.track_number ASC, t.title ASC
  `;

  // Agrupa as músicas por álbum
  const albuns = {};
  for (const row of rows) {
    const albumName = row.album_title || 'Sem Álbum / Single';
    if (!albuns[albumName]) {
      albuns[albumName] = [];
    }
    albuns[albumName].push(row);
  }

  let csvContent = 'Álbum;Música;Tem Preview?;Arquivo Original\n';

  // Imprime no terminal de forma organizada
  for (const [albumName, tracks] of Object.entries(albuns)) {
    console.log(`💿 ÁLBUM: ${albumName.toUpperCase()} (${tracks.length} faixas)`);
    console.log('-'.repeat(60));
    
    tracks.forEach((track, index) => {
      const temPreview = track.preview_key ? '✅' : '❌';
      const numFormatado = String(index + 1).padStart(2, '0');
      
      console.log(`${numFormatado}. [${temPreview}] ${track.track_title}`);
      
      // Adiciona ao CSV
      const safeAlbum = String(albumName).replace(/;/g, ',');
      const safeTrack = String(track.track_title).replace(/;/g, ',');
      const safeKey = String(track.stream_key || '').replace(/;/g, ',');
      csvContent += `${safeAlbum};${safeTrack};${temPreview};${safeKey}\n`;
    });
    console.log('\n');
  }

  // Salva a versão CSV para abrir no Excel
  fs.writeFileSync('musicas-por-album.csv', csvContent, 'utf-8');
  console.log('✅ Relatório completo salvo em: "musicas-por-album.csv"');
  
  process.exit(0);
}

main().catch(console.error);