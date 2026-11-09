require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { parseBuffer } = require('music-metadata');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

const BUCKET = process.env.B2_AUDIO_BUCKET || 'josephmatthos';

// Transforma "Ainda dá tempo" em "ainda-da-tempo"
function slugify(str) {
  return String(str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Remove acentos e caracteres especiais para comparação
function normalize(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function main() {
  console.log('🔍 Buscando arquivos no Backblaze...');
  const allFiles = await listAll('');
  const audioFiles = allFiles.filter(f => f.toLowerCase().match(/\.(mp3|wav|m4a)$/));
  const previewFiles = allFiles.filter(f => f.startsWith('previews/') && f.endsWith('.mp3'));
  
  const tracks = await sql`SELECT id, title, stream_key, preview_key FROM tracks`;
  console.log(`B2: ${audioFiles.length} áudios | ${previewFiles.length} previews | Banco: ${tracks.length} faixas\n`);

  for (const track of tracks) {
    if (!track.stream_key) continue;

    // 1. Encontra o arquivo de áudio original no B2
    const fileNameDb = track.stream_key.split('/').pop();
    const normDb = normalize(fileNameDb.replace(/\.[^.]+$/, ''));
    const normTitle = normalize(track.title);

    const matchedKey = audioFiles.find(key => {
      const b2Name = key.split('/').pop();
      const normB2 = normalize(b2Name.replace(/\.[^.]+$/, ''));
      return normB2 === normDb || normB2 === normTitle || normB2.includes(normTitle);
    });

    if (!matchedKey) {
      console.log(`❌ Áudio original não encontrado: ${track.title}`);
      continue;
    }

    // 2. Normaliza o nome do arquivo original (se tiver acento ou espaço)
    const dir = path.dirname(matchedKey);
    const ext = path.extname(matchedKey);
    const cleanBase = slugify(track.title);
    const newKey = `${dir}/${cleanBase}${ext}`;

    let finalStreamKey = track.stream_key;

    if (matchedKey !== newKey) {
      console.log(`🔄 Renomeando áudio: "${matchedKey}" -> "${newKey}"`);
      await client.send(new CopyObjectCommand({
        Bucket: BUCKET, CopySource: `/${BUCKET}/${encodeURIComponent(matchedKey)}`, Key: newKey, MetadataDirective: 'REPLACE', ContentType: 'audio/mpeg'
      }));
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: matchedKey }));
      
      const idx = audioFiles.indexOf(matchedKey);
      if (idx !== -1) audioFiles[idx] = newKey;
      finalStreamKey = newKey;
    } else {
      // Força o Content-Type para não dar erro 404 no player
      const head = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: newKey }));
      if (head.ContentType !== 'audio/mpeg') {
        await client.send(new CopyObjectCommand({
          Bucket: BUCKET, CopySource: `/${BUCKET}/${encodeURIComponent(newKey)}`, Key: newKey, MetadataDirective: 'REPLACE', ContentType: 'audio/mpeg'
        }));
      }
    }

    // 3. Verifica se o preview já existe
    let hasPreview = !!track.preview_key;
    if (hasPreview) {
      const previewExists = previewFiles.includes(track.preview_key);
      if (!previewExists) hasPreview = false; // O banco diz que tem, mas o arquivo sumiu do B2
    }

    // 4. Extrai a duração (sempre bom garantir)
    console.log(`⏱️ Lendo: ${newKey}`);
    let duration = 0;
    let previewKeyToSave = track.preview_key;
    
    try {
      const s3Res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: newKey }));
      const chunks = [];
      for await (const chunk of s3Res.Body) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      const metadata = await parseBuffer(buffer, 'audio/mpeg');
      duration = Math.round(metadata.format.duration);

      // 5. Cria o preview SE estiver faltando
      if (!hasPreview) {
        console.log(`✂️ Criando preview ausente para: ${track.title}`);
        const newPreviewKey = `previews/${cleanBase}-${Date.now()}.mp3`;
        const tmpInput = path.join(os.tmpdir(), `in-${Date.now()}.mp3`);
        const tmpOutput = path.join(os.tmpdir(), `out-${Date.now()}.mp3`);
        fs.writeFileSync(tmpInput, buffer);
        
        try {
          execSync(`ffmpeg -y -i "${tmpInput}" -t 30 -c copy "${tmpOutput}"`, { stdio: 'ignore' });
          const previewBuffer = fs.readFileSync(tmpOutput);
          await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: newPreviewKey, Body: previewBuffer, ContentType: 'audio/mpeg' }));
          previewKeyToSave = newPreviewKey;
          console.log(`  ✅ Preview criado: ${newPreviewKey}`);
        } catch (e) {
          console.warn(`  ⚠️ Falha ao gerar preview: ${e.message}`);
        } finally {
          if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
          if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
        }
      }

      // 6. Atualiza tudo no Banco de Dados
      await sql`
        UPDATE tracks 
        SET stream_key = ${finalStreamKey}, 
            duration_seconds = ${duration},
            preview_key = ${previewKeyToSave}
        WHERE id = ${track.id}
      `;
      console.log(`✅ Sincronizado: ${track.title} (${duration}s)\n`);

    } catch (err) {
      console.error(`❌ Erro ao processar ${newKey}:`, err.message);
    }
  }

  console.log('🎉 Fim do processo de sincronização!');
}

main().catch(console.error);