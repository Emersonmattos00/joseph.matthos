require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, HeadObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const sql = neon(process.env.DATABASE_URL);
const client = new S3Client({
  region: process.env.B2_MEDIA_REGION || 'us-east-005',
  endpoint: process.env.B2_MEDIA_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
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
    const res = await client.send(new ListObjectsV2Command({
      Bucket: 'joseph.matthos', Prefix: prefix, ContinuationToken: token
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function exists(key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: 'joseph.matthos', Key: key }));
    return true;
  } catch { return false; }
}

async function main() {
  console.log('🔍 Buscando arquivos reais no B2...');
  const fulls = await listAll('josephmatthos/');
  console.log(`Encontrados ${fulls.length} arquivos completos no B2.`);

  const tracks = await sql`SELECT id, title, stream_key FROM tracks`;
  let fixed = 0;
  let notFound = 0;

  for (const t of tracks) {
    let key = t.stream_key;
    if (!key) continue;
    
    // Remove espaços do final e testa se existe
    key = key.trim();
    
    if (await exists(key)) {
      // Se existe, garante que está sem espaço no banco
      await sql`UPDATE tracks SET stream_key = ${key} WHERE id = ${t.id}`;
      fixed++;
    } else {
      // Se não existe, tenta achar o arquivo pelo nome da música
      const titleClean = t.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const match = fulls.find(f => {
        const fileName = f.split('/').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
        return fileName.includes(titleClean) || titleClean.includes(fileName);
      });
      
      if (match) {
        await sql`UPDATE tracks SET stream_key = ${match} WHERE id = ${t.id}`;
        console.log(`✅ Corrigido: ${t.title} → ${match}`);
        fixed++;
      } else {
        console.log(`❌ Não encontrado: ${t.title}`);
        notFound++;
      }
    }
  }

  console.log(`\n🎉 Concluído! ${fixed} chaves verificadas/corrigidas, ${notFound} não encontradas.`);
}

main().catch(console.error);
