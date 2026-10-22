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

// CORREÇÃO: Usa o bucket de ÁUDIO (josephmatthos), não o de imagens (joseph.matthos)
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
  console.log(`🔗 Vinculando previews do bucket "${BUCKET}"...`);

  // CORREÇÃO: A pasta "previews" está na raiz do bucket, não dentro de "josephmatthos/"
  const previewFiles = await listAll('previews/');
  console.log(`Encontrados ${previewFiles.length} arquivos de preview no B2.`);

  if (previewFiles.length === 0) {
    console.log('⚠️  Nenhum arquivo encontrado. Verifique se o B2_AUDIO_BUCKET está correto.');
    return;
  }

  // Exibe os primeiros 3 arquivos para debug
  console.log('Exemplos:', previewFiles.slice(0, 3));

  const tracks = await sql`SELECT id, title FROM tracks`;
  let vinculados = 0;

  for (const track of tracks) {
    const normalizedTitle = normalize(track.title);
    
    // Procura no B2 um preview que contenha o título da música
    const matchedKey = previewFiles.find(key => {
      const fileName = key.split('/').pop().replace('.mp3', '');
      return normalize(fileName).includes(normalizedTitle);
    });

    if (matchedKey) {
      // CORREÇÃO: Salva a chave sem o prefixo do bucket (o backend adiciona depois)
      await sql`UPDATE tracks SET preview_key = ${matchedKey} WHERE id = ${track.id}`;
      console.log(`✅ ${track.title} -> ${matchedKey}`);
      vinculados++;
    } else {
      console.log(`❌ ${track.title}`);
    }
  }

  console.log(`\n🎉 Concluído! ${vinculados} previews vinculados.`);
}

main().catch(console.error);