require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { parseBuffer } = require('music-metadata');

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

const BUCKET = process.env.B2_MEDIA_BUCKET;

// Função para normalizar texto (tira acentos, espaços e deixa minúsculo)
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

async function getAudioDuration(key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    const metadata = await parseBuffer(buffer, 'audio/mpeg');
    return Math.round(metadata.format.duration);
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('🔍 Buscando todos os arquivos de áudio no Backblaze B2...');
  const b2Files = await listAll(''); // Lista tudo do bucket
  console.log(`Total de arquivos no B2: ${b2Files.length}`);

  const tracks = await sql`SELECT id, title, stream_key FROM tracks WHERE duration_seconds IS NULL OR duration_seconds = 0`;
  console.log(`Faixas sem duração no banco: ${tracks.length}\n`);

  let atualizados = 0;

  for (const track of tracks) {
    if (!track.stream_key) continue;

    // Pega o nome do arquivo real do banco (ex: pesodacaneta/A Prisão.mp3)
    const fileName = track.stream_key.split('/').pop();
    const normalizedTarget = normalize(fileName.replace('.mp3', ''));

    // Procura no B2 um arquivo com o nome normalizado igual
    const matchedKey = b2Files.find(key => {
      if (!key.endsWith('.mp3') && !key.endsWith('.wav') && !key.endsWith('.m4a')) return false;
      const b2FileName = key.split('/').pop();
      return normalize(b2FileName.replace(/\.(mp3|wav|m4a)$/, '')) === normalizedTarget;
    });

    if (!matchedKey) {
      console.log(`❌ Arquivo não encontrado no B2 para: ${track.title} (${fileName})`);
      continue;
    }

    console.log(`⏱️ Lendo: ${matchedKey} ...`);
    const duration = await getAudioDuration(matchedKey);

    if (duration) {
      await sql`UPDATE tracks SET duration_seconds = ${duration} WHERE id = ${track.id}`;
      console.log(`✅ ${track.title} -> ${duration}s (Arquivo: ${matchedKey})`);
      atualizados++;
    } else {
      console.log(`⚠️ Erro ao ler o áudio: ${matchedKey}`);
    }
  }

  console.log(`\n🎉 Concluído! ${atualizados} músicas atualizadas.`);
}

main().catch(console.error);
