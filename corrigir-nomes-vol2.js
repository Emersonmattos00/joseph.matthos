const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigir() {
  console.log("🔄 Corrigindo nomes das músicas no Vol. 2...");
  
  // 1. Corrige "Ser Ou Não Ser" para "Eis a Questão!"
  await sql`
    UPDATE tracks 
    SET title = ${"Eis a Questão!"} 
    WHERE title = ${"Ser Ou Não Ser"} 
    AND album_id = (SELECT id FROM albums WHERE title ILIKE ${"%Mentalidade de Ouro Vol. 2%"})
  `;
  console.log("✅ 'Ser Ou Não Ser' -> 'Eis a Questão!'");

  // 2. Corrige "Inversodevalores" para "Inversão de Valores"
  await sql`
    UPDATE tracks 
    SET title = ${"Inversão de Valores"} 
    WHERE title = ${"Inversodevalores"} 
    AND album_id = (SELECT id FROM albums WHERE title ILIKE ${"%Mentalidade de Ouro Vol. 2%"})
  `;
  console.log("✅ 'Inversodevalores' -> 'Inversão de Valores'");

  // 3. Lista as músicas do álbum para verificar os previews
  console.log("\n🎵 Verificando as faixas do Mentalidade de Ouro Vol. 2:\n");
  
  const tracks = await sql`
    SELECT t.title, t.stream_key, t.preview_key 
    FROM tracks t
    JOIN albums a ON t.album_id = a.id
    WHERE a.title ILIKE ${"%Mentalidade de Ouro Vol. 2%"}
    ORDER BY t.track_number ASC
  `;

  console.table(tracks);
}

corrigir().catch(console.error);