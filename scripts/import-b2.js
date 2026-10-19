require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
const B2_REGION = process.env.B2_MEDIA_REGION || 'us-east-005';
const B2_KEY_ID = process.env.B2_KEY_ID;
const B2_APP_KEY = process.env.B2_APPLICATION_KEY;
const B2_BUCKET = process.env.B2_MEDIA_BUCKET || 'josephmatthos';

const client = new S3Client({
  region: B2_REGION,
  endpoint: process.env.B2_MEDIA_ENDPOINT || `https://s3.${B2_REGION}.backblazeb2.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APP_KEY
  }
});

// ─────────────────────────────────────────────────────────────
// FUNÇÕES AUXILIARES
// ─────────────────────────────────────────────────────────────
function createSlug(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: B2_BUCKET, Prefix: prefix, ContinuationToken: token
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// ─────────────────────────────────────────────────────────────
// EXECUÇÃO PRINCIPAL
// ─────────────────────────────────────────────────────────────
async function main() {
  const sql = neon(process.env.DATABASE_URL);

  console.log('🔍 Buscando arquivos no B2...');
  const fulls = await listAll('josephmatthos/');
  const previews = await listAll('previews/');
  console.log(`Encontrados ${fulls.length} áudios completos e ${previews.length} prévias.`);

  // 1. Buscar ou criar o artista
  let artistId;
  const [existingArtist] = await sql`SELECT id FROM artists WHERE name = 'Joseph Matthos' LIMIT 1`;
  
  if (existingArtist) {
    artistId = existingArtist.id;
  } else {
    artistId = crypto.randomUUID();
    await sql`INSERT INTO artists (id, name, slug) VALUES (${artistId}, 'Joseph Matthos', 'joseph-matthos')`;
    console.log(`👤 Artista criado.`);
  }

  // 2. Agrupar faixas por pasta (álbum)
  const albumsMap = new Map();
  for (const fullKey of fulls) {
    const parts = fullKey.replace('josephmatthos/', '').split('/');
    const albumFolder = parts.length > 1 ? parts[0] : 'singles';
    if (!albumsMap.has(albumFolder)) albumsMap.set(albumFolder, []);
    albumsMap.get(albumFolder).push(fullKey);
  }

  let totalInserted = 0;
  const now = new Date().toISOString();

  for (const [albumName, files] of albumsMap.entries()) {
    // Limpa o nome da pasta para o título do álbum
    const albumTitle = albumName
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase())
      .trim();
    
    const albumSlug = createSlug(albumTitle);

    // ⚠️ CORREÇÃO AQUI: Verifica se o álbum já existe pelo SLUG (que é único)
    let albumId;
    const [existingAlbum] = await sql`SELECT id FROM albums WHERE slug = ${albumSlug} LIMIT 1`;
    
    if (existingAlbum) {
      albumId = existingAlbum.id;
    } else {
      albumId = crypto.randomUUID();
      await sql`INSERT INTO albums (id, title, slug, artist_id, published) VALUES (${albumId}, ${albumTitle}, ${albumSlug}, ${artistId}, true)`;
      console.log(`💿 Álbum "${albumTitle}" criado.`);
    }

    // Ordenar os arquivos
    files.sort();
    let trackNumber = 1;
    let albumInserted = 0;

    for (const fullKey of files) {
      const rawTitle = fullKey.split('/').pop().replace(/\.[^.]+$/, '');
      const title = rawTitle || `Faixa ${trackNumber}`;

      // Verifica se a faixa já existe
      const [existingTrack] = await sql`SELECT id FROM tracks WHERE full_path = ${fullKey} LIMIT 1`;
      if (existingTrack) {
        trackNumber++;
        continue; // Pula a faixa mas mantém a contagem do número da track
      }

      const slug = createSlug(title) || `faixa-${trackNumber}`;
      
      // Encontra a prévia correspondente
      const previewKey = previews.find(p => {
        const previewRaw = p.replace('previews/', '').replace(/\.[^.]+$/, '');
        return previewRaw.includes(createSlug(title)) || createSlug(title).includes(previewRaw);
      }) || null;

      try {
        await sql`
          INSERT INTO tracks (
            id, album_id, artist_id, title, slug, track_number, status, 
            full_path, preview_path, stream_key, preview_key,
            created_at, updated_at
          ) VALUES (
            ${crypto.randomUUID()},
            ${albumId},
            ${artistId},
            ${title},
            ${slug + '-' + trackNumber},
            ${trackNumber},
            'PUBLISHED',
            ${fullKey},
            ${previewKey},
            ${fullKey},
            ${previewKey},
            ${now},
            ${now}
          )
        `;
        albumInserted++;
        totalInserted++;
      } catch (err) {
        console.error(`❌ Erro ao inserir "${title}":`, err.message);
      }

      trackNumber++;
    }
    
    if (albumInserted > 0) {
      console.log(`✅ Álbum "${albumTitle}" importado (${albumInserted} faixas novas).`);
    }
  }

  console.log(`\n🎉 Importação concluída! ${totalInserted} faixas inseridas no total.`);
}

main().catch(console.error);