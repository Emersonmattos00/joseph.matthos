require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');

const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('📀 Gerando relatório completo de músicas e previews...\n');

  // Busca todos os álbuns e suas músicas, ordenados por álbum e número da faixa
  const rows = await sql`
    SELECT 
      a.title AS album_title,
      t.title AS track_title,
      t.track_number,
      t.stream_key,
      t.preview_key
    FROM tracks t
    LEFT JOIN albums a ON t.album_id = a.id
    ORDER BY a.title ASC, t.track_number ASC
  `;

  // Agrupa por álbum
  const albuns = {};
  for (const row of rows) {
    const albumName = row.album_title || 'Sem Álbum / Single';
    if (!albuns[albumName]) albuns[albumName] = [];
    albuns[albumName].push(row);
  }

  let totalMusicas = 0;
  let totalComPreview = 0;
  let csvContent = 'Álbum;Nº;Música;Tem Preview?;Arquivo Original\n';

  for (const [albumName, tracks] of Object.entries(albuns)) {
    const comPreviewNoAlbum = tracks.filter(t => t.preview_key).length;
    
    console.log(`💿 ÁLBUM: ${albumName.toUpperCase()} (${tracks.length} faixas | ${comPreviewNoAlbum} com preview)`);
    console.log('-'.repeat(70));
    
    tracks.forEach((track) => {
      const temPreview = track.preview_key ? '✅' : '❌';
      const num = String(track.track_number || 0).padStart(2, '0');
      
      console.log(`${num}. [${temPreview}] ${track.track_title}`);
      
      // Adiciona ao CSV
      const safeAlbum = String(albumName).replace(/;/g, ',');
      const safeTrack = String(track.track_title).replace(/;/g, ',');
      const safeKey = String(track.stream_key || '').replace(/;/g, ',');
      csvContent += `${safeAlbum};${num};${safeTrack};${temPreview};${safeKey}\n`;
      
      totalMusicas++;
      if (track.preview_key) totalComPreview++;
    });
    console.log('\n');
  }

  // Salva o CSV
  fs.writeFileSync('relatorio-completo.csv', csvContent, 'utf-8');
  
  console.log('='.repeat(70));
  console.log(`📊 RESUMO GERAL:`);
  console.log(`Total de músicas: ${totalMusicas}`);
  console.log(`Músicas com preview: ${totalComPreview}`);
  console.log(`Músicas sem preview: ${totalMusicas - totalComPreview}`);
  console.log(`\n✅ Relatório CSV salvo em: "relatorio-completo.csv"`);
  
  process.exit(0);
}

main().catch(console.error);
