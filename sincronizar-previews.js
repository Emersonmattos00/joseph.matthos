const path = require('path');
const fs = require('fs');
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

// Função para limpar o nome do arquivo e deixar tudo igual
function normalizarNome(nome) {
  return nome
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Remove acentos
    .replace(/[^a-z0-9]/g, ""); // Remove tudo que não for letra ou número
}

async function sincronizar() {
  console.log("🔍 Buscando arquivos na pasta previews/ do R2...");
  
  let ContinuationToken;
  const arquivosPreview = [];

  // 1. Lista todos os arquivos da pasta previews/
  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "previews/",
      ContinuationToken
    }));

    if (list.Contents) {
      for (const obj of list.Contents) {
        if (!obj.Key.endsWith('/')) {
          arquivosPreview.push(obj.Key);
        }
      }
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Encontrados ${arquivosPreview.length} arquivos de preview no R2.\n`);

  // 2. Busca todas as músicas no banco
  console.log("🔍 Buscando músicas no banco de dados...");
  const tracks = await sql`SELECT id, title, stream_key, preview_key FROM tracks`;
  console.log(`✅ Encontradas ${tracks.length} músicas no banco.\n`);

  let atualizados = 0;
  let naoEncontrados = [];

  // 3. Cruza os dados
  for (const track of tracks) {
    // Tenta achar um arquivo no R2 que bata com o título ou com o nome do stream_key
    const nomeStream = track.stream_key ? path.basename(track.stream_key, path.extname(track.stream_key)) : '';
    
    const match = arquivosPreview.find(arquivo => {
      const nomeArquivo = path.basename(arquivo, '.mp3');
      const nomeArquivoNormalizado = normalizarNome(nomeArquivo);
      const tituloNormalizado = normalizarNome(track.title);
      const streamNormalizado = normalizarNome(nomeStream);

      // Se o nome do arquivo contém o título da música ou o nome do arquivo original
      return nomeArquivoNormalizado.includes(tituloNormalizado) || 
             nomeArquivoNormalizado.includes(streamNormalizado) ||
             tituloNormalizado.includes(nomeArquivoNormalizado);
    });

    if (match) {
      // Se achou, atualiza o banco
      if (track.preview_key !== match) {
        await sql`UPDATE tracks SET preview_key = ${match} WHERE id = ${track.id}`;
        atualizados++;
        console.log(`✅ [Atualizado] "${track.title}" -> ${match}`);
      }
    } else {
      naoEncontrados.push(track.title);
    }
  }

  console.log("\n==================================================");
  console.log(`🎉 Sincronização concluída!`);
  console.log(`✅ Músicas atualizadas: ${atualizados}`);
  
  if (naoEncontrados.length > 0) {
    console.log(`\n⚠️ Atenção: ${naoEncontrados.length} músicas não tiveram preview encontrado:`);
    naoEncontrados.forEach(t => console.log(`   - ${t}`));
    console.log("   (Verifique se esses arquivos existem na pasta previews/ do R2)");
  }
}

sincronizar().catch(console.error);
