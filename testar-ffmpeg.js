require('dotenv').config({ path: '.env.local' });
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');

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
  const key = 'josephmatthos/abismodocoracao/Prisão da Razão .mp3';
  console.log(`Baixando ${key}...`);
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  fs.writeFileSync('/tmp/teste.mp3', Buffer.concat(chunks));
  console.log('✅ Salvo em /tmp/teste.mp3');
}

main().catch(console.error);
