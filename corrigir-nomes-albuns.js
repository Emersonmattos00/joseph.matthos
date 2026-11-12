const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigir() {
  console.log("🔍 Corrigindo nomes e álbuns das músicas...\n");

  // 1. Corrigir "Ser Ou Não Ser" no Vol. 1 para "Ser Não Ser" (se for o caso)
  await sql`
    UPDATE tracks 
    SET title = ${"Ser Não Ser"}
    WHERE title = ${"Ser Ou Não Ser"} 
    AND album_id = (SELECT id FROM albums WHERE title ILIKE ${"%Mentalidade de Ouro Vol. 1%"})
  `;
  console.log("✅ 'Ser Ou Não Ser' (Vol. 1) -> 'Ser Não Ser'");

  // 2. Corrigir "Ser ou Não Ser" no álbum Intima Relação
  await sql`
    UPDATE tracks 
    SET title = ${"Ser ou Não Ser"}
    WHERE title = ${"Ser Ou Não Ser"} 
    AND album_id = (SELECT id FROM albums WHERE title ILIKE ${"%Intima Relação%"})
  `;
  console.log("✅ 'Ser Ou Não Ser' (Intima Relação) -> 'Ser ou Não Ser'");

  // 3. Listar para verificar
  console.log("\n🎵 Verificando músicas 'Ser...':");
  const tracks = await sql`
    SELECT t.title, a.title as album_title
    FROM tracks t
    JOIN albums a ON t.album_id = a.id
    WHERE t.title ILIKE ${"%Ser%"} AND (t.title ILIKE ${"%Não Ser%"} OR t.title ILIKE ${"%Nao Ser%"})
    ORDER BY a.title
  `;
  
  console.table(tracks);
}

corrigir().catch(console.error);