const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

const accessKey = process.env.R2_ACCESS_KEY_ID || process.env.B2_KEY_ID;
const secretKey = process.env.R2_SECRET_ACCESS_KEY || process.env.B2_APPLICATION_KEY;
const endpointUrl = process.env.R2_ENDPOINT || process.env.B2_ENDPOINT;
const bucket = process.env.B2_MEDIA_BUCKET || "josephmatthos";

const s3 = new S3Client({
  region: "auto",
  endpoint: endpointUrl,
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
});

async function limparAntigos() {
  console.log("🔍 Buscando previews antigos (com hash no nome)...");
  let ContinuationToken;
  let apagados = 0;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "previews/",
      ContinuationToken
    }));

    if (!list.Contents || list.Contents.length === 0) break;

    // Filtra apenas os arquivos que têm números longos no nome (padrão de hash antigo)
    // Exemplo do que queremos apagar: jornadaqt6ey2677081-1791567102027-1.mp3
    const paraApagar = list.Contents.filter(obj => {
      const nome = obj.Key;
      // Se o nome tem um traço seguido de muitos números (timestamp) ou "qt6ey", é antigo
      return /-\d{10,}/.test(nome) || nome.includes('qt6ey') || nome.includes('-0.mp3') || nome.includes('-1.mp3');
    });

    if (paraApagar.length > 0) {
      console.log(`Apagando ${paraApagar.length} arquivos antigos...`);
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: paraApagar.map(o => ({ Key: o.Key })) }
      }));
      apagados += paraApagar.length;
    }
    
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Limpeza concluída! ${apagados} previews antigos foram apagados.`);
  console.log(`Os arquivos limpos (ex: jornada.mp3) foram mantidos.`);
}

limparAntigos().catch(console.error);