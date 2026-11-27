'use strict';

/* ============================================================
   api/_storage.js — Cloudflare R2 via S3 API (v4 — Final)
   api/_storage.js — Cloudflare R2 via S3 API (v5 — auditado)
   ------------------------------------------------------------
   - Separação estrita de buckets (público/privado)
   - Fluxo de quarentena + promoção atômica com validação de ETag
   - Bloqueio de download/reprodução de objetos em quarentena
   - Validação rigorosa de MIME, extensão e tamanho
   ============================================================
   v5 — patches da auditoria de 2026-11-26 aplicados:
   B-01 quarentena sempre no bucket privado (cópia entre buckets)
   B-02 guard DEST_EXISTS no definitivo · B-03 assinatura mágica (16 bytes)
   B-04 TTL de reprodução parametrizável (default 3600s)
   B-05 config público mínimo · B-06 alias audio/mp3 · B-08 "premium" reservado
   B-10 purge em lote (DeleteObjects) · B-12 deleteObject honesto
   B-15 hosts internos bloqueados · B-16 maxAttempts=5
   B-19 uploadObject não escreve em quarentena
   ============================================================ */

const crypto = require('crypto');
const {
  GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
  CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command
  CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

@@ -31,20 +40,20 @@
  },
  'audio-preview': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/wav','audio/x-wav','audio/flac','audio/aiff','audio/x-aiff']),
    mimes: new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/wav','audio/x-wav','audio/flac','audio/aiff','audio/x-aiff']),
    bucket: 'public',
    maxBytes: 50 * 1024 * 1024
  },
  'audio-full': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/flac','audio/wav','audio/x-wav','audio/aiff','audio/x-aiff']),
    mimes: new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/flac','audio/wav','audio/x-wav','audio/aiff','audio/x-aiff']),
    bucket: 'private',
    maxBytes: 200 * 1024 * 1024
  }
};

const EXT_TO_MIMES = {
  mp3: ['audio/mpeg'], m4a: ['audio/mp4'], mp4: ['audio/mp4'], aac: ['audio/aac'],
  mp3: ['audio/mpeg','audio/mp3'], m4a: ['audio/mp4'], mp4: ['audio/mp4'], aac: ['audio/aac'],
  ogg: ['audio/ogg'], oga: ['audio/ogg'], opus: ['audio/opus'], webm: ['audio/webm'],
  wav: ['audio/wav','audio/x-wav'], flac: ['audio/flac'],
  aif: ['audio/aiff','audio/x-aiff'], aiff: ['audio/aiff','audio/x-aiff'],
@@ -70,7 +79,11 @@
    if (u.pathname !== '/' && u.pathname !== '') throw new Error('Path não permitido no domínio base');
    if (u.port && u.port !== '443') throw new Error('Porta não permitida');
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost') throw new Error('Host inválido');
    const INTERNAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']); // B-15
    if (!host || INTERNAL_HOSTS.has(host) ||
        host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
      throw new Error('Host inválido');
    }
    return u.origin;
  } catch {
    return null;
@@ -129,6 +142,9 @@
  if (prefixVals.includes(QUARANTINE_PREFIX)) {
    throw new Error('[storage] Prefixo definitivo não pode ser "_quarantine".');
  }
  if (prefixVals.includes('premium')) { // B-08: reservado (legado de áudio)
    throw new Error('[storage] Prefixo "premium" é reservado (compatibilidade legada de áudio).');
  }

  _configCache = {
    accountId, accessKeyId, secretAccessKey,
@@ -147,6 +163,7 @@
      region: 'auto',
      endpoint: c.s3Endpoint,
      forcePathStyle: true,
      maxAttempts: 5, // B-16: tolerância a 5xx transientes
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
    });
  }
@@ -343,6 +360,11 @@
// ─────────────────────────────────────────────────────────────
async function uploadObject(key, body, contentType) {
  validateObjectKey(key);
  if (isQuarantinePath(key)) { // B-19: porta única para a quarentena
    const err = new Error('uploadObject não escreve em quarentena; use createSignedUploadUrl + promote.');
    err.code = 'INVALID_PATH';
    throw err;
  }
  const kind = inferKindFromKey(key);
  if (!DIRECT_UPLOAD_KINDS.has(kind)) {
    const err = new Error(`Upload direto não permitido para "${kind}". Use quarentena + promote.`);
@@ -393,7 +415,7 @@
    throw new Error('Prazo de assinatura inválido (1–3600s).');
  }

  const bucket = resolveBucket(kind);
  const bucket = getStorageConfig().privateBucket; // B-01: quarentena sempre no privado
  const command = new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes
  });
@@ -412,7 +434,9 @@
async function getObjectMetadata(key) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);
  const bucket = isQuarantinePath(key) // B-01: HEAD de quarentena no privado
    ? getStorageConfig().privateBucket
    : resolveBucket(kind);

  try {
    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
@@ -464,7 +488,7 @@
  return { url, kind, bucket, expiresIn: expiresInSec };
}

async function getPlaybackUrl(key) {
async function getPlaybackUrl(key, expiresInSec = 3600) { // B-04: antes fixo em 300s
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);
  if (isQuarantinePath(key)) {
@@ -478,10 +502,49 @@
    err.code = 'INVALID_KIND';
    throw err;
  }
  const { url } = await createSignedDownloadUrl(key, 300, null);
  // createSignedDownloadUrl valida 1–3600 e lança se inválido
  const { url } = await createSignedDownloadUrl(key, expiresInSec, null);
  return url;
}

// B-03: assinatura mágica por extensão (16 primeiros bytes do objeto)
const MAGIC_SIGNATURES = [
  { ext: 'mp3',  test: (b) => (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) ||
      (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) },
  { ext: 'm4a',  test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { ext: 'mp4',  test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { ext: 'ogg',  test: (b) => b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
  { ext: 'oga',  test: (b) => b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
  { ext: 'opus', test: (b) => b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
  { ext: 'flac', test: (b) => b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43 },
  { ext: 'wav',  test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45 },
  { ext: 'webm', test: (b) => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
  { ext: 'aac',  test: (b) => (b[0] === 0x41 && b[1] === 0x44 && b[2] === 0x49 && b[3] === 0x46) ||
      (b[0] === 0xFF && (b[1] & 0xF0) === 0xF0) },
  { ext: 'aif',  test: (b) => b[0] === 0x46 && b[1] === 0x4F && b[2] === 0x52 && b[3] === 0x4D &&
      (b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x46 && (b[11] === 0x46 || b[11] === 0x43)) },
  { ext: 'aiff', test: (b) => b[0] === 0x46 && b[1] === 0x4F && b[2] === 0x52 && b[3] === 0x4D &&
      (b[8] === 0x41 && b[9] === 0x49 && b[10] === 0x46 && (b[11] === 0x46 || b[11] === 0x43)) },
  { ext: 'jpg',  test: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'jpeg', test: (b) => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
  { ext: 'png',  test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 },
  { ext: 'gif',  test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  { ext: 'webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
  { ext: 'avif', test: (b) => b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 &&
      b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66 }
];

async function readObjectHead(key, bucket, bytes = 16) {
  const res = await getS3Client().send(new GetObjectCommand({
    Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}`
  }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────
// PROMOÇÃO DE QUARENTENA
// ─────────────────────────────────────────────────────────────
@@ -526,9 +589,18 @@
    validateMimeExtConsistency(resolved.kind, expectedMime, quarantineKey);
  }

  const bucket = resolveBucket(resolved.kind);
  // B-01: quarentena vive no bucket privado; destino segue a matriz do kind
  const sourceBucket = getStorageConfig().privateBucket;
  const destBucket = resolveBucket(resolved.kind);
  const c = getS3Client();

  // B-02: não sobrescreve objeto definitivo existente sem opt-in explícito
  if (!opts.overwriteExisting && (await objectExists(definitiveKey))) {
    const err = new Error('Objeto definitivo já existe — promoção abortada (use overwriteExisting para permitir).');
    err.code = 'DEST_EXISTS';
    throw err;
  }

  const originMeta = await getObjectMetadata(quarantineKey);
  if (!originMeta || originMeta.contentLength <= 0) {
    const err = new Error('Objeto de quarentena inexistente ou vazio.');
@@ -544,6 +616,17 @@
  }
  validateMimeExtConsistency(resolved.kind, originMime, quarantineKey);

  // B-03: valida assinatura mágica do conteúdo (MIME/ext são metadados do cliente)
  const magic = MAGIC_SIGNATURES.find((s) => s.ext === ext);
  if (magic) {
    const magicHead = await readObjectHead(quarantineKey, sourceBucket, 16);
    if (!magic.test(magicHead)) {
      const err = new Error(`Conteúdo não corresponde à assinatura esperada para .${ext}.`);
      err.code = 'MAGIC_MISMATCH';
      throw err;
    }
  }

  if (expectedSize !== null && originMeta.contentLength !== expectedSize) {
    const err = new Error(`Tamanho do objeto (${originMeta.contentLength}) difere do esperado (${expectedSize}).`);
    err.code = 'SIZE_MISMATCH';
@@ -563,9 +646,9 @@
  }

  const copyParams = {
    Bucket: bucket,
    Bucket: destBucket,
    Key: definitiveKey,
    CopySource: `/${bucket}/${encodeKey(quarantineKey)}`,
    CopySource: `/${sourceBucket}/${encodeKey(quarantineKey)}`, // B-01: cópia entre buckets
    MetadataDirective: 'COPY',
    CopySourceIfMatch: etag
  };
@@ -588,21 +671,21 @@
    throw err;
  }
  if (destMeta.contentLength !== originMeta.contentLength) {
    try { await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: definitiveKey })); } catch {}
    try { await c.send(new DeleteObjectCommand({ Bucket: destBucket, Key: definitiveKey })); } catch {}
    const err = new Error('Tamanho do definitivo difere da origem.');
    err.code = 'PROMOTE_SIZE_MISMATCH';
    throw err;
  }
  const destMime = (destMeta.contentType || '').split(';')[0].trim().toLowerCase();
  if (destMime !== originMime) {
    try { await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: definitiveKey })); } catch {}
    try { await c.send(new DeleteObjectCommand({ Bucket: destBucket, Key: definitiveKey })); } catch {}
    const err = new Error('MIME do definitivo difere da origem.');
    err.code = 'PROMOTE_MIME_MISMATCH';
    throw err;
  }

  try {
    await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: quarantineKey }));
    await c.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: quarantineKey })); // B-01
  } catch (err) {
    console.warn('[storage] falha ao apagar quarentena:', quarantineKey, err.message);
  }
@@ -620,13 +703,14 @@
// Exclusão / limpeza
// ─────────────────────────────────────────────────────────────
async function deleteObject(key) {
  validateObjectKey(key); // B-12: erro de validação propaga ao chamador
  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);
  try {
    validateObjectKey(key);
    const kind = inferKindFromKey(key);
    const bucket = resolveBucket(kind);
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return true;
    console.warn('[storage] deleteObject falhou:', key, err.message);
    return false;
  }
@@ -643,24 +727,28 @@
  let deleted = 0;

  for (const kind of Object.keys(ALLOWED_MEDIA)) {
    const bucket = resolveBucket(kind);
    const bucket = getStorageConfig().privateBucket; // B-01: quarentena no privado
    const prefix = `${QUARANTINE_PREFIX}/${kind}/`;
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token
      }));
      for (const obj of list.Contents || []) {
      // B-10: remoção em lote (DeleteObjects) por página de até 1000 chaves
      const stale = (list.Contents || []).filter((obj) => {
        const lm = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        if (lm && lm < cutoff) {
          try {
            await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            deleted++;
          } catch (err) {
            console.warn('[storage] purge falhou:', obj.Key, err.message);
          }
        } else if (!lm) {
          console.warn('[storage] purge ignorou objeto sem LastModified:', obj.Key);
        if (!lm) console.warn('[storage] purge ignorou objeto sem LastModified:', obj.Key);
        return lm && lm < cutoff;
      });
      if (stale.length) {
        try {
          await c.send(new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: stale.map((o) => ({ Key: o.Key })), Quiet: true }
          }));
          deleted += stale.length;
        } catch (err) {
          console.warn('[storage] purge em lote falhou:', err.message);
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
@@ -674,42 +762,34 @@
// ─────────────────────────────────────────────────────────────
function getPublicR2Config() {
  const c = getStorageConfig();
  return {
  return { // B-05: só o que o frontend consome (sem accountId/buckets/s3Host)
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
    },
    directUploadKinds: [...DIRECT_UPLOAD_KINDS]
  };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
  createSignedUploadUrl, createSignedDownloadUrl, getPublicUrl, getPlaybackUrl,
  uploadObject, getObjectMetadata, objectExists, buildPathForKind, buildDefinitivePath,
  getPrefixForKind, inferKindFromKey, resolveBucket,
  validateObjectKey, validateFilename, validateExtForKind,
  validateMimeForKind, validateMimeExtConsistency, getPublicR2Config,
  ALLOWED_MEDIA, EXT_TO_MIMES, DIRECT_UPLOAD_KINDS,
  promoteFromQuarantine, buildQuarantinePath, isQuarantinePath,
  deleteObject, purgeOldQuarantine,
  QUARANTINE_PREFIX, QUARANTINE_TTL_HOURS_DEFAULT, QUARANTINE_TTL_HOURS_MAX
};
