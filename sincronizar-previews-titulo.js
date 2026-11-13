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

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugify(text) {
  return normalizar(text).replace(/\s+/g, '-');
}

async function sincronizar() {
  console.log("🔍 Listando previews no R2...");
  let ContinuationToken;
  const arquivosPreview = new Map();

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "previews/",
      ContinuationToken
    }));
    if (list.Contents) {
      for (const obj of list.Contents) {
        if (!obj.Key.endsWith('/')) {
          const nome = path.basename(obj.Key, path.extname(obj.Key));
          arquivosPreview.set(normalizar(nome), obj.Key);
        }
      }
    }
    ContinuationToken = list.NextContinuationToken;
  } while (ContinuationToken);

  console.log(`✅ Encontrados ${arquivosPreview.size} previews no R2.\n`);

  const tracks = await sql`SELECT id, title, preview_key FROM tracks`;
  let atualizados = 0;

  for (const track of tracks) {
    const tituloNormalizado = normalizar(track.title);
    const slug = slugify(track.title);
    const caminhoPreview = `previews/${slug}.mp3`;

    // Verifica se o arquivo existe no R2
    if (arquivosPreview.has(tituloNormalizado)) {
      const caminhoReal = arquivosPreview.get(tituloNormalizado);
      if (track.preview_key !== caminhoReal) {
        await sql`UPDATE tracks SET preview_key = ${caminhoReal} WHERE id = ${track.id}`;
        atualizados++;
      }
    } else if (arquivosPreview.has(slug)) {
      const caminhoReal = arquivosPreview.get(slug);
      if (track.preview_key !== caminhoReal) {
        await sql`UPDATE tracks SET preview_key = ${caminhoReal} WHERE id = ${track.id}`;
        atualizados++;
      }
    }
  }

  console.log(`✅ ${atualizados} músicas tiveram o preview_key sincronizado com o título.`);
}

sincronizar().catch(console.error);
