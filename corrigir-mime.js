require('dotenv').config({ path: '.env.local' });
const { S3Client, ListObjectsV2Command, CopyObjectCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  region: process.env.B2_MEDIA_REGION || 'us-east-005',
  endpoint: process.env.B2_MEDIA_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_KEY_ID,
    secretAccessKey: process.env.B2_APPLICATION_KEY
  }
});

const BUCKET = process.env.B2_MEDIA_BUCKET;

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function main() {
  console.log('🔧 Corrigindo Content-Type dos áudios...');
  const files = await listAll('josephmatthos/');
  const audioFiles = files.filter(f => f.endsWith('.mp3') || f.endsWith('.wav') || f.endsWith('.m4a'));
  
  console.log(`Encontrados ${audioFiles.length} arquivos de áudio.`);

  for (const key of audioFiles) {
    const ext = key.split('.').pop().toLowerCase();
    const contentType = ext === 'wav' ? 'audio/wav' : (ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg');
    
    console.log(`Corrigindo ${key} → ${contentType}`);
    
    // Copia o arquivo para ele mesmo, substituindo o Content-Type
    await client.send(new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${key}`,
      Key: key,
      MetadataDirective: 'REPLACE', // Substitui os metadados
      ContentType: contentType
    }));
  }

  console.log('✅ Todos os arquivos corrigidos!');
}

main().catch(console.error);