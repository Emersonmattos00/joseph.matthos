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

async function main() {
  const res = await client.send(new ListObjectsV2Command({
    Bucket: process.env.B2_MEDIA_BUCKET,
    Prefix: 'josephmatthos/pesodacaneta/',
    MaxKeys: 10
  }));
  
  console.log('Arquivos encontrados:');
  (res.Contents || []).forEach(o => console.log(o.Key));
}

main().catch(console.error);