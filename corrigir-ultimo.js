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

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log('🔍 Buscando previews no B2...');
  const previewFiles = await listAll('previews/');
  
  // Pega todas as músicas que têm preview_key
  const tracks = await sql`SELECT id, title, preview_key FROM tracks WHERE preview_key IS NOT NULL`;
  
  let corrigidos = 0;

  for (const track of tracks) {
    // Se o preview_key atual existe no B2, pula
    if (previewFiles.includes(track.preview_key)) continue;

    // Se não existe, tenta achar um preview com nome parecido
    const normTitle = normalize(track.title);
    const matchedKey = previewFiles.find(key => {
      const fileName = key.split('/').pop();
      return normalize(fileName).includes(normTitle) || normTitle.includes(normalize(fileName));
    });

    if (matchedKey) {
      console.log(`🔧 Corrigindo preview: "${track.title}"`);
      console.log(`   De: ${track.preview_key}`);
      console.log(`   Para: ${matchedKey}`);
      await sql`UPDATE tracks SET preview_key = ${matchedKey} WHERE id = ${track.id}`;
      corrigidos++;
    } else {
      console.log(`❌ Não achei preview para: ${track.title} (atual: ${track.preview_key})`);
    }
  }

  console.log(`\n🎉 Concluído! ${corrigidos} previews corrigidos.`);
  process.exit(0);
}

main().catch(console.error);