const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
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

async function sincronizarExato() {
  console.log("🔍 Buscando arquivos na pasta previews/ do R2...");
  
  let ContinuationToken;
  const arquivosPreview = new Set();

  // 1. Lista todos os arquivos da pasta previews/
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

  // 2. Busca todas as músicas no banco
  const tracks = await sql`SELECT id, title, stream_key, preview_key FROM tracks`;
  console.log(`✅ Encontradas ${tracks.length} músicas no banco.\n`);

  let atualizados = 0;
  let naoEncontrados = [];

  for (const track of tracks) {
    if (!track.stream_key) {
      naoEncontrados.push(track.title);
      continue;
    }

    // Pega apenas o nome do arquivo original (ex: jornadaqt6ey2677081.mp3)
    const nomeArquivoOriginal = path.basename(track.stream_key);
    
    // O preview correspondente DEVE ter exatamente o mesmo nome, mas na pasta previews/
    const caminhoPreviewCorreto = `previews/${nomeArquivoOriginal}`;

    // Verifica se esse arquivo existe no R2
    if (arquivosPreview.has(caminhoPreviewCorreto)) {
      // Se existe, atualiza o banco
      await sql`UPDATE tracks SET preview_key = ${caminhoPreviewCorreto} WHERE id = ${track.id}`;
      atualizados++;
    } else {
      naoEncontrados.push(track.title);
    }
  }

  console.log(`✅ ${atualizados} músicas tiveram o preview_key atualizado com o caminho EXATO!`);
  
  if (naoEncontrados.length > 0) {
    console.log(`\n⚠️ ${naoEncontrados.length} músicas não têm um arquivo de preview com o nome exato no R2:`);
    naoEncontrados.forEach(t => console.log(`   - ${t}`));
  }
}

sincronizarExato().catch(console.error);
