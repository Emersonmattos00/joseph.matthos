require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { parseStream } = require('music-metadata');

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
    const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function getAudioDuration(key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const metadata = await parseStream(response.Body, { mimeType: 'audio/mpeg' });
    return Math.round(metadata.format.duration);
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('🔍 Buscando todos os arquivos no Backblaze B2...');
  const b2Files = await listAll('');
  console.log(`Total de arquivos no B2: ${b2Files.length}\n`);

  // Pega TODAS as músicas
  const tracks = await sql`SELECT id, title, stream_key, duration_seconds FROM tracks ORDER BY id ASC`;
  console.log(`Analisando ${tracks.length} músicas no banco...\n`);

  let duracaoAtualizada = 0;
  let streamKeyCorrigido = 0;
  let naoEncontrados = 0;

  for (const track of tracks) {
    let dbKey = track.stream_key;
    let precisaAtualizarDuracao = !track.duration_seconds || track.duration_seconds === 0 || track.duration_seconds === 30;

    // 1. Se o stream_key está apontando para um preview, precisamos corrigir
    if (dbKey && dbKey.startsWith('previews/')) {
      const fileName = dbKey.split('/').pop();
      const normalizedTarget = normalize(fileName.replace(/\.(mp3|wav|m4a)$/, ''));
      
      // Tenta achar o arquivo original no B2 (que não esteja na pasta previews)
      const originalKey = b2Files.find(key => {
        if (key.startsWith('previews/')) return false;
        if (!key.match(/\.(mp3|wav|m4a)$/i)) return false;
        const b2FileName = key.split('/').pop();
        return normalize(b2FileName.replace(/\.(mp3|wav|m4a)$/, '')) === normalizedTarget;
      });

      if (originalKey) {
        console.log(`🔧 Corrigindo stream_key: "${track.title}"`);
        console.log(`   De: ${dbKey}`);
        console.log(`   Para: ${originalKey}`);
        await sql`UPDATE tracks SET stream_key = ${originalKey} WHERE id = ${track.id}`;
        dbKey = originalKey;
        streamKeyCorrigido++;
        precisaAtualizarDuracao = true; // Força atualizar a duração, pois o arquivo mudou
      } else {
        console.log(`❌ Não achei original para: ${track.title} (preview: ${dbKey})`);
        naoEncontrados++;
        continue;
      }
    }

    // 2. Atualiza a duração (se necessário)
    if (precisaAtualizarDuracao && dbKey) {
      // Busca o arquivo no B2
      let matchedKey = b2Files.find(key => key === dbKey);
      if (!matchedKey) {
        const fileName = dbKey.split('/').pop();
        const normalizedTarget = normalize(fileName.replace(/\.(mp3|wav|m4a)$/, ''));
        matchedKey = b2Files.find(key => {
          if (!key.match(/\.(mp3|wav|m4a)$/i)) return false;
          const b2FileName = key.split('/').pop();
          return normalize(b2FileName.replace(/\.(mp3|wav|m4a)$/, '')) === normalizedTarget;
        });
      }

      if (matchedKey && !matchedKey.startsWith('previews/')) {
        console.log(`⏱️ Lendo: ${track.title}`);
        const duration = await getAudioDuration(matchedKey);
        
        if (duration && duration > 30) {
          await sql`UPDATE tracks SET duration_seconds = ${duration} WHERE id = ${track.id}`;
          console.log(`   ✅ ${track.title} -> ${duration}s`);
          duracaoAtualizada++;
        } else if (duration) {
          console.log(`   ⚠️ Duração curta (${duration}s): ${track.title}`);
        }
      }
    }
  }

  console.log(`\n🎉 Concluído!`);
  console.log(`- Durações atualizadas: ${duracaoAtualizada}`);
  console.log(`- stream_keys corrigidos: ${streamKeyCorrigido}`);
  console.log(`- Não encontrados no B2: ${naoEncontrados}`);
  process.exit(0);
}

main().catch(console.error);