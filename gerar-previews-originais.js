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
  console.log("🔍 Listando todos os arquivos do R2 (para busca flexível)...");
  let ContinuationToken;
  const arquivosNoR2 = [];

  // Lista TUDO no R2 para podermos achar o arquivo original mesmo se o nome estiver um pouco diferente
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken
    }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (!obj.Key.endsWith('/')) arquivosNoR2.push(obj.Key);
      }
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Encontrados ${arquivosNoR2.length} arquivos totais no R2.\n`);

  const tracks = await sql`SELECT id, title, stream_key, preview_key FROM tracks`;
  console.log(`✅ Encontradas ${tracks.length} músicas no banco.\n`);

  let gerados = 0;
  let falhas = [];

  for (const track of tracks) {
    const slug = slugify(track.title);
    const caminhoPreviewFinal = `previews/${slug}.mp3`;

    // Se o preview já existe no R2, pula
    if (arquivosNoR2.includes(caminhoPreviewFinal)) {
      continue;
    }

    console.log(`\n🎵 Processando: "${track.title}"`);

    // Tenta achar o arquivo original no R2
    let streamKeyLimpa = track.stream_key ? track.stream_key.replace(/^\/+/, '').trim() : '';
    let arquivoOriginal = arquivosNoR2.find(k => k === streamKeyLimpa);

    // Se não achou exato, tenta achar por similaridade (ignorando maiúsculas/minúsculas e acentos)
    if (!arquivoOriginal && streamKeyLimpa) {
      const nomeProcurado = slugify(path.basename(streamKeyLimpa, path.extname(streamKeyLimpa)));
      arquivoOriginal = arquivosNoR2.find(k => {
        if (!k.startsWith('premium/')) return false;
        const nomeAtual = slugify(path.basename(k, path.extname(k)));
        return nomeAtual === nomeProcurado || nomeAtual.includes(nomeProcurado);
      });
    }

    if (!arquivoOriginal) {
      console.log(`   ❌ Arquivo original não encontrado no R2 (stream_key: ${track.stream_key})`);
      falhas.push(track.title);
      continue;
    }

    if (arquivoOriginal !== track.stream_key) {
      console.log(`   ℹ️  Arquivo original ajustado para: ${arquivoOriginal}`);
    }

    try {
      // 1. Baixar áudio completo
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: arquivoOriginal });
      const response = await s3.send(getCmd);
      const bodyContents = await response.Body.transformToByteArray();
      
      const extensao = path.extname(arquivoOriginal) || '.mp3';
      const localPath = path.join(TMP_DIR, `${slug}${extensao}`);
      fs.writeFileSync(localPath, bodyContents);

      // 2. Cortar 30 segundos
      const tempPreviewPath = path.join(TMP_DIR, `${slug}_preview.mp3`);
      execSync(`ffmpeg -y -i "${localPath}" -ss 0 -t 30 -acodec copy "${tempPreviewPath}"`, { stdio: 'ignore' });

      // 3. Upload do preview
      const fileStream = fs.createReadStream(tempPreviewPath);
      const putCmd = new PutObjectCommand({
        Bucket: bucket,
        Key: caminhoPreviewFinal,
        Body: fileStream,
        ContentType: "audio/mpeg",
      });
      await s3.send(putCmd);

      // 4. Atualizar banco
      await sql`UPDATE tracks SET preview_key = ${caminhoPreviewFinal} WHERE id = ${track.id}`;

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