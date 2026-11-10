'use strict';

/* ============================================================
   api/_storage.js — Backblaze B2 via S3 API
   ------------------------------------------------------------
   - Um bucket físico (B2_MEDIA_BUCKET), prefixos por tipo
   - Validação estrita de MIME, extensão e tamanho
   - URLs assinadas com prazo curto
   - Compatível com admin.js (buildPathForKind) e stream.js (getPlaybackUrl)
   ============================================================ */

const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client;
let _configCache = null;

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO (cacheada)
// ─────────────────────────────────────────────────────────────
function getStorageConfig() {
  if (_configCache) return _configCache;

  const region = String(process.env.B2_REGION || '').trim();
  const keyId = String(process.env.B2_KEY_ID || '').trim();
  const applicationKey = String(process.env.B2_APPLICATION_KEY || '').trim();
  const mediaBucket = String(process.env.B2_MEDIA_BUCKET || 'josephmatthos').trim();

  if (!region || !keyId || !applicationKey) {
    const err = new Error('Backblaze B2 não configurado.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const publicBaseUrl = String(
    process.env.B2_PUBLIC_BASE_URL || `https://f005.backblazeb2.com/file`
  ).trim().replace(/\/+$/, '');

  const endpoint = String(
    process.env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`
  ).trim().replace(/\/+$/, '');

  _configCache = { region, keyId, applicationKey, mediaBucket, publicBaseUrl, endpoint };
  return _configCache;
}

function getS3Client() {
  if (!client) {
    const config = getStorageConfig();
    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.keyId, secretAccessKey: config.applicationKey }
    });
  }
  return client;
}

// ─────────────────────────────────────────────────────────────
// PREFIXOS POR TIPO
// ─────────────────────────────────────────────────────────────
function getPrefixForKind(kind) {
  switch (kind) {
    case 'image':
    case 'site-assets':
      return String(process.env.B2_BUCKET_SITE_ASSETS || 'images').replace(/^\/|\/$/g, '');
    case 'audio-preview':
      return String(process.env.B2_BUCKET_AUDIO_PREVIEW || 'preview').replace(/^\/|\/$/g, '');
    case 'audio-full':
    case 'audio-premium':
      return String(process.env.B2_BUCKET_AUDIO_PREMIUM || 'audio').replace(/^\/|\/$/g, '');
    default:
      return null;
  }
}

function resolveBucket() {
  return getStorageConfig().mediaBucket;
}

function buildPathForKind(kind, filename) {
  const prefix = getPrefixForKind(kind);
  if (!prefix) {
    const err = new Error('Tipo de mídia inválido.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  return `${prefix}/${String(filename).replace(/^\/+/, '')}`;
}

// ─────────────────────────────────────────────────────────────
// VALIDAÇÕES
// ─────────────────────────────────────────────────────────────
const MIME_BY_KIND = {
  'image': new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']),
  'audio-preview': new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm']),
  'audio-full': new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/wav', 'audio/x-wav'])
};

const EXT_BY_KIND = {
  'image': new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']),
  'audio-preview': new Set(['mp3', 'm4a', 'aac', 'ogg', 'webm']),
  'audio-full': new Set(['mp3', 'm4a', 'aac', 'ogg', 'webm', 'flac', 'wav'])
};

function validateObjectKey(key) {
  if (
    typeof key !== 'string' || !key.trim() || key.length > 1024 ||
    key.startsWith('/') || key.includes('\\') ||
    /[\x00-\x1F\x7F]/.test(key) ||
    key.split('/').some(seg => !seg || seg === '.' || seg === '..')
  ) {
    throw new Error('Caminho de arquivo inválido.');
  }
  return key;
}

function validateMimeForKind(kind, mime) {
  const allowed = MIME_BY_KIND[kind] || MIME_BY_KIND[Object.keys(MIME_BY_KIND).find(k => kind.includes(k))];
  if (!allowed) throw new Error('Tipo de mídia inválido.');
  if (!allowed.has(String(mime).toLowerCase())) {
    throw new Error(`Content-Type não permitido para ${kind}.`);
  }
}

function validateExtForKind(kind, filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  if (!ext || !/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('Extensão inválida.');
  const allowed = EXT_BY_KIND[kind] || EXT_BY_KIND[Object.keys(EXT_BY_KIND).find(k => kind.includes(k))];
  if (!allowed || !allowed.has(ext)) throw new Error(`Extensão ".${ext}" não permitida para ${kind}.`);
  return ext;
}

// ─────────────────────────────────────────────────────────────
// URL PÚBLICA
// ─────────────────────────────────────────────────────────────
function getPublicUrl(key) {
  if (!key) throw new Error('Caminho é obrigatório.');
  validateObjectKey(key);

  const { publicBaseUrl, mediaBucket } = getStorageConfig();
  const customImageUrl = String(process.env.B2_IMAGE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const imagePrefix = getPrefixForKind('image');

  if (customImageUrl && key.startsWith(imagePrefix + '/')) {
    return `${customImageUrl}/${encodeKey(key)}`;
  }

  return `${publicBaseUrl}/${encodeURIComponent(mediaBucket)}/${encodeKey(key)}`;
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

// ─────────────────────────────────────────────────────────────
// OPERAÇÕES S3
// ─────────────────────────────────────────────────────────────
async function uploadObject(key, body, contentType) {
  validateObjectKey(key);

  const kind = inferKindFromKey(key);
  validateMimeForKind(kind, contentType);

  if (!body || body.length === 0) throw new Error('Arquivo vazio.');
  if (body.length > 200 * 1024 * 1024) throw new Error('Arquivo excede o tamanho máximo.');

  const bucket = resolveBucket();
  return getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
}

async function createSignedUploadUrl(key, contentType, expiresInSec = 900) {
  validateObjectKey(key);

  const kind = inferKindFromKey(key);
  validateMimeForKind(kind, contentType);

  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }

  const bucket = resolveBucket();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
  return { uploadUrl };
}

async function getObjectMetadata(key) {
  validateObjectKey(key);
  const bucket = resolveBucket();

  try {
    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentLength: Number(head.ContentLength) || 0,
      contentType: head.ContentType || null,
      etag: head.ETag || null,
      lastModified: head.LastModified || null
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
      return null;
    }
    throw err;
  }
}

async function objectExists(key) {
  return (await getObjectMetadata(key)) !== null;
}

async function createSignedDownloadUrl(key, expiresInSec, downloadFilename) {
  validateObjectKey(key);

  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }

  const bucket = resolveBucket();
  let safeFilename = null;
  if (downloadFilename) {
    safeFilename = String(downloadFilename).replace(/[\r\n"\\]/g, '_').replace(/[^\w.\- ]/g, '_').slice(0, 150);
    if (!safeFilename) safeFilename = null;
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(safeFilename ? { ResponseContentDisposition: `attachment; filename="${safeFilename}"` } : {})
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
}

async function getPlaybackUrl(key, isFull = false) {
  if (!key) throw new Error('Chave do áudio não informada.');
  validateObjectKey(key);
  return createSignedDownloadUrl(key, 300);
}

// ─────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────
function inferKindFromKey(key) {
  const prefix = String(key).split('/')[0];
  const map = {
    [getPrefixForKind('image')]: 'image',
    [getPrefixForKind('audio-preview')]: 'audio-preview',
    [getPrefixForKind('audio-full')]: 'audio-full'
  };
  return map[prefix] || 'audio-full';
}

// ─────────────────────────────────────────────────────────────
// EXPORTAÇÕES
// ─────────────────────────────────────────────────────────────
module.exports = {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  getObjectMetadata,
  getPublicUrl,
  getPlaybackUrl,
  objectExists,
  uploadObject,
  buildPathForKind,
  validateExtForKind,
  validateMimeForKind
};