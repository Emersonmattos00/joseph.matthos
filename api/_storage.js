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
  const region = String(process.env.B2_REGION || '').trim();
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
      process.env.B2_ENDPOINT || `https://s3.${region}.backblazeb2.com`
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
  const buckets = {
    image: process.env.B2_BUCKET_SITE_ASSETS || 'site-assets',
    'audio-preview': process.env.B2_BUCKET_AUDIO_PREVIEW || 'audio-preview',
    'audio-full': process.env.B2_BUCKET_AUDIO_PREMIUM || 'audio-premium'
  };
  return buckets[kind] || null;
}

function getPublicUrl(bucket, key) {
  const { publicBaseUrl } = getStorageConfig();
  if (!bucket || !key) throw new Error('Bucket e caminho são obrigatórios.');
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

module.exports = {
  createSignedDownloadUrl,
  createSignedUploadUrl,
  getBucketForKind,
  getPublicUrl,
  getStorageConfig,
  objectExists,
  uploadObject
};