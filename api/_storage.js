/* ============================================================
   api/_storage.js — Backblaze B2 (Versão Final Auditada)
   ------------------------------------------------------------
   Correções aplicadas (Etapa 10):
   - resolveBucket(): traduz nomes lógicos (site-assets, audio-*)
     para os buckets físicos configurados
   - createSignedUploadUrl: assinatura (bucketOrKind, key, contentType, expiresIn)
   - validateObjectKey: previne path traversal (../)
   - getPublicUrl: usa B2_IMAGE_PUBLIC_URL só para imagens
   - getS3Client: valida config e recria se variáveis mudarem
   ============================================================ */

'use strict';

const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;
let clientFingerprint = null;

function requiredEnv(name, fallback = '') {
  return String(process.env[name] || fallback).trim();
}

function getStorageConfig() {
  const region = requiredEnv('B2_MEDIA_REGION', process.env.B2_REGION);
  const keyId = requiredEnv('B2_KEY_ID');
  const applicationKey = requiredEnv('B2_APPLICATION_KEY');

  if (!region || !keyId || !applicationKey) {
    const err = new Error('Backblaze B2 não configurado.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const endpoint = requiredEnv(
    'B2_MEDIA_ENDPOINT',
    process.env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`
  ).replace(/\/+$/, '');

  const publicBaseUrl = requiredEnv(
    'B2_PUBLIC_BASE_URL',
    publicBaseUrlForRegion(region)
  ).replace(/\/+$/, '');

  if (!endpoint.startsWith('https://')) {
    throw new Error('Endpoint B2 inválido.');
  }

  return {
    region,
    keyId,
    applicationKey,
    endpoint,
    publicBaseUrl
  };
}

function publicBaseUrlForRegion(region) {
  const match = String(region).match(/(\d{3})$/);
  if (!match) return '';
  return `https://f${match[1]}.backblazeb2.com/file`;
}

function getImageBucket() {
  return requiredEnv('B2_IMAGE_BUCKET', 'joseph.matthos');
}

function getAudioBucket() {
  return requiredEnv('B2_AUDIO_BUCKET', 'josephmatthos');
}

/**
 * Traduz um nome lógico de bucket para o bucket físico configurado.
 * Aceita tanto o nome lógico (site-assets, audio-preview, audio-full)
 * quanto o nome físico do bucket.
 */
function resolveBucket(bucketOrKind) {
  if (!bucketOrKind || typeof bucketOrKind !== 'string') {
    throw new Error('Bucket inválido.');
  }

  const value = bucketOrKind.trim();
  const imageBucket = getImageBucket();
  const audioBucket = getAudioBucket();

  const map = {
    image: imageBucket,
    'site-assets': imageBucket,
    'audio-preview': audioBucket,
    'audio-full': audioBucket,
    'audio-premium': audioBucket
  };

  if (map[value]) return map[value];

  if (value === imageBucket || value === audioBucket) return value;

  throw new Error(`Bucket não reconhecido: ${value}`);
}

function getBucketForKind(kind) {
  try {
    return resolveBucket(kind);
  } catch {
    return null;
  }
}

function getS3Client() {
  const config = getStorageConfig();

  const fingerprint = [
    config.region,
    config.endpoint,
    config.keyId,
    config.applicationKey
  ].join('|');

  if (!client || fingerprint !== clientFingerprint) {
    if (client) {
      try { client.destroy(); } catch {}
    }

    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.keyId,
        secretAccessKey: config.applicationKey
      }
    });

    clientFingerprint = fingerprint;
  }

  return client;
}

function validateObjectKey(key) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('Caminho do arquivo inválido.');
  }

  const normalized = key.trim();

  if (
    normalized.startsWith('/') ||
    normalized.includes('\\') ||
    normalized.split('/').some(seg => !seg || seg === '.' || seg === '..')
  ) {
    throw new Error('Caminho do arquivo não permitido.');
  }

  return normalized;
}

function encodeKey(key) {
  return validateObjectKey(key)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function getPublicUrl(bucketOrKind, key) {
  const config = getStorageConfig();
  const bucket = resolveBucket(bucketOrKind);
  const encodedKey = encodeKey(key);
  const imageBucket = getImageBucket();
  const imagePublicUrl = requiredEnv('B2_IMAGE_PUBLIC_URL').replace(/\/+$/, '');

  if (bucket === imageBucket && imagePublicUrl) {
    return `${imagePublicUrl}/${encodedKey}`;
  }

  return `${config.publicBaseUrl}/${encodeURIComponent(bucket)}/${encodedKey}`;
}

async function uploadObject(bucketOrKind, key, body, contentType) {
  const bucket = resolveBucket(bucketOrKind);
  const objectKey = validateObjectKey(key);

  if (!body) throw new Error('Conteúdo do arquivo não informado.');
  if (typeof contentType !== 'string' || !contentType.trim()) {
    throw new Error('Content-Type inválido.');
  }

  return getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType.trim()
  }));
}

/**
 * Gera URL assinada de upload.
 * ★ Assinatura: createSignedUploadUrl(bucketOrKind, key, contentType, expiresInSec)
 * O admin.js agora deve chamar com 4 argumentos.
 */
async function createSignedUploadUrl(bucketOrKind, key, contentType, expiresInSec = 900) {
  const bucket = resolveBucket(bucketOrKind);
  const objectKey = validateObjectKey(key);

  if (typeof contentType !== 'string' || !contentType.trim()) {
    throw new Error('Content-Type inválido.');
  }

  if (!Number.isInteger(expiresInSec) || expiresInSec < 60 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido (60s a 3600s).');
  }

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ContentType: contentType.trim()
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, {
    expiresIn: expiresInSec
  });

  return { uploadUrl, token: uploadUrl };
}

async function objectExists(bucketOrKind, key) {
  const bucket = resolveBucket(bucketOrKind);
  const objectKey = validateObjectKey(key);

  try {
    await getS3Client().send(new HeadObjectCommand({
      Bucket: bucket,
      Key: objectKey
    }));
    return true;
  } catch (err) {
    if (
      err?.$metadata?.httpStatusCode === 404 ||
      err?.name === 'NotFound' ||
      err?.name === 'NoSuchKey'
    ) {
      return false;
    }
    throw err;
  }
}

async function createSignedDownloadUrl(bucketOrKind, key, expiresInSec = 300, downloadFilename) {
  const bucket = resolveBucket(bucketOrKind);
  const objectKey = validateObjectKey(key);

  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de download inválido (1s a 3600s).');
  }

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ...(downloadFilename
      ? {
          ResponseContentDisposition:
            `attachment; filename="${String(downloadFilename).replace(/["\\\r\n]/g, '_')}"`
        }
      : {})
  });

  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
}

/**
 * Gera URL temporária para reprodução de áudio.
 * O banco armazena o caminho completo (ex: "pesodacaneta/...").
 * NENHUM prefixo adicional deve ser adicionado aqui.
 */
async function getPlaybackUrl(key, isFull = false) {
  if (!key || typeof key !== 'string') {
    throw new Error('Chave do áudio não informada.');
  }

  const bucket = getBucketForKind(isFull ? 'audio-full' : 'audio-preview');
  if (!bucket) throw new Error('Bucket de áudio não configurado.');

  const ttl = Number(process.env.SIGNED_URL_TTL_SEC || 300);
  const expiresInSec = Number.isInteger(ttl) && ttl >= 1 && ttl <= 3600 ? ttl : 300;

  return createSignedDownloadUrl(bucket, key, expiresInSec);
}

module.exports = {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  getBucketForKind,
  getPlaybackUrl,
  getPublicUrl,
  getStorageConfig,
  objectExists,
  uploadObject
};