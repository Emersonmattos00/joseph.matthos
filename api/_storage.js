'use strict';

/* ============================================================
   api/_storage.js — Cloudflare R2 via S3 API (v3.0)
   ------------------------------------------------------------
   Correções da auditoria v3.4 (admin.js v3.5):
   1. Quarentena: uploads assinados vão para _quarantine/
   2. promoteFromQuarantine(): copia para caminho definitivo
   3. deleteObject(): remove objeto (quarentena ou definitivo)
   4. purgeOldQuarantine(): limpa temporários antigos
   5. inferKindFromKey() agora reconhece _quarantine/ e prefixos
   ============================================================ */

const {
  GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
  CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;
let _configCache = null;

// ─────────────────────────────────────────────────────────────
// Matriz canônica (Fonte da Verdade)
// ─────────────────────────────────────────────────────────────
const ALLOWED_MEDIA = {
  'image': {
    exts: new Set(['jpg','jpeg','png','webp','gif','avif']),
    mimes: new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']),
    bucket: 'public',
    maxBytes: 10 * 1024 * 1024 // 10 MB
  },
  'audio-preview': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/wav','audio/x-wav','audio/flac','audio/aiff','audio/x-aiff']),
    bucket: 'public',
    maxBytes: 50 * 1024 * 1024 // 50 MB
  },
  'audio-full': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/flac','audio/wav','audio/x-wav','audio/aiff','audio/x-aiff']),
    bucket: 'private',
    maxBytes: 200 * 1024 * 1024 // 200 MB
  }
};

const EXT_TO_MIMES = {
  mp3: ['audio/mpeg'], m4a: ['audio/mp4'], mp4: ['audio/mp4'], aac: ['audio/aac'],
  ogg: ['audio/ogg'], oga: ['audio/ogg'], opus: ['audio/opus'], webm: ['audio/webm'],
  wav: ['audio/wav','audio/x-wav'], flac: ['audio/flac'],
  aif: ['audio/aiff','audio/x-aiff'], aiff: ['audio/aiff','audio/x-aiff'],
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'], png: ['image/png'],
  webp: ['image/webp'], gif: ['image/gif'], avif: ['image/avif']
};

const QUARANTINE_PREFIX = '_quarantine';
const QUARANTINE_TTL_HOURS_DEFAULT = 24;

// ─────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────
function validatePublicUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:') throw new Error('Deve ser HTTPS');
    if (u.username || u.password) throw new Error('Credenciais não permitidas na URL');
    if (u.search || u.hash) throw new Error('Query string ou hash não permitidos');
    return u.origin;
  } catch {
    return null;
  }
}

function getStorageConfig() {
  if (_configCache) return _configCache;

  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const publicBucket = String(process.env.R2_PUBLIC_BUCKET || '').trim();
  const privateBucket = String(process.env.R2_PRIVATE_BUCKET || '').trim();

  const s3Endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const s3Host = `${accountId}.r2.cloudflarestorage.com`;

  const publicBaseUrl = validatePublicUrl(process.env.R2_PUBLIC_BASE_URL);
  if (!publicBaseUrl) {
    throw new Error('[storage] R2_PUBLIC_BASE_URL é obrigatório e deve ser uma URL HTTPS válida.');
  }

  const customImageDomain = validatePublicUrl(process.env.R2_CUSTOM_IMAGE_DOMAIN) || null;

  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('[storage] R2_ACCOUNT_ID inválido.');
  if (!accessKeyId || !secretAccessKey) throw new Error('[storage] Credenciais R2 ausentes.');

  const bucketRe = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  if (!bucketRe.test(publicBucket) || !bucketRe.test(privateBucket)) {
    throw new Error('[storage] Nomes de bucket R2 inválidos.');
  }
  if (publicBucket === privateBucket) {
    throw new Error('[storage] Buckets público e privado devem ser diferentes.');
  }

  const prefixes = {
    'image': String(process.env.R2_PREFIX_IMAGE || 'images').replace(/^\/+|\/+$/g, ''),
    'audio-preview': String(process.env.R2_PREFIX_PREVIEW || 'preview').replace(/^\/+|\/+$/g, ''),
    'audio-full': String(process.env.R2_PREFIX_AUDIO || 'audio').replace(/^\/+|\/+$/g, '')
  };

  const prefixRe = /^[a-z][a-z0-9_-]{0,62}$/;
  const prefixVals = Object.values(prefixes).map(p => p.toLowerCase());
  for (const p of prefixVals) {
    if (!prefixRe.test(p)) throw new Error(`[storage] Prefixo "${p}" inválido.`);
  }
  if (new Set(prefixVals).size !== prefixVals.length) {
    throw new Error('[storage] Prefixos R2 devem ser distintos.');
  }

  _configCache = {
    accountId, accessKeyId, secretAccessKey,
    publicBucket, privateBucket,
    s3Endpoint, s3Host,
    publicBaseUrl, customImageDomain,
    prefixes
  };
  return _configCache;
}

function getS3Client() {
  if (!client) {
    const c = getStorageConfig();
    client = new S3Client({
      region: 'auto',
      endpoint: c.s3Endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
    });
  }
  return client;
}

// ─────────────────────────────────────────────────────────────
// Validação de caminhos e tipos
// ─────────────────────────────────────────────────────────────
function resolveKindEntry(kind) {
  if (typeof kind !== 'string') return null;
  const normalized = kind.toLowerCase().trim();
  if (ALLOWED_MEDIA[normalized]) return { kind: normalized, entry: ALLOWED_MEDIA[normalized] };
  return null;
}

function validateObjectKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > 1024) throw new Error('Caminho inválido.');
  if (key.startsWith('/') || key.endsWith('/') || key.includes('\\')) throw new Error('Caminho inválido.');
  if (/[\x00-\x1F\x7F]/.test(key)) throw new Error('Caminho contém caracteres de controle.');
  for (const seg of key.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error('Segmento de caminho inválido.');
  }
  return key;
}

function validateFilename(filename) {
  const name = String(filename || '').trim();
  if (!name || name.length > 255) throw new Error('Nome de arquivo inválido.');
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('Nome de arquivo inválido.');
  }
  if (/[\x00-\x1F\x7F]/.test(name) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Nome contém caracteres não permitidos.');
  }
  return name;
}

function validateMimeForKind(kind, mime) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const m = String(mime || '').toLowerCase();
  if (!resolved.entry.mimes.has(m)) throw new Error(`Content-Type não permitido para ${resolved.kind}.`);
  return m;
}

function validateExtForKind(kind, filenameOrKey) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const name = String(filenameOrKey || '');
  const lastSeg = name.split('/').pop() || '';
  const dot = lastSeg.lastIndexOf('.');
  if (dot < 0) throw new Error('Arquivo sem extensão.');
  const ext = lastSeg.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('Extensão inválida.');
  if (!resolved.entry.exts.has(ext)) throw new Error(`Extensão ".${ext}" não permitida.`);
  return ext;
}

function validateMimeExtConsistency(kind, mime, filenameOrKey) {
  const ext = validateExtForKind(kind, filenameOrKey);
  const normalizedMime = String(mime || '').toLowerCase();
  const allowed = EXT_TO_MIMES[ext];
  if (!allowed) return;
  if (!allowed.includes(normalizedMime)) {
    throw new Error(`Extensão ".${ext}" incompatível com Content-Type ${normalizedMime}.`);
  }
}

// ─────────────────────────────────────────────────────────────
// QUARENTENA — funções de caminho
// ─────────────────────────────────────────────────────────────
function isQuarantinePath(key) {
  return String(key || '').startsWith(QUARANTINE_PREFIX + '/');
}

function buildQuarantinePath(kind, ext) {
  const safeKind = String(kind).replace(/[^a-z0-9-]/gi, '');
  const ts = Date.now();
  const hex = require('crypto').randomBytes(8).toString('hex');
  return `${QUARANTINE_PREFIX}/${safeKind}/${ts}_${hex}.${ext}`;
}

function buildDefinitivePath(kind, ext) {
  const config = getStorageConfig();
  const prefix = config.prefixes[kind] || 'audio';
  const ts = Date.now();
  const hex = require('crypto').randomBytes(8).toString('hex');
  return `${prefix}/${ts}_${hex}.${ext}`;
}

/**
 * Mantido por compatibilidade com admin.js.
 * Sempre retorna caminho de quarentena.
 */
function buildPathForKind(kind, filename) {
  const ext = validateExtForKind(kind, filename);
  return buildQuarantinePath(kind, ext);
}

// ─────────────────────────────────────────────────────────────
// Kind a partir de chave (quarentena ou definitivo)
// ─────────────────────────────────────────────────────────────
function inferKindFromKey(key) {
  validateObjectKey(key);
  const k = String(key);

  if (k.startsWith(QUARANTINE_PREFIX + '/')) {
    const after = k.slice(QUARANTINE_PREFIX.length + 1);
    const first = after.split('/')[0];
    if (first === 'audio-full' || first === 'audio-preview' || first === 'image') return first;
    const err = new Error('Caminho de quarentena com kind inválido.');
    err.code = 'INVALID_KEY_PREFIX';
    throw err;
  }

  const config = getStorageConfig();
  const first = k.split('/')[0];
  for (const [kind, prefix] of Object.entries(config.prefixes)) {
    if (first === prefix) return kind;
  }
  const err = new Error('Prefixo de objeto não reconhecido.');
  err.code = 'INVALID_KEY_PREFIX';
  throw err;
}

function resolveBucket(kind) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) {
    const err = new Error('Tipo de mídia desconhecido.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  const config = getStorageConfig();
  return resolved.entry.bucket === 'private' ? config.privateBucket : config.publicBucket;
}

function getPrefixForKind(kind) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  return getStorageConfig().prefixes[resolved.kind];
}

// ─────────────────────────────────────────────────────────────
// URLs públicas
// ─────────────────────────────────────────────────────────────
function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function getPublicUrl(key) {
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);

  if (isQuarantinePath(key)) {
    const err = new Error('Objetos em quarentena não possuem URL pública.');
    err.code = 'NOT_PUBLIC';
    throw err;
  }

  const kind = inferKindFromKey(key);
  const entry = ALLOWED_MEDIA[kind];
  if (entry.bucket !== 'public') {
    const err = new Error(`Tipo "${kind}" não possui URL pública. Use getPlaybackUrl() ou createSignedDownloadUrl().`);
    err.code = 'NOT_PUBLIC';
    throw err;
  }

  const config = getStorageConfig();
  const imagePrefix = config.prefixes['image'];

  if (config.customImageDomain && key.startsWith(imagePrefix + '/')) {
    return `${config.customImageDomain}/${encodeKey(key)}`;
  }
  return `${config.publicBaseUrl}/${encodeKey(key)}`;
}

// ─────────────────────────────────────────────────────────────
// Upload direto (imagens pequenas)
// ─────────────────────────────────────────────────────────────
async function uploadObject(key, body, contentType) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  const entry = ALLOWED_MEDIA[kind];

  validateMimeForKind(kind, contentType);
  validateMimeExtConsistency(kind, contentType, key);

  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError('Body deve ser Buffer ou Uint8Array.');
  }
  const size = body.byteLength;
  if (!size) throw new Error('Arquivo vazio.');
  if (size > entry.maxBytes) {
    throw new Error(`Arquivo excede o limite para ${kind} (máx ${Math.round(entry.maxBytes / 1024 / 1024)}MB).`);
  }

  const bucket = resolveBucket(kind);
  return getS3Client().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType
  }));
}

// ─────────────────────────────────────────────────────────────
// URL assinada de upload (só quarentena)
// ─────────────────────────────────────────────────────────────
async function createSignedUploadUrl(key, contentType, sizeBytes, expiresInSec = 900) {
  validateObjectKey(key);

  if (!isQuarantinePath(key)) {
    const err = new Error('URL assinada deve apontar para quarentena.');
    err.code = 'INVALID_PATH';
    throw err;
  }

  const kind = inferKindFromKey(key);
  const entry = ALLOWED_MEDIA[kind];

  validateMimeForKind(kind, contentType);
  validateMimeExtConsistency(kind, contentType, key);

  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Error('Tamanho do arquivo inválido.');
  if (sizeBytes > entry.maxBytes) throw new Error(`Arquivo excede o limite para ${kind}.`);
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido (1–3600s).');
  }

  const bucket = resolveBucket(kind);
  const command = new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
  return {
    uploadUrl, path: key, bucket, kind,
    maxBytes: entry.maxBytes, expiresIn: expiresInSec,
    host: getStorageConfig().s3Host
  };
}

// ─────────────────────────────────────────────────────────────
// Metadados
// ─────────────────────────────────────────────────────────────
async function getObjectMetadata(key) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);

  try {
    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentLength: Number(head.ContentLength) || 0,
      contentType: head.ContentType || null,
      etag: head.ETag || null,
      lastModified: head.LastModified || null
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function objectExists(key) {
  return (await getObjectMetadata(key)) !== null;
}

// ─────────────────────────────────────────────────────────────
// Download assinado
// ─────────────────────────────────────────────────────────────
async function createSignedDownloadUrl(key, expiresInSec = 300, downloadFilename = null) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);

  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }

  const params = { Bucket: bucket, Key: key };
  if (downloadFilename) {
    const safe = String(downloadFilename)
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\w.\- ]/g, '_')
      .slice(0, 150) || 'download';
    params.ResponseContentDisposition =
      `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
  }

  const url = await getSignedUrl(getS3Client(), new GetObjectCommand(params), { expiresIn: expiresInSec });
  return { url, kind, bucket, expiresIn: expiresInSec };
}

/**
 * ⚠️ ATENÇÃO: Esta função APENAS gera a URL assinada.
 * O chamador DEVE verificar a autorização (assinatura, licença)
 * ANTES de chamar esta função.
 */
async function getPlaybackUrl(key) {
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);
  const { url } = await createSignedDownloadUrl(key, 300, null);
  return url;
}

// ─────────────────────────────────────────────────────────────
// PROMOÇÃO DE QUARENTENA
// ─────────────────────────────────────────────────────────────
async function promoteFromQuarantine(quarantineKey, kind) {
  if (!isQuarantinePath(quarantineKey)) {
    const err = new Error('promoteFromQuarantine exige caminho de quarentena.');
    err.code = 'INVALID_PATH';
    throw err;
  }

  const ext = String(quarantineKey).split('.').pop() || 'bin';
  const definitiveKey = buildDefinitivePath(kind, ext);

  const c = getS3Client();
  const bucket = resolveBucket(kind);

  await c.send(new CopyObjectCommand({
    Bucket: bucket,
    Key: definitiveKey,
    CopySource: `/${bucket}/${encodeURIComponent(quarantineKey).replace(/%2F/g, '/')}`,
    MetadataDirective: 'COPY'
  }));

  const meta = await getObjectMetadata(definitiveKey);
  if (!meta || meta.contentLength <= 0) {
    const err = new Error('Falha ao promover objeto — definitivo vazio.');
    err.code = 'PROMOTE_FAILED';
    throw err;
  }

  try {
    await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: quarantineKey }));
  } catch (err) {
    console.warn('[storage] falha ao apagar quarentena:', quarantineKey, err.message);
  }

  return { definitiveKey, meta };
}

// ─────────────────────────────────────────────────────────────
// Exclusão / limpeza
// ─────────────────────────────────────────────────────────────
async function deleteObject(key) {
  try {
    const kind = inferKindFromKey(key);
    const bucket = resolveBucket(kind);
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    console.warn('[storage] deleteObject falhou:', key, err.message);
    return false;
  }
}

async function purgeOldQuarantine(olderThanHours = QUARANTINE_TTL_HOURS_DEFAULT) {
  const c = getS3Client();
  const cutoff = Date.now() - olderThanHours * 3600 * 1000;
  let deleted = 0;

  for (const kind of Object.keys(ALLOWED_MEDIA)) {
    const bucket = resolveBucket(kind);
    const prefix = `${QUARANTINE_PREFIX}/${kind}/`;
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token
      }));
      for (const obj of list.Contents || []) {
        const lm = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        if (lm && lm < cutoff) {
          try {
            await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            deleted++;
          } catch (err) {
            console.warn('[storage] purge falhou:', obj.Key, err.message);
          }
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
  return { deleted };
}

// ─────────────────────────────────────────────────────────────
// Configuração pública (para o frontend)
// ─────────────────────────────────────────────────────────────
function getPublicR2Config() {
  const c = getStorageConfig();
  return {
    ok: true,
    accountId: c.accountId,
    publicBucket: c.publicBucket,
    privateBucket: c.privateBucket,
    s3Host: c.s3Host,
    publicBaseUrl: c.publicBaseUrl,
    customImageDomain: c.customImageDomain || null,
    prefixes: c.prefixes,
    allowedMedia: Object.fromEntries(
      Object.entries(ALLOWED_MEDIA).map(([k, v]) => [k, {
        exts: [...v.exts],
        mimes: [...v.mimes],
        bucket: v.bucket,
        maxBytes: v.maxBytes
      }])
    ),
    quarantine: {
      prefix: QUARANTINE_PREFIX,
      ttlHours: QUARANTINE_TTL_HOURS_DEFAULT
    }
  };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
  // Core
  createSignedUploadUrl, createSignedDownloadUrl, getPublicUrl, getPlaybackUrl,
  uploadObject, getObjectMetadata, objectExists, buildPathForKind,
  getPrefixForKind, inferKindFromKey, resolveBucket,
  validateObjectKey, validateFilename, validateExtForKind,
  validateMimeForKind, validateMimeExtConsistency, getPublicR2Config,
  ALLOWED_MEDIA, EXT_TO_MIMES,

  // Quarentena
  promoteFromQuarantine, buildQuarantinePath, buildDefinitivePath,
  isQuarantinePath, deleteObject, purgeOldQuarantine,
  QUARANTINE_PREFIX, QUARANTINE_TTL_HOURS_DEFAULT
};
