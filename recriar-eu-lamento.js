require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { parseStream } = require('music-metadata');
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

function gerarSlug(titulo) {
  return titulo
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function getAudioDuration(key) {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const metadata = await parseStream(response.Body, { mimeType: 'audio/mpeg' });
    return Math.round(metadata.format.duration);
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log('🔍 Recriando a música "Eu Lamento"...\n');

  const album = await sql`SELECT id FROM albums WHERE title ILIKE '%Ainda Dá Tempo%'`;
  if (album.length === 0) { console.log('❌ Álbum não encontrado.'); process.exit(0); }
  const albumId = album[0].id;

  const referencia = await sql`SELECT artist_id FROM tracks WHERE album_id = ${albumId} LIMIT 1`;
  if (referencia.length === 0) { console.log('❌ Sem artist_id de referência.'); process.exit(0); }
  const artistId = referencia[0].artist_id;

  const streamKey = 'josephmatthos/aindadatempo/lamento.mp3';
  console.log(`📂 Buscando arquivo: ${streamKey}`);

  try {
    await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: streamKey }));
    console.log('✅ Arquivo encontrado no B2!');

    const duration = await getAudioDuration(streamKey);
    console.log(`⏱️ Duração: ${duration}s`);

    const slug = gerarSlug('Eu Lamento');
    const agora = new Date().toISOString();

    const existente = await sql`SELECT id FROM tracks WHERE title = 'Eu Lamento' AND album_id = ${albumId}`;
    let trackId;

    if (existente.length > 0) {
      await sql`
        UPDATE tracks 
        SET stream_key = ${streamKey}, 
            duration_seconds = ${duration}, 
            slug = ${slug},
            updated_at = ${agora}
        WHERE id = ${existente[0].id}
      `;
      trackId = existente[0].id;
      console.log('ℹ️ Música atualizada no banco.');
    } else {
      const maxNum = await sql`SELECT MAX(track_number) as max FROM tracks WHERE album_id = ${albumId}`;
      const novoNumero = (maxNum[0]?.max || 0) + 1;
      
      // Inclui TODAS as colunas obrigatórias, incluindo timestamps
      const result = await sql`
        INSERT INTO tracks (
          title, 
          album_id, 
          artist_id, 
          track_number, 
          stream_key, 
          duration_seconds, 
          slug,
          created_at,
          updated_at,
          status,
          published
        )
        VALUES (
          'Eu Lamento', 
          ${albumId}, 
          ${artistId}, 
          ${novoNumero}, 
          ${streamKey}, 
          ${duration}, 
          ${slug},
          ${agora},
          ${agora},
          'PUBLISHED',
          true
        )
        RETURNING id
      `;
      trackId = result[0].id;
      console.log(`➕ Música inserida com ID: ${trackId}`);
    }

    // Gera preview
    const tmpInput = path.join(os.tmpdir(), `in-${Date.now()}.mp3`);
    const tmpOutput = path.join(os.tmpdir(), `out-${Date.now()}.mp3`);
    const s3Res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: streamKey }));
    const chunks = [];
    for await (const chunk of s3Res.Body) chunks.push(chunk);
    fs.writeFileSync(tmpInput, Buffer.concat(chunks));
    execSync(`ffmpeg -y -i "${tmpInput}" -t 30 -c copy "${tmpOutput}"`, { stdio: 'ignore' });

    const previewKey = 'previews/eu-lamento.mp3';
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: previewKey, Body: fs.readFileSync(tmpOutput), ContentType: 'audio/mpeg'
    }));

    await sql`UPDATE tracks SET preview_key = ${previewKey}, updated_at = ${agora} WHERE id = ${trackId}`;
    console.log('✅ Preview criado!');

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
    if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);

  } catch (err) {
    console.error(`❌ Erro: ${err.message}`);
  }

  // Renumerar
  const allTracks = await sql`SELECT id FROM tracks WHERE album_id = ${albumId} ORDER BY title ASC`;
  await sql`UPDATE tracks SET album_id = NULL WHERE album_id = ${albumId}`;
  for (let i = 0; i < allTracks.length; i++) {
    await sql`UPDATE tracks SET album_id = ${albumId}, track_number = ${i + 1} WHERE id = ${allTracks[i].id}`;
  }

  console.log('\n📀 Faixas finais:');
  const finais = await sql`SELECT title FROM tracks WHERE album_id = ${albumId} ORDER BY track_number ASC`;
  finais.forEach((t, i) => console.log(`   ${i + 1}. ${t.title}`));

  process.exit(0);
}

main().catch(console.error);