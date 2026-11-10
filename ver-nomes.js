require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);

async function run() {
  const tracks = await sql`SELECT title FROM tracks ORDER BY title ASC`;
  console.log(`Total: ${tracks.length} músicas\n`);
  
  tracks.forEach((t, i) => {
    console.log(`${i + 1}. ${t.title}`);
  });
  process.exit(0);
}
run();