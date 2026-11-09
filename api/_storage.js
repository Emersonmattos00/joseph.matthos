'use strict';

const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client;
let _configCache = null;

/* ============================================================
   CONFIGURAÇÃO (Baseada no .env fornecido)
   ============================================================ */
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

  // B2_PUBLIC_BASE_URL ou fallback padrão do B2
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

/* ============================================================
   RESOLUÇÃO DE PREFIXOS E BUCKET
   ============================================================ */
// Retorna o prefixo de pasta baseado no seu .env
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

// Sempre retorna o bucket físico central
function resolveBucket() {
  return getStorageConfig().mediaBucket;
}

// Monta o caminho final concatenando o prefixo + nome do arquivo
function buildPathForKind(kind, filename) {
  const prefix = getPrefixForKind(kind);
  if (!prefix) {
    const err = new Error('Tipo de mídia inválido.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  // Remove barras extras e garante caminho limpo
  return `${prefix}/${String(filename).replace(/^\/+/, '')}`;
}

/* ============================================================
   VALIDAÇÃO DE CHAVES
   ============================================================ */
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

/* ============================================================
   URL PÚBLICA
   ============================================================ */
function getPublicUrl(key) {
  if (!key) throw new Error('Caminho é obrigatório.');
  validateObjectKey(key);
  
  const { publicBaseUrl, mediaBucket } = getStorageConfig();
  
  // Se você tiver um domínio customizado para imagens (B2_IMAGE_PUBLIC_URL)
  // Ex: https://img.seudominio.com
  const customImageUrl = String(process.env.B2_IMAGE_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (customImageUrl && key.startsWith(getPrefixForKind('image'))) {
    // Remove o prefixo base (ex: "assets/img") para colar direto na URL customizada,
    // ou mantém se o CDN esperar o path completo. Ajuste conforme sua Cloudflare/CDN.
    return `${customImageUrl}/${encodeKey(key)}`;
  }

  // URL padrão do B2: https://f005.backblazeb2.com/file/BUCKET/KEY
  return `${publicBaseUrl}/${encodeURIComponent(mediaBucket)}/${encodeKey(key)}`;
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/* ============================================================
   OPERAÇÕES NO S3
   ============================================================ */
async function uploadObject(key, body, contentType) {
  validateObjectKey(key);
  if (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
    throw new Error('Content-Type inválido.');
  }

  const bucket = resolveBucket();
  return getS3Client().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType
  }));
}

async function createSignedUploadUrl(key, contentType, expiresInSec = 900) {
  validateObjectKey(key);
  if (typeof contentType !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(contentType)) {
    throw new Error('Content-Type inválido.');
  }
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }

  const bucket = resolveBucket();
  const command = new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: contentType
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

module.exports = {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  getObjectMetadata,
  getPublicUrl,
  objectExists,
  uploadObject,
  buildPathForKind
};