const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const sql = neon(process.env.DATABASE_URL);

async function listar() {
  console.log("🔍 Buscando todas as músicas com seus álbuns...\n");

  const rows = await sql`
    SELECT 
      t.id, 
      t.title, 
      a.title AS album_title, 
      t.stream_key, 
      t.preview_key
    FROM tracks t
    JOIN albums a ON t.album_id = a.id
    ORDER BY a.title, t.track_number
  `;

  console.log(`Total de músicas: ${rows.length}\n`);

  // Cria um CSV para abrir no Excel
  let csv = 'ID;Título;Álbum;Áudio Completo;Prévia\n';
  
  for (const row of rows) {
    const safeTitle = String(row.title || '').replace(/;/g, ',');
    const safeAlbum = String(row.album_title || '').replace(/;/g, ',');
    const safeStream = String(row.stream_key || '').replace(/;/g, ',');
    const safePreview = String(row.preview_key || '').replace(/;/g, ',');
    csv += `${row.id};${safeTitle};${safeAlbum};${safeStream};${safePreview}\n`;
  }

  fs.writeFileSync('relatorio-completo.csv', csv, 'utf-8');
  console.log('✅ Relatório salvo em "relatorio-completo.csv"\n');

  // Mostra no terminal os casos suspeitos (onde o preview não bate com o título)
  console.log('⚠️ Casos suspeitos (prévia não corresponde ao título):');
  const suspeitos = rows.filter(r => {
    const tituloNormalizado = String(r.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
    const previewNormalizado = String(r.preview_key || '').toLowerCase().replace('previews/', '').replace('.mp3', '').replace(/[^a-z0-9]/g, '');
    return tituloNormalizado && previewNormalizado && !previewNormalizado.includes(tituloNormalizado) && !tituloNormalizado.includes(previewNormalizado);
  });

  if (suspeitos.length === 0) {
    console.log('   Nenhum caso suspeito encontrado.');
  } else {
    console.table(suspeitos.map(s => ({
      id: s.id,
      titulo: s.title,
      album: s.album_title,
      preview: s.preview_key
    })));
  }
}

listar().catch(console.error);