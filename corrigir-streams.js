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
  console.log('🔍 Buscando arquivos no B2...');
  const b2Files = await listAll('');
  console.log(`Total de arquivos no B2: ${b2Files.length}\n`);

  // Pega as 19 músicas com problema (stream_key apontando para previews/)
  const tracks = await sql`SELECT id, title, stream_key FROM tracks WHERE stream_key LIKE 'previews/%'`;
  console.log(`Músicas com stream_key errado: ${tracks.length}\n`);

  let corrigidos = 0;

  for (const track of tracks) {
    // Tenta achar o arquivo no B2 usando o título da música
    const tituloNormalizado = normalize(track.title);
    
    // Filtra os arquivos do B2 que são áudio e NÃO são previews
    const audioFiles = b2Files.filter(key => 
      !key.startsWith('previews/') && 
      key.match(/\.(mp3|wav|m4a)$/i)
    );

    // Tenta achar um arquivo que tenha o nome parecido com o título
    let matchedKey = audioFiles.find(key => {
      const fileName = key.split('/').pop();
      const fileNormalized = normalize(fileName.replace(/\.(mp3|wav|m4a)$/, ''));
      return fileNormalized === tituloNormalizado;
    });

    // Se não achou exato, tenta achar por partes (contains)
    if (!matchedKey) {
      matchedKey = audioFiles.find(key => {
        const fileName = key.split('/').pop();
        const fileNormalized = normalize(fileName.replace(/\.(mp3|wav|m4a)$/, ''));
        return fileNormalized.includes(tituloNormalizado) || tituloNormalizado.includes(fileNormalized);
      });
    }

    // Se ainda não achou, tenta usar o nome do preview (removendo o 'previews/')
    if (!matchedKey) {
      const previewName = track.stream_key.replace('previews/', '');
      const previewNormalized = normalize(previewName.replace(/\.(mp3|wav|m4a)$/, ''));
      matchedKey = audioFiles.find(key => {
        const fileName = key.split('/').pop();
        const fileNormalized = normalize(fileName.replace(/\.(mp3|wav|m4a)$/, ''));
        return fileNormalized === previewNormalized;
      });
    }

    if (matchedKey) {
      console.log(`✅ Corrigindo: "${track.title}"`);
      console.log(`   De: ${track.stream_key}`);
      console.log(`   Para: ${matchedKey}`);
      
      await sql`UPDATE tracks SET stream_key = ${matchedKey} WHERE id = ${track.id}`;

      // Atualiza a duração
      const duration = await getAudioDuration(matchedKey);
      if (duration && duration > 30) {
        await sql`UPDATE tracks SET duration_seconds = ${duration} WHERE id = ${track.id}`;
        console.log(`   ⏱️ Duração atualizada: ${duration}s\n`);
      } else {
        console.log(`   ⚠️ Não foi possível obter duração válida.\n`);
      }
      
      corrigidos++;
    } else {
      console.log(`❌ Não encontrado no B2: "${track.title}" (preview: ${track.stream_key})`);
    }
  }

  console.log(`\n🎉 Concluído! ${corrigidos} músicas corrigidas.`);
  process.exit(0);
}

main().catch(console.error);