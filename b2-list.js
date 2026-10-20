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
async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: process.env.B2_MEDIA_BUCKET, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}
async function main() {
  console.log('📂 Listando conteúdo do B2...');
  const audioFiles = await listAll('josephmatthos/');
  const albums = new Set();
  audioFiles.forEach(key => {
    const parts = key.replace('josephmatthos/', '').split('/');
    if (parts.length > 1) albums.add(parts[0]);
  });
  console.log('Álbuns (pastas) encontrados:', albums.size);
  console.log(Array.from(albums).sort());
}
main().catch(console.error);
