require('dotenv').config({ path: '.env.local' });
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const client = new S3Client({
  region: process.env.B2_MEDIA_REGION || 'us-east-005',
  endpoint: process.env.B2_MEDIA_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  }
});

const BUCKET = process.env.B2_AUDIO_BUCKET || 'josephmatthos';

async function main() {
  console.log('🔍 Listando arquivos da pasta alogicadaconsciencia no B2...\n');
  
  const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'josephmatthos/alogicadaconsciencia/' }));
  
  const files = (res.Contents || []).map(o => o.Key);
  
  if (files.length === 0) {
    console.log('❌ Nenhum arquivo encontrado nessa pasta.');
    console.log('   Tentando listar a raiz do bucket...');
    const root = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'josephmatthos/' }));
    (root.Contents || []).forEach(o => console.log(`  - ${o.Key}`));
  } else {
    files.forEach(f => console.log(`  - ${f}`));
  }
  
  process.exit(0);
}

main().catch(console.error);