const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigir() {
  console.log("🔄 Buscando músicas para atualizar o preview_key...\n");
  
  // Puxa todas as músicas
  const tracks = await sql`SELECT id, stream_key, preview_key FROM tracks`;
  let atualizados = 0;

  for (const track of tracks) {
    if (!track.stream_key) continue;

    // Pega o nome do arquivo original (ex: jornada.mp3)
    const fileName = track.stream_key.split('/').pop();
    
    // Cria o caminho limpo do preview (ex: previews/jornada.mp3)
    const novoPreviewKey = `previews/${fileName}`;

    // Se o preview_key atual estiver vazio OU se ainda tiver aquele hash antigo, atualiza
    if (!track.preview_key || track.preview_key !== novoPreviewKey) {
      await sql`UPDATE tracks SET preview_key = ${novoPreviewKey} WHERE id = ${track.id}`;
      atualizados++;
    }
  }

  console.log(`✅ ${atualizados} músicas tiveram o preview_key atualizado para o padrão limpo!`);
}

corrigir().catch(console.error);
