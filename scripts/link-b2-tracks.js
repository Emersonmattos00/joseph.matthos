require('dotenv').config();
const { neon } = require('@neondatabase/serverless');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const APPLY = process.argv.includes('--apply');

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function baseName(key) {
  const parts = key.split('/');
  return parts[parts.length - 1].replace(/\.[^.]+$/, '');
}

async function listAll(client, bucket, prefix) {
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token
    }));
    (res.Contents || []).forEach(o => out.push(o.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

(async () => {
  const sql = neon(process.env.DATABASE_URL);
  const client = new S3Client({
    region: process.env.B2_MEDIA_REGION,
    endpoint: process.env.B2_MEDIA_ENDPOINT,
    credentials: {
      accessKeyId: process.env.B2_KEY_ID,
      secretAccessKey: process.env.B2_APPLICATION_KEY
    }
  });

  const bucket = process.env.B2_MEDIA_BUCKET;
  console.log('Bucket:', bucket, '| Modo:', APPLY ? 'APPLY' : 'DRY-RUN', '\n');

  const previews = await listAll(client, bucket, 'previews/');
  const fulls = await listAll(client, bucket, 'josephmatthos/');
  console.log('previews:', previews.length, '| audio-full:', fulls.length);

  const previewMap = new Map();
  previews.forEach(key => {
    const base = baseName(key).replace(/-[0-9]+-[0-9]+$/, '');
    const norm = normalize(base);
    if (norm && !previewMap.has(norm)) previewMap.set(norm, key);
  });

  const fullMap = new Map();
  fulls.forEach(key => {
    const norm = normalize(baseName(key));
    if (norm && !fullMap.has(norm)) fullMap.set(norm, key);
  });

  console.log('previewMap:', previewMap.size, '| fullMap:', fullMap.size, '\n');

  const tracks = await sql.query('SELECT id, title FROM tracks ORDER BY title');
  console.log('Faixas no banco:', tracks.length, '\n');

  const updates = [];
  let semMatch = 0;

  for (const t of tracks) {
    const norm = normalize(t.title);
    let preview = previewMap.get(norm) || null;
    let full = fullMap.get(norm) || null;

    if (full) full = full.replace(/^josephmatthos\//, '');

    if (!preview && !full) { semMatch++; console.log('X ' + t.title); continue; }

    updates.push({ id: t.id, title: t.title, preview_path: preview, full_path: full });
    console.log('OK ' + t.title + ' | p=' + (preview || '-') + ' | f=' + (full || '-'));
  }

  console.log('\nResumo: total=' + tracks.length + ' updates=' + updates.length + ' semMatch=' + semMatch + '\n');

  if (!APPLY) { console.log('DRY-RUN. Use --apply.'); return; }

  console.log('Aplicando...');
  for (const u of updates) {
    await sql.query(
      'UPDATE tracks SET preview_path = COALESCE($1, preview_path), full_path = COALESCE($2, full_path) WHERE id = $3',
      [u.preview_path, u.full_path, u.id]
    );
  }
  console.log('OK', updates.length, 'faixas atualizadas.');
})().catch(err => { console.error('ERRO:', err.message); process.exit(1); });
