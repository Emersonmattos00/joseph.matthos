require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function slugify(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function main() {
  const tracks = await sql`SELECT id, title, stream_key FROM tracks WHERE preview_key IS NULL`;
  console.log(`Gerando previews para ${tracks.length} músicas...\n`);

  let gerados = 0;

  for (const track of tracks) {
    if (!track.stream_key) {
      console.log(`⚠️  ${track.title}: sem stream_key`);
      continue;
    }

    const slug = slugify(track.title);
    const previewKey = `previews/${slug}-${Date.now()}.mp3`;
    const tmpInput = path.join(os.tmpdir(), `input-${Date.now()}.mp3`);
    const tmpOutput = path.join(os.tmpdir(), `preview-${Date.now()}.mp3`);

    try {
      // 1. Baixa o áudio completo do B2
      const keyToFetch = track.stream_key.startsWith('josephmatthos/') 
        ? track.stream_key 
        : `josephmatthos/${track.stream_key}`;

      console.log(`⬇️  Baixando: ${track.title}`);
      const s3Res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: keyToFetch }));
      
      const chunks = [];
      for await (const chunk of s3Res.Body) chunks.push(chunk);
      fs.writeFileSync(tmpInput, Buffer.concat(chunks));

      // 2. Corta os primeiros 30s com ffmpeg
      console.log(`✂️  Cortando 30s...`);
      execSync(`ffmpeg -y -i "${tmpInput}" -t 30 -c copy "${tmpOutput}"`, { stdio: 'ignore' });

      // 3. Faz upload do preview para o B2
      console.log(`⬆️  Enviando preview...`);
      const previewBuffer = fs.readFileSync(tmpOutput);
      await client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: previewKey,
        Body: previewBuffer,
        ContentType: 'audio/mpeg'
      }));

      // 4. Atualiza o banco
      await sql`UPDATE tracks SET preview_key = ${previewKey} WHERE id = ${track.id}`;
      console.log(`✅ ${track.title} → ${previewKey}\n`);
      gerados++;

    } catch (err) {
      console.error(`❌ Erro em ${track.title}:`, err.message, '\n');
    } finally {
      // Limpa arquivos temporários
      if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
      if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
    }
  }

  console.log(`\n🎉 Concluído! ${gerados} previews gerados.`);
}

main().catch(console.error);
