require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const sql = neon(process.env.DATABASE_URL);
const client = new S3Client({
  region: process.env.B2_MEDIA_REGION || 'us-east-005',
  endpoint: process.env.B2_MEDIA_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  }
});

const BUCKET = process.env.B2_AUDIO_BUCKET || 'josephmatthos';

function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log('🔍 Buscando todos os arquivos de preview no B2...');
  
  // Pega todos os arquivos da pasta previews
  const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'previews/' }));
  const previewFiles = (res.Contents || []).map(o => o.Key);
  
  console.log(`Encontrados ${previewFiles.length} arquivos de preview no B2.\n`);

  // Pega todas as músicas do banco
  const tracks = await sql`SELECT id, title FROM tracks`;
  console.log(`Analisando ${tracks.length} músicas no banco...\n`);

  let vinculados = 0;

  for (const track of tracks) {
    const normTitle = normalize(track.title);
    
    // Tenta achar um preview que contenha o título normalizado
    const matchedKey = previewFiles.find(key => {
      const fileName = key.split('/').pop();
      return normalize(fileName).includes(normTitle);
    });

    if (matchedKey) {
      await sql`UPDATE tracks SET preview_key = ${matchedKey} WHERE id = ${track.id}`;
      console.log(`✅ ${track.title} -> ${matchedKey}`);
      vinculados++;
    }
  }

  console.log(`\n🎉 Concluído! ${vinculados} previews vinculados.`);
  process.exit(0);
}

main().catch(console.error);