require('dotenv').config({ path: '.env.local' });
const { S3Client, ListObjectsV2Command, CopyObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

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
  console.log('🔧 Corrigindo Content-Type dos áudios no Backblaze B2...');
  const files = await listAll(''); 
  
  const audioFiles = files.filter(f => 
    f.toLowerCase().endsWith('.mp3') || 
    f.toLowerCase().endsWith('.wav') || 
    f.toLowerCase().endsWith('.m4a')
  );
  
  console.log(`Encontrados ${audioFiles.length} arquivos de áudio.`);

  for (const key of audioFiles) {
    const ext = key.split('.').pop().toLowerCase();
    const contentType = ext === 'wav' ? 'audio/wav' : (ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg');
    
    // O CopySource no B2 precisa ser URL-encoded e usar o formato /bucket/key
    const copySource = `/${BUCKET}/${encodeURIComponent(key)}`;
    
    try {
      // Verifica o tipo atual antes de tentar mudar
      const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
      if (head.ContentType === contentType) {
        console.log(`✅ Já está correto: ${key} (${contentType})`);
        continue;
      }

      console.log(`🔄 Corrigindo ${key} (${head.ContentType} -> ${contentType})...`);
      
      await client.send(new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: copySource,
        Key: key,
        MetadataDirective: 'REPLACE',
        ContentType: contentType
      }));
      
      console.log(`✅ Corrigido: ${key}`);
    } catch (err) {
      console.error(`❌ Erro ao corrigir ${key}:`, err.message);
    }
  }

  console.log('🎉 Fim do processo.');
}

main().catch(console.error);