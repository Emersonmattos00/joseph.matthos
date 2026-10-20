require('dotenv').config({ path: '.env.local' });
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

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

async function listAll(prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: process.env.B2_MEDIA_BUCKET,
      Prefix: prefix,
      ContinuationToken: token
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function formatTitle(folderName) {
  return folderName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase())
    .trim();
}

async function main() {
  console.log('🧹 Sincronizando banco com o Backblaze...');

  const audioFiles = await listAll('josephmatthos/');
  const b2Folders = new Set();
  audioFiles.forEach(key => {
    const parts = key.replace('josephmatthos/', '').split('/');
    if (parts.length > 1) b2Folders.add(parts[0]);
  });

  const dbAlbums = await sql`SELECT id, title, slug FROM albums`;

  let deleted = 0;
  let kept = 0;

  for (const album of dbAlbums) {
    const normalizedSlug = (album.slug || '').replace(/[^a-z0-9]/g, '');
    const matchedFolder = Array.from(b2Folders).find(f => 
      f.replace(/[^a-z0-9]/g, '') === normalizedSlug || 
      f.toLowerCase() === album.title.toLowerCase().replace(/[^a-z0-9]/g, '')
    );

    if (!matchedFolder) {
      console.log(`🗑️ Removendo álbum órfão: ${album.title}`);
      await sql`DELETE FROM tracks WHERE album_id = ${album.id}`;
      await sql`DELETE FROM albums WHERE id = ${album.id}`;
      deleted++;
    } else {
      const cleanTitle = formatTitle(matchedFolder);
      await sql`UPDATE albums SET title = ${cleanTitle}, slug = ${matchedFolder} WHERE id = ${album.id}`;
      kept++;
    }
  }

  console.log(`\n✅ Concluído! ${deleted} álbuns removidos, ${kept} mantidos.`);
  const total = await sql`SELECT count(*) FROM albums`;
  console.log(`Total de álbuns no banco agora: ${total[0].count}`);
}

main().catch(console.error);