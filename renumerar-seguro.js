require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('🧹 Iniciando renumeração segura...\n');

  const albums = await sql`SELECT id, title FROM albums ORDER BY title ASC`;

  for (const album of albums) {
    console.log(`💿 Processando: ${album.title}`);

    const tracks = await sql`SELECT id, title FROM tracks WHERE album_id = ${album.id} ORDER BY title ASC`;

    if (tracks.length === 0) {
      console.log('   (sem faixas)\n');
      continue;
    }

    // Desvincula temporariamente para evitar o erro de constraint
    await sql`UPDATE tracks SET album_id = NULL WHERE album_id = ${album.id}`;

    // Renumera e revincula
    for (let i = 0; i < tracks.length; i++) {
      await sql`
        UPDATE tracks 
        SET album_id = ${album.id}, track_number = ${i + 1} 
        WHERE id = ${tracks[i].id}
      `;
    }

    console.log(`   ✅ Renumerado de 1 a ${tracks.length}\n`);
  }

  console.log('🎉 Renumeração concluída com sucesso!');
  process.exit(0);
}

main().catch(console.error);