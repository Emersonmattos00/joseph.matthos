'use strict';

const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client;

function getStorageConfig() {
  const region = String(process.env.B2_MEDIA_REGION || process.env.B2_REGION || '').trim();
  const keyId = String(process.env.B2_KEY_ID || '').trim();
  const applicationKey = String(process.env.B2_APPLICATION_KEY || '').trim();

  if (!region || !keyId || !applicationKey) {
    const err = new Error('Backblaze B2 não configurado.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const publicBaseUrl = String(
    process.env.B2_PUBLIC_BASE_URL || publicBaseUrlForRegion(region)
  ).trim().replace(/\/+$/, '');

  return {
    region,
    keyId,
    applicationKey,
    endpoint: String(
      process.env.B2_MEDIA_ENDPOINT || process.env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`
    ).trim().replace(/\/+$/, ''),
    publicBaseUrl
  };
}

function publicBaseUrlForRegion(region) {
  const match = String(region).match(/(\d{3})$/);
  if (!match) return '';
  return `https://f${match[1]}.backblazeb2.com/file`;
}

function getS3Client() {
  if (!client) {
    const config = getStorageConfig();
    client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.keyId,
        secretAccessKey: config.applicationKey
      }
    });
  }
  return client;
}

function getBucketForKind(kind) {
  const bucket = String(process.env.B2_MEDIA_BUCKET || '').trim();
  if (!bucket) {
    throw new Error('B2_MEDIA_BUCKET não configurado.');
  }

  const valid = new Set([
    'image',
    'site-assets',
    'audio-preview',
    'audio-full',
    'audio-premium'
  ]);

  return valid.has(kind) ? bucket : null;
}

function getPublicUrl(bucket, key) {
  const { publicBaseUrl } = getStorageConfig();
  if (!bucket || !key) throw new Error('Bucket e caminho são obrigatórios.');
  const imagePublicUrl = String(process.env.B2_IMAGE_PUBLIC_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const mediaBucket = String(process.env.B2_MEDIA_BUCKET || '').trim();
  if (imagePublicUrl && bucket === mediaBucket) {
    return `${imagePublicUrl}/${encodeKey(key)}`;
  }
  return `${publicBaseUrl}/${encodeURIComponent(bucket)}/${encodeKey(key)}`;
}

function encodeKey(key) {
  return String(key)
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function uploadObject(bucket, key, body, contentType) {
  return getS3Client().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType
  }));
}

async function createSignedUploadUrl(bucket, key, contentType, expiresInSec) {
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType
  });
  const uploadUrl = await getSignedUrl(getS3Client(), command, {
    expiresIn: expiresInSec
  });
  return { uploadUrl };
}

async function objectExists(bucket, key) {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
      return false;
    }
    throw err;
  }
}

async function createSignedDownloadUrl(bucket, key, expiresInSec, downloadFilename) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ...(downloadFilename
      ? { ResponseContentDisposition: `attachment; filename="${downloadFilename}"` }
      : {})
  });
  return getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
}

/**
 * Gera URL temporária para reprodução de áudio.
 * isFull=true  → bucket audio-premium
 * isFull=false → bucket audio-preview
 */
async function getPlaybackUrl(key, isFull = false) {
  if (!key || typeof key !== 'string') {
    throw new Error('Chave do áudio não informada.');
  }

  const bucket = getBucketForKind(isFull ? 'audio-full' : 'audio-preview');

  if (!bucket) {
    throw new Error('Bucket de áudio não configurado.');
  }

  // 5 minutos
  return createSignedDownloadUrl(bucket, key, 300);
}

module.exports = {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  getBucketForKind,
  getPlaybackUrl,          // ← adicione esta linha
  getPublicUrl,
  getStorageConfig,
  objectExists,
  uploadObject
};