require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const B2_REGION = process.env.B2_MEDIA_REGION || 'us-east-005';
const B2_BUCKET = process.env.B2_MEDIA_BUCKET || 'josephmatthos';

const client = new S3Client({
  region: B2_REGION,
  endpoint: process.env.B2_MEDIA_ENDPOINT || `https://s3.${B2_REGION}.backblazeb2.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  }
});

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: B2_BUCKET, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function normalize(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function main() {
  const sql = neon(process.env.DATABASE_URL);
  
  console.log('🖼️ Buscando imagens no Backblaze...');
  // As imagens estão na pasta 'assets/img/' conforme visto nas suas fotos
  const images = await listAll('assets/img/');
  
  // Filtra apenas imagens (webp, jpg, png)
  const validImages = images.filter(img => /\.(webp|jpg|jpeg|png)$/i.test(img));
  
  const albums = await sql`SELECT id, title FROM albums`;
  console.log(`Encontrados ${albums.length} álbuns e ${validImages.length} imagens válidas.`);

  let linked = 0;
  let notFound = 0;

  for (const album of albums) {
    const normalizedTitle = normalize(album.title);
    
    // Tenta encontrar uma imagem que bata com o nome do álbum
    const imageKey = validImages.find(img => {
      const imgName = normalize(img.split('/').pop().replace(/\.[^.]+$/, ''));
      return imgName === normalizedTitle || imgName.includes(normalizedTitle) || normalizedTitle.includes(imgName);
    });

    if (imageKey) {
      // Atualiza a URL da capa (guardando o caminho relativo que o frontend espera)
      await sql`UPDATE albums SET cover_url = ${imageKey} WHERE id = ${album.id}`;
      console.log(`✅ ${album.title} → ${imageKey}`);
      linked++;
    } else {
      console.log(`❌ ${album.title} (imagem não encontrada)`);
      notFound++;
    }
  }

  console.log(`\n🎉 Concluído! ${linked} capas vinculadas, ${notFound} não encontradas.`);
}

main().catch(console.error);