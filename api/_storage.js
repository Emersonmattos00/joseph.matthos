'use strict';

/* ============================================================
   api/_storage.js — Cloudflare R2 via S3 API (v2.0)
   ------------------------------------------------------------
   - Dois buckets lógicos: público (imagens/prévias) e privado (áudio completo)
   - Validação estrita de MIME, extensão e tamanho
   - URLs assinadas com prazo curto (15 min para upload, 5 min para download)
   - Compatível com uploads.js v10.15 (buildPathForKind, getPlaybackUrl)
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

  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
  
  const publicBucket = String(process.env.R2_PUBLIC_BUCKET || 'public-assets').trim();
  const privateBucket = String(process.env.R2_PRIVATE_BUCKET || 'private-audio').trim();
  const publicDomain = String(process.env.R2_PUBLIC_DOMAIN || `https://${accountId}.r2.cloudflarestorage.com`).trim().replace(/\/+$/, '');

  if (!accountId || !accessKeyId || !secretAccessKey) {
    const err = new Error('Cloudflare R2 não configurado. Verifique as variáveis de ambiente.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  _configCache = { 
    accountId, 
    accessKeyId, 
    secretAccessKey, 
    publicBucket, 
    privateBucket, 
    publicDomain 
  };
  return _configCache;
}

function getS3Client() {
  if (!client) {
    const config = getStorageConfig();
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true, // Obrigatório para Cloudflare R2
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey
      }
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
      return String(process.env.R2_PREFIX_IMAGES || 'images').replace(/^\/|\/$/g, '');
    case 'audio-preview':
      return String(process.env.R2_PREFIX_PREVIEW || 'preview').replace(/^\/|\/$/g, '');
    case 'audio-full':
    case 'audio-premium':
      return String(process.env.R2_PREFIX_AUDIO || 'audio').replace(/^\/|\/$/g, '');
    default:
      return null;
  }
}

function resolveBucket(kind) {
  // Áudio completo vai para o bucket privado; o resto para o público
  if (kind === 'audio-full' || kind === 'audio-premium') {
    return getStorageConfig().privateBucket;
  }
  return getStorageConfig().publicBucket;
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
  'audio-preview': new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/flac']),
  'audio-full': new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/flac', 'audio/wav', 'audio/x-wav'])
};

const EXT_BY_KIND = {
  'image': new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']),
  'audio-preview': new Set(['mp3', 'm4a', 'aac', 'ogg', 'webm', 'wav', 'flac']),
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

  const { publicDomain, publicBucket } = getStorageConfig();
  const customImageUrl = String(process.env.R2_CUSTOM_IMAGE_DOMAIN || '').trim().replace(/\/+$/, '');
  const imagePrefix = getPrefixForKind('image');

  if (customImageUrl && key.startsWith(imagePrefix + '/')) {
    return `${customImageUrl}/${encodeKey(key)}`;
  }

  return `${publicDomain}/${publicBucket}/${encodeKey(key)}`;
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

// ─────────────────────────────────────────────────────────────
// OPERAÇÕES S3
// ─────────────────────────────────────────────────────────────
async function uploadObject(key, body, contentType, kind) {
  validateObjectKey(key);
  validateMimeForKind(kind, contentType);

  if (!body || body.length === 0) throw new Error('Arquivo vazio.');
  if (body.length > 200 * 1024 * 1024) throw new Error('Arquivo excede o tamanho máximo (200MB).');

  const bucket = resolveBucket(kind);
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
    throw new Error('Prazo de assinatura inválido (1 a 3600 segundos).');
  }

  const bucket = resolveBucket(kind);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
  return { uploadUrl, path: key, bucket, expiresIn: expiresInSec };
}

async function getObjectMetadata(key) {
  validateObjectKey(key);
  const bucket = resolveBucket(inferKindFromKey(key));

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

async function createSignedDownloadUrl(key, expiresInSec = 300, downloadFilename = null) {
  validateObjectKey(key);

  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }

  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);
  
  let safeFilename = null;
  if (downloadFilename) {
    safeFilename = String(downloadFilename).replace(/[\r\n"\\]/g, '_').replace(/[^\w.\- ]/g, '_').slice(0, 150);
    if (!safeFilename) safeFilename = null;
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(safeFilename ? { ResponseContentDisposition: `attachment; filename="${encodeURIComponent(safeFilename)}"` } : {})
  });

  const url = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
  return { url, expiresIn: expiresInSec };
}

async function getPlaybackUrl(key, isFull = false) {
  if (!key) throw new Error('Chave do áudio não informada.');
  validateObjectKey(key);
  
  // Playback usa URL assinada de 5 minutos sem forçar download (inline)
  const { url } = await createSignedDownloadUrl(key, 300, null);
  return url;
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
  validateMimeForKind,
  resolveBucket,
  inferKindFromKey
};
