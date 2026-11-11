const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });

const { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

// Credenciais (aceita R2_* ou B2_*)
const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.B2_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.B2_APPLICATION_KEY;
const endpointUrl = process.env.R2_ENDPOINT || process.env.B2_ENDPOINT;
const bucket = process.env.B2_MEDIA_BUCKET || "josephmatthos";

if (!accessKey || !secretKey || !endpointUrl) {
  console.error("❌ ERRO: Credenciais não encontradas.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: endpointUrl,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

const TMP_DIR = path.join(__dirname, 'tmp_previews');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

async function gerarPreviews() {
  console.log("🔍 Buscando áudios completos no R2...");
  let ContinuationToken;
  let totalGerados = 0;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "premium/", // Pasta onde estão os áudios completos
      ContinuationToken
    }));

    if (!list.Contents || list.Contents.length === 0) break;

    for (const obj of list.Contents) {
      const key = obj.Key;
      // Ignora pastas ou arquivos que não são de áudio
      if (key.endsWith('/') || !key.match(/\.(mp3|wav|m4a)$/i)) continue;

      const fileName = path.basename(key);
      const localPath = path.join(TMP_DIR, fileName);
      const previewKey = `previews/${fileName}`;

      console.log(`\n🎵 Processando: ${fileName}`);

      // 1. Baixar o áudio original
      console.log("   ⬇️ Baixando...");
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await s3.send(getCmd);
      const bodyContents = await response.Body.transformToByteArray();
      fs.writeFileSync(localPath, bodyContents);

      // 2. Cortar 30 segundos com FFmpeg
      console.log("   ✂️ Cortando 30s...");
      const tempPreviewPath = path.join(TMP_DIR, `preview_${fileName}`);
      // -ss 0: começa do início, -t 30: 30 segundos, -acodec copy: copia o áudio sem perder qualidade
      execSync(`ffmpeg -y -i "${localPath}" -ss 0 -t 30 -acodec copy "${tempPreviewPath}"`, { stdio: 'ignore' });

      // 3. Fazer upload do preview para o R2
      console.log("   ⬆️ Enviando para previews/...");
      const fileStream = fs.createReadStream(tempPreviewPath);
      const putCmd = new PutObjectCommand({
        Bucket: bucket,
        Key: previewKey,
        Body: fileStream,
        ContentType: "audio/mpeg",
      });
      await s3.send(putCmd);

      // Limpar arquivos temporários
      fs.unlinkSync(localPath);
      fs.unlinkSync(tempPreviewPath);

      totalGerados++;
      console.log("   ✅ Preview gerado!");
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`\n🎉 Concluído! ${totalGerados} previews gerados e enviados.`);
}

gerarPreviews().catch(err => {
  console.error("❌ Erro:", err.message);
});