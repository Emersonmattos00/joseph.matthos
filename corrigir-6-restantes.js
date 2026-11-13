const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function corrigir() {
  console.log("🔍 Corrigindo os 6 casos restantes...\n");

  let atualizados = 0;

  // === 1. "Triade" (Mentalidade de Ouro Vol. 4) -> Faixa 2 ===
  const [album4] = await sql`SELECT id FROM albums WHERE title ILIKE ${"%Mentalidade de Ouro Vol. 4%"} LIMIT 1`;
  if (album4) {
    await sql`UPDATE tracks SET track_number = -20 WHERE album_id = ${album4.id} AND title = ${"Triade"}`;
    await sql`UPDATE tracks SET track_number = 2, isrc = ${"QTE6EZ2638763"} WHERE album_id = ${album4.id} AND title = ${"Triade"}`;
    console.log(`✅ "Triade" (Vol. 4) -> Faixa 2, ISRC: QTE6EZ2638763`);
    atualizados++;
  }

  // === 2. "Momento" (Mentalidade de Ouro Vol. 5) -> Faixa 6 ===
  const [album5] = await sql`SELECT id FROM albums WHERE title ILIKE ${"%Mentalidade de Ouro Vol. 5%"} LIMIT 1`;
  if (album5) {
    // Move para número temporário e depois aplica
    await sql`UPDATE tracks SET track_number = -30 WHERE album_id = ${album5.id} AND title = ${"Momento"}`;
    await sql`UPDATE tracks SET track_number = 6, isrc = ${"QTE6F32600404"} WHERE album_id = ${album5.id} AND title = ${"Momento"}`;
    console.log(`✅ "Momento" (Vol. 5) -> Faixa 6, ISRC: QTE6F32600404`);
    atualizados++;
  }

  // === 3. "Mistico" (Mentalidade de Ouro Vol. 5) -> Faixa 10 ===
  if (album5) {
    await sql`UPDATE tracks SET track_number = -31 WHERE album_id = ${album5.id} AND title = ${"Mistico"}`;
    await sql`UPDATE tracks SET track_number = 10, isrc = ${"QTE6F32600408"} WHERE album_id = ${album5.id} AND title = ${"Mistico"}`;
    console.log(`✅ "Mistico" (Vol. 5) -> Faixa 10, ISRC: QTE6F32600408`);
    atualizados++;
  }

  // === 4. "A Vida Bela" (Mentalidade de Ouro Vol. 5) -> Faixa 13 ===
  if (album5) {
    await sql`UPDATE tracks SET track_number = -32 WHERE album_id = ${album5.id} AND title = ${"A Vida Bela"}`;
    await sql`UPDATE tracks SET track_number = 13, isrc = ${"QTE6F32600411"} WHERE album_id = ${album5.id} AND title = ${"A Vida Bela"}`;
    console.log(`✅ "A Vida Bela" (Vol. 5) -> Faixa 13, ISRC: QTE6F32600411`);
    atualizados++;
  }

  // === 5. "Pressas Da Vida" (Mentalidade de Ouro Vol. 5) -> Faixa 16 ===
  if (album5) {
    await sql`UPDATE tracks SET track_number = -33 WHERE album_id = ${album5.id} AND title = ${"Pressas Da Vida"}`;
    await sql`UPDATE tracks SET track_number = 16, isrc = ${"QTE6F32600414"} WHERE album_id = ${album5.id} AND title = ${"Pressas Da Vida"}`;
    console.log(`✅ "Pressas Da Vida" (Vol. 5) -> Faixa 16, ISRC: QTE6F32600414`);
    atualizados++;
  }

  // === 6. "Reflexão" (O Despertar) -> Faixa 11 ===
  const [albumDespertar] = await sql`SELECT id FROM albums WHERE title ILIKE ${"%O Despertar%"} LIMIT 1`;
  if (albumDespertar) {
    // Move "Vivendo a Reflexão" para 12 e "Reflexão" para 11
    await sql`UPDATE tracks SET track_number = -40 WHERE album_id = ${albumDespertar.id} AND title = ${"Reflexão"}`;
    await sql`UPDATE tracks SET track_number = 11, isrc = ${"QTE6HT2667684"} WHERE album_id = ${albumDespertar.id} AND title = ${"Reflexão"}`;
    console.log(`✅ "Reflexão" (O Despertar) -> Faixa 11, ISRC: QTE6HT2667684`);
    atualizados++;
  }

  console.log(`\n🎉 Concluído! ${atualizados} músicas corrigidas.`);
}

corrigir().catch(console.error);