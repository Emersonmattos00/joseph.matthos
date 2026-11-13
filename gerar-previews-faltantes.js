const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.B2_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.B2_APPLICATION_KEY;
const endpointUrl = process.env.R2_ENDPOINT || process.env.B2_ENDPOINT;
const bucket = process.env.B2_MEDIA_BUCKET || "josephmatthos";

const s3 = new S3Client({
  region: "auto",
  endpoint: endpointUrl,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

const TMP_DIR = path.join(__dirname, 'tmp_previews');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

function slugify(text) {
  return text.toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

async function gerar() {
  console.log("🔍 Buscando arquivos na pasta previews/ do R2...");
  let ContinuationToken;
  const arquivosPreview = new Set();

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "previews/",
      ContinuationToken
    }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (!obj.Key.endsWith('/')) arquivosPreview.add(obj.Key);
      }
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Encontrados ${arquivosPreview.size} arquivos no R2.\n`);

  const tracks = await sql`SELECT id, title, stream_key, preview_key FROM tracks`;
  console.log(`✅ Encontradas ${tracks.length} músicas no banco.\n`);

  let gerados = 0;
  let falhas = [];

  for (const track of tracks) {
    const slug = slugify(track.title);
    const caminhoPreview = `previews/${slug}.mp3`;

    // Se o preview já existe no R2, pula
    if (arquivosPreview.has(caminhoPreview)) {
      continue;
    }

    // Se não tem stream_key, não podemos gerar
    if (!track.stream_key) {
      falhas.push(`${track.title} (sem stream_key)`);
      continue;
    }

    console.log(`\n🎵 Gerando preview para: "${track.title}"`);

    try {
      // 1. Baixar áudio completo
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: track.stream_key });
      const response = await s3.send(getCmd);
      const bodyContents = await response.Body.transformToByteArray();
      
      const extensao = path.extname(track.stream_key) || '.mp3';
      const localPath = path.join(TMP_DIR, `${slug}${extensao}`);
      fs.writeFileSync(localPath, bodyContents);

      // 2. Cortar 30 segundos
      const tempPreviewPath = path.join(TMP_DIR, `${slug}_preview.mp3`);
      execSync(`ffmpeg -y -i "${localPath}" -ss 0 -t 30 -acodec copy "${tempPreviewPath}"`, { stdio: 'ignore' });

      // 3. Upload do preview
      const fileStream = fs.createReadStream(tempPreviewPath);
      const putCmd = new PutObjectCommand({
        Bucket: bucket,
        Key: caminhoPreview,
        Body: fileStream,
        ContentType: "audio/mpeg",
      });
      await s3.send(putCmd);

      // 4. Atualizar banco
      await sql`UPDATE tracks SET preview_key = ${caminhoPreview} WHERE id = ${track.id}`;

      // Limpar temporários
      fs.unlinkSync(localPath);
      fs.unlinkSync(tempPreviewPath);

      gerados++;
      console.log(`   ✅ Preview gerado e banco atualizado!`);

    } catch (err) {
      console.error(`   ❌ Falha: ${err.message}`);
      falhas.push(track.title);
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Concluído! ${gerados} previews gerados.`);
  
  if (falhas.length > 0) {
    console.log(`\n⚠️ ${falhas.length} músicas falharam:`);
    falhas.forEach(t => console.log(`   - ${t}`));
  }
}

gerar().catch(console.error);