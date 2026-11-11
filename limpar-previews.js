const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.B2_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.B2_APPLICATION_KEY;
const endpointUrl = process.env.R2_ENDPOINT || process.env.B2_ENDPOINT;

if (!accessKey || !secretKey || !endpointUrl) {
  console.error("❌ ERRO: Credenciais não encontradas.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: endpointUrl,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

async function limpar() {
  console.log("Limpando pasta previews/...");
  let ContinuationToken;
  let total = 0;
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.B2_MEDIA_BUCKET || "josephmatthos",
      Prefix: "previews/",
      ContinuationToken
    }));
    if (!list.Contents || list.Contents.length === 0) break;
    await s3.send(new DeleteObjectsCommand({
      Bucket: process.env.B2_MEDIA_BUCKET || "josephmatthos",
      Delete: { Objects: list.Contents.map(o => ({ Key: o.Key })) }
    }));
    total += list.Contents.length;
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);
  console.log(`✅ ${total} arquivos apagados.`);
}
limpar().catch(e => console.error(e.message));