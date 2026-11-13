const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env.local') });
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { neon } = require('@neondatabase/serverless');
const mm = require('music-metadata');
const { Readable } = require('stream');

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

async function sincronizar() {
  console.log("🔍 Buscando faixas no banco de dados...");
  const tracks = await sql`
    SELECT t.id, t.title, t.track_number, t.stream_key, a.title as album_title
    FROM tracks t
    JOIN albums a ON t.album_id = a.id
    WHERE t.stream_key IS NOT NULL
  `;
  
  console.log(`✅ Encontradas ${tracks.length} faixas com áudio completo.\n`);
  
  let atualizados = 0;
  let semTag = 0;
  let erros = 0;

  for (const track of tracks) {
    console.log(`\n🎵 Processando: "${track.title}" (${track.album_title})`);
    
    try {
      // 1. Baixa o arquivo do R2 para a memória
      const getCmd = new GetObjectCommand({ Bucket: bucket, Key: track.stream_key });
      const response = await s3.send(getCmd);
      
      // Converte o stream do S3 para buffer
      const chunks = [];
      for await (const chunk of response.Body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      
      // 2. Lê os metadados ID3
      const metadata = await mm.parseBuffer(buffer, { mimeType: response.ContentType || 'audio/mpeg' });
      
      const tagNumber = metadata.common.track?.no;
      
      if (tagNumber === undefined || tagNumber === null) {
        console.log(`   ⚠️ Sem tag de número de faixa no arquivo.`);
        semTag++;
        continue;
      }
      
      // 3. Atualiza se for diferente
      if (track.track_number !== tagNumber) {
        await sql`UPDATE tracks SET track_number = ${tagNumber} WHERE id = ${track.id}`;
        console.log(`   ✅ Atualizado: ${track.track_number} -> ${tagNumber}`);
        atualizados++;
      } else {
        console.log(`   ✓ Já está correto: ${tagNumber}`);
      }
      
    } catch (err) {
      console.error(`   ❌ Erro: ${err.message}`);
      erros++;
    }
  }
  
  console.log("\n==================================================");
  console.log(`🎉 Concluído!`);
  console.log(`✅ Atualizados: ${atualizados}`);
  console.log(`⚠️ Sem tag: ${semTag}`);
  console.log(`❌ Erros: ${erros}`);
}

sincronizar().catch(console.error);