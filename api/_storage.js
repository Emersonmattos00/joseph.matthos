from pathlib import Path
code = r"""'use strict';

/* ============================================================
   api/_storage.js — Cloudflare R2 via S3 API (v5 hardened)
   ------------------------------------------------------------
   - Cloudflare R2 only (no Backblaze B2 dependency)
   - Separate public/private buckets
   - Quarantine ALWAYS stored in the private bucket
   - Signed uploads only to quarantine
   - Promotion validates size, MIME, extension and ETag
   - Legacy premium/ key compatibility
   ============================================================ */

const crypto = require('crypto');
const {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;
let _configCache = null;

const ALLOWED_MEDIA = {
  image: {
    exts: new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']),
    mimes: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']),
    bucket: 'public',
    maxBytes: 10 * 1024 * 1024
  },
  'audio-preview': {
    exts: new Set(['mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'wav', 'flac', 'aif', 'aiff']),
    mimes: new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aiff', 'audio/x-aiff']),
    bucket: 'public',
    maxBytes: 50 * 1024 * 1024
  },
  'audio-full': {
    exts: new Set(['mp3', 'm4a', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'webm', 'wav', 'flac', 'aif', 'aiff']),
    mimes: new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/webm', 'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aiff', 'audio/x-aiff']),
    bucket: 'private',
    maxBytes: 200 * 1024 * 1024
  }
};

const EXT_TO_MIMES = {
  mp3: ['audio/mpeg'],
  m4a: ['audio/mp4'],
  mp4: ['audio/mp4'],
  aac: ['audio/aac'],
  ogg: ['audio/ogg'],
  oga: ['audio/ogg'],
  opus: ['audio/opus', 'audio/ogg'],
  webm: ['audio/webm'],
  wav: ['audio/wav', 'audio/x-wav'],
  flac: ['audio/flac'],
  aif: ['audio/aiff', 'audio/x-aiff'],
  aiff: ['audio/aiff', 'audio/x-aiff'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  png: ['image/png'],
  webp: ['image/webp'],
  gif: ['image/gif'],
  avif: ['image/avif']
};

const QUARANTINE_PREFIX = '_quarantine';
const QUARANTINE_TTL_HOURS_DEFAULT = 24;
const QUARANTINE_TTL_HOURS_MAX = 24 * 30;
const DIRECT_UPLOAD_KINDS = new Set(['image']);

function validatePublicUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(String(urlStr).trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    if (u.port && u.port !== '443') return null;
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function normalizePrefix(raw, fallback) {
  return String(raw || fallback).trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

function getStorageConfig() {
  if (_configCache) return _configCache;

  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const publicBucket = String(process.env.R2_PUBLIC_BUCKET || '').trim();
  const privateBucket = String(process.env.R2_PRIVATE_BUCKET || '').trim();

  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('[storage] R2_ACCOUNT_ID inválido.');
  if (!accessKeyId || !secretAccessKey) throw new Error('[storage] Credenciais R2 ausentes.');

  const bucketRe = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  if (!bucketRe.test(publicBucket) || !bucketRe.test(privateBucket)) {
    throw new Error('[storage] Nomes de bucket R2 inválidos.');
  }
  if (publicBucket === privateBucket) throw new Error('[storage] Buckets público e privado devem ser diferentes.');

  const publicBaseUrl = validatePublicUrl(process.env.R2_PUBLIC_BASE_URL);
  if (!publicBaseUrl) {
    throw new Error('[storage] R2_PUBLIC_BASE_URL obrigatório: URL HTTPS sem path, query, hash ou porta não padrão.');
  }
  const customImageDomain = validatePublicUrl(process.env.R2_CUSTOM_IMAGE_DOMAIN) || null;

  const prefixes = {
    image: normalizePrefix(process.env.R2_PREFIX_IMAGE, 'images'),
    'audio-preview': normalizePrefix(process.env.R2_PREFIX_PREVIEW, 'preview'),
    'audio-full': normalizePrefix(process.env.R2_PREFIX_AUDIO, 'audio')
  };
  const prefixRe = /^[a-z][a-z0-9_-]{0,62}$/;
  for (const p of Object.values(prefixes)) {
    if (!prefixRe.test(p)) throw new Error(`[storage] Prefixo "${p}" inválido.`);
  }
  if (new Set(Object.values(prefixes)).size !== Object.values(prefixes).length) {
    throw new Error('[storage] Prefixos R2 devem ser distintos.');
  }
  if (Object.values(prefixes).includes(QUARANTINE_PREFIX)) {
    throw new Error('[storage] Prefixo definitivo não pode ser "_quarantine".');
  }

  _configCache = {
    accountId, accessKeyId, secretAccessKey, publicBucket, privateBucket,
    s3Endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    s3Host: `${accountId}.r2.cloudflarestorage.com`,
    publicBaseUrl, customImageDomain, prefixes
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

function resolveKindEntry(kind) {
  if (typeof kind !== 'string') return null;
  const normalized = kind.trim().toLowerCase();
  const entry = ALLOWED_MEDIA[normalized];
  return entry ? { kind: normalized, entry } : null;
}

function validateObjectKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > 1024) throw new Error('Caminho inválido.');
  if (key.startsWith('/') || key.endsWith('/') || key.includes('\\')) throw new Error('Caminho inválido.');
  if (/[\x00-\x1F\x7F]/.test(key)) throw new Error('Caminho contém caracteres de controle.');
  if (key.split('/').some(seg => !seg || seg === '.' || seg === '..')) throw new Error('Segmento de caminho inválido.');
  return key;
}

function validateFilename(filename) {
  const name = String(filename || '').trim();
  if (!name || name.length > 255 || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
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
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!resolved.entry.mimes.has(m)) throw new Error(`Content-Type não permitido para ${resolved.kind}.`);
  return m;
}

function validateExtForKind(kind, filenameOrKey) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const name = String(filenameOrKey || '').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) throw new Error('Arquivo sem extensão.');
  const ext = name.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext) || !resolved.entry.exts.has(ext)) {
    throw new Error(`Extensão ".${ext}" não permitida para ${resolved.kind}.`);
  }
  return ext;
}

function validateMimeExtConsistency(kind, mime, filenameOrKey) {
  const ext = validateExtForKind(kind, filenameOrKey);
  const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase();
  const allowed = EXT_TO_MIMES[ext];
  if (!allowed || !allowed.includes(normalizedMime)) {
    throw new Error(`Extensão ".${ext}" incompatível com Content-Type ${normalizedMime}.`);
  }
  return true;
}

function isQuarantinePath(key) {
  return typeof key === 'string' && key.startsWith(`${QUARANTINE_PREFIX}/`);
}

function buildQuarantinePath(kind, ext) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const safeExt = String(ext || '').toLowerCase();
  if (!resolved.entry.exts.has(safeExt)) throw new Error('Extensão inválida para quarentena.');
  return `${QUARANTINE_PREFIX}/${resolved.kind}/${Date.now()}_${crypto.randomBytes(16).toString('hex')}.${safeExt}`;
}

function buildDefinitivePath(kind, ext) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const safeExt = String(ext || '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(safeExt) || !resolved.entry.exts.has(safeExt)) {
    throw new Error(`Extensão "${safeExt}" inválida para ${resolved.kind}.`);
  }
  const prefix = getStorageConfig().prefixes[resolved.kind];
  return `${prefix}/${Date.now()}_${crypto.randomBytes(16).toString('hex')}.${safeExt}`;
}

function buildPathForKind(kind, filename) {
  const ext = validateExtForKind(kind, filename);
  return buildQuarantinePath(kind, ext);
}

function inferKindFromKey(key) {
  validateObjectKey(key);
  const parts = key.split('/');
  const first = parts[0];

  if (first === QUARANTINE_PREFIX) {
    if (parts.length !== 3) {
      const err = new Error('Caminho de quarentena com estrutura inválida.');
      err.code = 'INVALID_KEY_PREFIX';
      throw err;
    }
    const kind = parts[1];
    if (!ALLOWED_MEDIA[kind]) {
      const err = new Error('Kind de quarentena inválido.');
      err.code = 'INVALID_KEY_PREFIX';
      throw err;
    }
    return kind;
  }

  const c = getStorageConfig();
  if (first === 'premium') return 'audio-full'; // legado

  for (const [kind, prefix] of Object.entries(c.prefixes)) {
    if (first === prefix) return kind;
  }
  const err = new Error('Prefixo de objeto não reconhecido.');
  err.code = 'INVALID_KEY_PREFIX';
  throw err;
}

/* Quarantine is private regardless of media's final bucket. */
function resolveBucket(kindOrKey) {
  const value = String(kindOrKey || '');
  if (isQuarantinePath(value)) return getStorageConfig().privateBucket;

  const resolved = resolveKindEntry(value) || (value.includes('/') ? resolveKindEntry(inferKindFromKey(value)) : null);
  if (!resolved) {
    const err = new Error('Tipo/chave de mídia desconhecido.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  const c = getStorageConfig();
  return resolved.entry.bucket === 'private' ? c.privateBucket : c.publicBucket;
}

function getPrefixForKind(kind) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  return getStorageConfig().prefixes[resolved.kind];
}

function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function getPublicUrl(key) {
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);
  if (isQuarantinePath(key)) {
    const err = new Error('Objeto em quarentena não possui URL pública.');
    err.code = 'NOT_PUBLIC';
    throw err;
  }
  const kind = inferKindFromKey(key);
  if (ALLOWED_MEDIA[kind].bucket !== 'public') {
    const err = new Error('Objeto privado não pode gerar URL pública.');
    err.code = 'NOT_PUBLIC';
    throw err;
  }
  const c = getStorageConfig();
  const base = c.customImageDomain && kind === 'image' ? c.customImageDomain : c.publicBaseUrl;
  return `${base}/${encodeKey(key)}`;
}

async function uploadObject(key, body, contentType) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  if (!DIRECT_UPLOAD_KINDS.has(kind)) {
    const err = new Error(`Upload direto não permitido para "${kind}". Use quarentena + promoção.`);
    err.code = 'DIRECT_UPLOAD_FORBIDDEN';
    throw err;
  }
  const entry = ALLOWED_MEDIA[kind];
  const mime = validateMimeForKind(kind, contentType);
  validateMimeExtConsistency(kind, mime, key);
  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) throw new TypeError('Body deve ser Buffer ou Uint8Array.');
  const size = body.byteLength;
  if (!size) throw new Error('Arquivo vazio.');
  if (size > entry.maxBytes) throw new Error(`Arquivo excede o limite para ${kind}.`);
  return getS3Client().send(new PutObjectCommand({
    Bucket: resolveBucket(kind), Key: key, Body: body, ContentType: mime
  }));
}

async function createSignedUploadUrl(key, contentType, sizeBytes, expiresInSec = 900) {
  validateObjectKey(key);
  if (!isQuarantinePath(key)) {
    const err = new Error('URL assinada deve apontar para quarentena.');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const kind = inferKindFromKey(key);
  const entry = ALLOWED_MEDIA[kind];
  const mime = validateMimeForKind(kind, contentType);
  validateMimeExtConsistency(kind, mime, key);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > entry.maxBytes) {
    throw new Error(`Tamanho inválido ou acima do limite para ${kind}.`);
  }
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido (1–3600s).');
  }

  const command = new PutObjectCommand({
    Bucket: resolveBucket(key),
    Key: key,
    ContentType: mime
  });
  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
  return { uploadUrl, path: key, bucket: resolveBucket(key), kind, maxBytes: entry.maxBytes, expectedSize: sizeBytes, expiresIn: expiresInSec, host: getStorageConfig().s3Host };
}

async function getObjectMetadata(key) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  try {
    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: resolveBucket(key), Key: key }));
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

async function createSignedDownloadUrl(key, expiresInSec = 300, downloadFilename = null) {
  validateObjectKey(key);
  if (isQuarantinePath(key)) {
    const err = new Error('Download de objeto em quarentena não permitido.');
    err.code = 'QUARANTINE_FORBIDDEN';
    throw err;
  }
  const kind = inferKindFromKey(key);
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }
  const params = { Bucket: resolveBucket(key), Key: key };
  if (downloadFilename) {
    const safe = String(downloadFilename).replace(/[\r\n"\\]/g, '_').replace(/[^\w.\- ]/g, '_').slice(0, 150) || 'download';
    params.ResponseContentDisposition = `attachment; filename="${safe}"`;
  }
  const url = await getSignedUrl(getS3Client(), new GetObjectCommand(params), { expiresIn: expiresInSec });
  return { url, kind, bucket: params.Bucket, expiresIn: expiresInSec };
}

async function getPlaybackUrl(key) {
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);
  if (isQuarantinePath(key)) {
    const err = new Error('Reprodução de objeto em quarentena não permitida.');
    err.code = 'QUARANTINE_FORBIDDEN';
    throw err;
  }
  const kind = inferKindFromKey(key);
  if (kind !== 'audio-full') {
    const err = new Error('getPlaybackUrl aceita apenas audio-full.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  const meta = await getObjectMetadata(key);
  if (!meta) {
    const err = new Error('Arquivo de áudio não encontrado.');
    err.code = 'OBJECT_NOT_FOUND';
    throw err;
  }
  return createSignedDownloadUrl(key, 300, null).then(result => result.url);
}

async function promoteFromQuarantine(quarantineKey, kind, opts = {}) {
  validateObjectKey(quarantineKey);
  if (!isQuarantinePath(quarantineKey)) {
    const err = new Error('promoteFromQuarantine exige caminho de quarentena.');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const originKind = inferKindFromKey(quarantineKey);
  const resolved = resolveKindEntry(kind);
  if (!resolved || resolved.kind !== originKind) {
    const err = new Error('kind informado não corresponde ao kind da quarentena.');
    err.code = 'KIND_MISMATCH';
    throw err;
  }
  const ext = validateExtForKind(resolved.kind, quarantineKey);
  let definitiveKey;

  if (opts.definitiveKey != null) {
    definitiveKey = String(opts.definitiveKey);
    validateObjectKey(definitiveKey);
    if (isQuarantinePath(definitiveKey)) throw new Error('definitiveKey não pode ser quarentena.');
    if (inferKindFromKey(definitiveKey) !== resolved.kind) throw new Error('definitiveKey não corresponde ao kind.');
    validateExtForKind(resolved.kind, definitiveKey);
  } else {
    definitiveKey = buildDefinitivePath(resolved.kind, ext);
  }

  const expectedSize = opts.expectedSize == null ? null : Number(opts.expectedSize);
  const expectedMime = opts.expectedMime ? String(opts.expectedMime).split(';')[0].trim().toLowerCase() : null;
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) throw new Error('expectedSize inválido.');
  if (expectedMime !== null) {
    validateMimeForKind(resolved.kind, expectedMime);
    validateMimeExtConsistency(resolved.kind, expectedMime, quarantineKey);
  }

  const entry = ALLOWED_MEDIA[resolved.kind];
  const sourceBucket = resolveBucket(quarantineKey); // always private
  const destinationBucket = resolveBucket(resolved.kind);
  const s3 = getS3Client();
  const originMeta = await getObjectMetadata(quarantineKey);

  if (!originMeta || originMeta.contentLength <= 0) {
    const err = new Error('Objeto de quarentena inexistente ou vazio.');
    err.code = 'QUARANTINE_MISSING';
    throw err;
  }
  if (originMeta.contentLength > entry.maxBytes) {
    const err = new Error('Objeto excede o limite máximo após upload.');
    err.code = 'SIZE_LIMIT_EXCEEDED';
    throw err;
  }
  const originMime = String(originMeta.contentType || '').split(';')[0].trim().toLowerCase();
  if (!entry.mimes.has(originMime)) {
    const err = new Error(`MIME real informado nos metadados não permitido: ${originMime || 'ausente'}.`);
    err.code = 'MIME_MISMATCH';
    throw err;
  }
  validateMimeExtConsistency(resolved.kind, originMime, quarantineKey);
  if (expectedSize !== null && originMeta.contentLength !== expectedSize) {
    const err = new Error(`Tamanho real (${originMeta.contentLength}) difere do esperado (${expectedSize}).`);
    err.code = 'SIZE_MISMATCH';
    throw err;
  }
  if (expectedMime !== null && originMime !== expectedMime) {
    const err = new Error(`MIME real (${originMime}) difere do esperado (${expectedMime}).`);
    err.code = 'MIME_MISMATCH';
    throw err;
  }
  if (!originMeta.etag) {
    const err = new Error('ETag da origem ausente; cópia protegida impossível.');
    err.code = 'ETAG_MISSING';
    throw err;
  }

  const copySource = `/${sourceBucket}/${encodeKey(quarantineKey)}`;
  let copied = false;
  try {
    await s3.send(new CopyObjectCommand({
      Bucket: destinationBucket,
      Key: definitiveKey,
      CopySource: copySource,
      MetadataDirective: 'COPY',
      CopySourceIfMatch: originMeta.etag
    }));
    copied = true;

    const destMeta = await getObjectMetadata(definitiveKey);
    if (!destMeta || destMeta.contentLength <= 0) throw new Error('Destino promovido vazio/inexistente.');
    if (destMeta.contentLength !== originMeta.contentLength) throw new Error('Tamanho do destino difere da origem.');
    const destMime = String(destMeta.contentType || '').split(';')[0].trim().toLowerCase();
    if (destMime !== originMime) throw new Error('MIME do destino difere da origem.');

    // Only delete quarantine after destination verification.
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: quarantineKey }));
    } catch (cleanupErr) {
      console.warn('[storage] promoção concluída, mas quarentena não removida:', cleanupErr?.message || cleanupErr);
    }

    return { definitiveKey, meta: destMeta, originMeta, etag: originMeta.etag, kind: resolved.kind, bucket: destinationBucket };
  } catch (err) {
    // Compensating cleanup: if destination was created but verification failed, remove it.
    if (copied) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: destinationBucket, Key: definitiveKey }));
      } catch (cleanupErr) {
        console.error('[storage] rollback de promoção falhou:', definitiveKey, cleanupErr?.message || cleanupErr);
      }
    }
    if (err?.name === 'PreconditionFailed' || err?.$metadata?.httpStatusCode === 412) {
      const e = new Error('Objeto de quarentena foi modificado antes da cópia.');
      e.code = 'SOURCE_CHANGED';
      throw e;
    }
    throw err;
  }
}

async function deleteObject(key) {
  validateObjectKey(key);
  const bucket = resolveBucket(key);
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return true;
}

async function purgeOldQuarantine(olderThanHours = QUARANTINE_TTL_HOURS_DEFAULT) {
  const hours = Number(olderThanHours);
  if (!Number.isInteger(hours) || hours <= 0 || hours > QUARANTINE_TTL_HOURS_MAX) {
    throw new Error(`olderThanHours deve ser inteiro entre 1 e ${QUARANTINE_TTL_HOURS_MAX}.`);
  }
  const c = getStorageConfig();
  const s3 = getS3Client();
  const cutoff = Date.now() - hours * 3600 * 1000;
  let deleted = 0;
  let failed = 0;

  // All quarantine objects live in the private bucket, irrespective of media kind.
  for (const kind of Object.keys(ALLOWED_MEDIA)) {
    const prefix = `${QUARANTINE_PREFIX}/${kind}/`;
    let token;
    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: c.privateBucket, Prefix: prefix, ContinuationToken: token
      }));
      for (const obj of list.Contents || []) {
        const modified = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        if (modified && modified < cutoff && obj.Key) {
          try {
            await s3.send(new DeleteObjectCommand({ Bucket: c.privateBucket, Key: obj.Key }));
            deleted++;
          } catch (err) {
            failed++;
            console.warn('[storage] purge falhou:', obj.Key, err?.message || err);
          }
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
  return { deleted, failed };
}

function getPublicR2Config() {
  const c = getStorageConfig();
  return {
    ok: true,
    publicBaseUrl: c.publicBaseUrl,
    customImageDomain: c.customImageDomain,
    prefixes: c.prefixes,
    allowedMedia: Object.fromEntries(Object.entries(ALLOWED_MEDIA).map(([kind, v]) => [
      kind, { exts: [...v.exts], mimes: [...v.mimes], bucket: v.bucket, maxBytes: v.maxBytes }
    ])),
    quarantine: { prefix: QUARANTINE_PREFIX, ttlHours: QUARANTINE_TTL_HOURS_DEFAULT },
    directUploadKinds: [...DIRECT_UPLOAD_KINDS]
  };
}

module.exports = {
  createSignedUploadUrl,
  createSignedDownloadUrl,
  getPublicUrl,
  getPlaybackUrl,
  uploadObject,
  getObjectMetadata,
  objectExists,
  buildPathForKind,
  buildDefinitivePath,
  getPrefixForKind,
  inferKindFromKey,
  resolveBucket,
  validateObjectKey,
  validateFilename,
  validateExtForKind,
  validateMimeForKind,
  validateMimeExtConsistency,
  getPublicR2Config,
  ALLOWED_MEDIA,
  EXT_TO_MIMES,
  DIRECT_UPLOAD_KINDS,
  promoteFromQuarantine,
  buildQuarantinePath,
  isQuarantinePath,
  deleteObject,
  purgeOldQuarantine,
  QUARANTINE_PREFIX,
  QUARANTINE_TTL_HOURS_DEFAULT,
  QUARANTINE_TTL_HOURS_MAX
};
"""
path = Path("/mnt/data/api_storage_v5.js")
path.write_text(code, encoding="utf-8")
print(f"Arquivo criado: {path} | {len(code.splitlines())} linhas")
