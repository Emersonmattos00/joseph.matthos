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
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function main() {
  const previewFiles = await listAll('previews/');
  const previewMap = new Set(previewFiles.map(f => f.split('/').pop().replace('.mp3', '')));

  const tracks = await sql`SELECT id, title FROM tracks WHERE preview_key IS NULL`;
  console.log(`Músicas sem preview vinculado: ${tracks.length}\n`);

  for (const track of tracks) {
    const normalizedTitle = normalize(track.title);
    
    // Procura algum arquivo no B2 que "case" com o título
    const possiveis = previewFiles.filter(key => {
      const fileName = key.split('/').pop().replace('.mp3', '');
      return normalize(fileName).includes(normalizedTitle) || normalizedTitle.includes(normalize(fileName));
    });

    if (possiveis.length > 0) {
      console.log(`⚠️  "${track.title}" → encontrado no B2: ${possiveis[0]}`);
    } else {
      console.log(`❌ "${track.title}" → NÃO existe no B2`);
    }
  }
}

main().catch(console.error);