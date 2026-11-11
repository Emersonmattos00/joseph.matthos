const path = require('path');
// Força o carregamento do .env.local da raiz do projeto
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });

const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require("@aws-sdk/client-s3");

// Verifica se as variáveis foram carregadas
if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
  console.error("❌ ERRO: Variáveis de ambiente do R2 não encontradas no .env.local");
  console.log("Verifique se o arquivo .env.local está na raiz e contém R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function limpar() {
  console.log("✅ Credenciais carregadas. Listando arquivos na pasta previews/...");
  let ContinuationToken;
  let totalApagados = 0;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: "josephmatthos", // Confirme se é esse o nome do bucket
      Prefix: "previews/",
      ContinuationToken
    }));

    if (!list.Contents || list.Contents.length === 0) {
      console.log("Nenhum arquivo encontrado na pasta previews/.");
      break;
    }

    const objectsToDelete = list.Contents.map(obj => ({ Key: obj.Key }));
    
    console.log(`Apagando ${objectsToDelete.length} arquivos...`);
    await s3.send(new DeleteObjectsCommand({
      Bucket: "josephmatthos",
      Delete: { Objects: objectsToDelete }
    }));
    
    totalApagados += objectsToDelete.length;
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Total de arquivos apagados: ${totalApagados}`);
}

limpar().catch(err => {
  console.error("❌ Erro ao apagar:", err.message);
  process.exit(1);
});