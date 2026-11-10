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

async function main() {
  console.log('🔍 Buscando Favela Viva no banco...');
  
  const [track] = await sql`SELECT id, title, stream_key FROM tracks WHERE title ILIKE 'Favela Viva'`;
  
  if (!track) {
    console.log('❌ Música Favela Viva não encontrada no banco.');
    process.exit(0);
  }

  console.log(`✅ Encontrada: ${track.title}`);
  console.log(`   Arquivo original: ${track.stream_key}`);

  const tmpInput = path.join(os.tmpdir(), `input-${Date.now()}.mp3`);
  const tmpOutput = path.join(os.tmpdir(), `preview-${Date.now()}.mp3`);

  try {
    // 1. Baixa o áudio original do B2
    console.log('⬇️ Baixando áudio original do B2...');
    const s3Res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: track.stream_key }));
    const chunks = [];
    for await (const chunk of s3Res.Body) chunks.push(chunk);
    fs.writeFileSync(tmpInput, Buffer.concat(chunks));

    // 2. Corta os primeiros 30s com o ffmpeg
    console.log('✂️ Cortando os primeiros 30s...');
    execSync(`ffmpeg -y -i "${tmpInput}" -t 30 -c copy "${tmpOutput}"`, { stdio: 'ignore' });

    // 3. Faz upload do preview para o B2
    const previewKey = 'previews/favela-viva.mp3';
    console.log(`⬆️ Enviando preview para o B2 como: ${previewKey}`);
    
    const previewBuffer = fs.readFileSync(tmpOutput);
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: previewKey,
      Body: previewBuffer,
      ContentType: 'audio/mpeg'
    }));

    // 4. Atualiza o banco com o caminho do novo preview
    await sql`UPDATE tracks SET preview_key = ${previewKey} WHERE id = ${track.id}`;
    console.log(`✅ Preview da Favela Viva criado e vinculado com sucesso!`);

  } catch (err) {
    console.error(`❌ Erro:`, err.message);
  } finally {
    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
  }
  
  process.exit(0);
}

main().catch(console.error);