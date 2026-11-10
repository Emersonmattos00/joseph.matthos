require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('🔍 Buscando todas as músicas no banco...\n');
  
  // Puxa todas as músicas ordenadas por álbum (se tiver) e depois por título
  const tracks = await sql`
    SELECT id, title, stream_key, preview_key 
    FROM tracks 
    ORDER BY title
  `;

  console.log(`Total de músicas: ${tracks.length}\n`);
  console.log('='.repeat(80));
  
  // Cria um arquivo CSV para você abrir no Excel e corrigir
  const fs = require('fs');
  let csv = 'ID;Titulo Atual;Arquivo Original;Preview\n';

  for (const track of tracks) {
    // Mostra no terminal
    console.log(`Título: "${track.title}"`);
    console.log(`Arquivo: ${track.stream_key || '❌ Sem arquivo'}`);
    console.log('-'.repeat(80));

    // Adiciona ao CSV (substitui ponto e vírgula para não quebrar a formatação)
    const safeTitle = String(track.title || '').replace(/;/g, ',');
    const safeKey = String(track.stream_key || '').replace(/;/g, ',');
    const safePreview = String(track.preview_key || '').replace(/;/g, ',');
    csv += `${track.id};${safeTitle};${safeKey};${safePreview}\n`;
  }

  // Salva o arquivo
  fs.writeFileSync('lista-musicas.csv', csv, 'utf-8');
  console.log('\n✅ Relatório salvo no arquivo "lista-musicas.csv"');
}

main().catch(console.error);