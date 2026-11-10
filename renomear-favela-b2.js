require('dotenv').config({ path: '.env.local' });
const { S3Client, CopyObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

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
  // Caminho do arquivo atual e o novo caminho
  const oldKey = 'josephmatthos/alogicadaconsciencia/viva.mp3';
  const newKey = 'josephmatthos/alogicadaconsciencia/favela-viva.mp3';

  console.log(`🔄 Renomeando no B2:`);
  console.log(`   De: ${oldKey}`);
  console.log(`   Para: ${newKey}`);

  try {
    // 1. Copia o arquivo para o novo nome
    await client.send(new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `/${BUCKET}/${encodeURIComponent(oldKey)}`,
      Key: newKey,
      MetadataDirective: 'REPLACE',
      ContentType: 'audio/mpeg'
    }));
    console.log('✅ Arquivo copiado.');

    // 2. Deleta o arquivo antigo
    await client.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: oldKey
    }));
    console.log('✅ Arquivo antigo removido.');

    console.log('\n🎉 Renomeação concluída com sucesso!');
  } catch (err) {
    console.error('❌ Erro:', err.message);
  }
  
  process.exit(0);
}

main().catch(console.error);
