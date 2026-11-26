'use strict';

/* ============================================================
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
  CopyObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command
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
    maxBytes: 10 * 1024 * 1024
  },
  'audio-preview': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/wav','audio/x-wav','audio/flac','audio/aiff','audio/x-aiff']),
    bucket: 'public',
    maxBytes: 50 * 1024 * 1024
  },
  'audio-full': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp3','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/flac','audio/wav','audio/x-wav','audio/aiff','audio/x-aiff']),
    bucket: 'private',
    maxBytes: 200 * 1024 * 1024
  }
};

const EXT_TO_MIMES = {
  mp3: ['audio/mpeg','audio/mp3'], m4a: ['audio/mp4'], mp4: ['audio/mp4'], aac: ['audio/aac'],
  ogg: ['audio/ogg'], oga: ['audio/ogg'], opus: ['audio/opus'], webm: ['audio/webm'],
  wav: ['audio/wav','audio/x-wav'], flac: ['audio/flac'],
  aif: ['audio/aiff','audio/x-aiff'], aiff: ['audio/aiff','audio/x-aiff'],
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'], png: ['image/png'],
  webp: ['image/webp'], gif: ['image/gif'], avif: ['image/avif']
};

const QUARANTINE_PREFIX = '_quarantine';
const QUARANTINE_TTL_HOURS_DEFAULT = 24;
const QUARANTINE_TTL_HOURS_MAX = 24 * 30;
const DIRECT_UPLOAD_KINDS = new Set(['image']);

// ─────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────
function validatePublicUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(String(urlStr).trim());
    if (u.protocol !== 'https:') throw new Error('Deve ser HTTPS');
    if (u.username || u.password) throw new Error('Credenciais não permitidas');
    if (u.search || u.hash) throw new Error('Query string ou hash não permitidos');
    if (u.pathname !== '/' && u.pathname !== '') throw new Error('Path não permitido no domínio base');
    if (u.port && u.port !== '443') throw new Error('Porta não permitida');
    const host = u.hostname.toLowerCase();
    const INTERNAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']); // B-15
    if (!host || INTERNAL_HOSTS.has(host) ||
        host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
      throw new Error('Host inválido');
    }
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

  const s3Endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const s3Host = `${accountId}.r2.cloudflarestorage.com`;

  const publicBaseUrl = validatePublicUrl(process.env.R2_PUBLIC_BASE_URL);
  if (!publicBaseUrl) {
    throw new Error('[storage] R2_PUBLIC_BASE_URL é obrigatório e deve ser uma URL HTTPS válida (sem path/porta/query).');
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
    'image': normalizePrefix(process.env.R2_PREFIX_IMAGE, 'images'),
    'audio-preview': normalizePrefix(process.env.R2_PREFIX_PREVIEW, 'preview'),
    'audio-full': normalizePrefix(process.env.R2_PREFIX_AUDIO, 'audio')
  };

  const prefixRe = /^[a-z][a-z0-9_-]{0,62}$/;
  const prefixVals = Object.values(prefixes);
  for (const p of prefixVals) {
    if (!prefixRe.test(p)) throw new Error(`[storage] Prefixo "${p}" inválido.`);
  }
  if (new Set(prefixVals).size !== prefixVals.length) {
    throw new Error('[storage] Prefixos R2 devem ser distintos.');
  }
  // Correção Final: Prevenir colisão com o prefixo de quarentena
  if (prefixVals.includes(QUARANTINE_PREFIX)) {
    throw new Error('[storage] Prefixo definitivo não pode ser "_quarantine".');
  }
  if (prefixVals.includes('premium')) { // B-08: reservado (legado de áudio)
    throw new Error('[storage] Prefixo "premium" é reservado (compatibilidade legada de áudio).');
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
      maxAttempts: 5, // B-16: tolerância a 5xx transientes
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
  const m = String(mime || '').toLowerCase().trim();
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
  const normalizedMime = String(mime || '').toLowerCase().trim();
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
  const hex = crypto.randomBytes(16).toString('hex'); // Aumentado para 16 bytes
  return `${QUARANTINE_PREFIX}/${safeKind}/${ts}_${hex}.${ext}`;
}

function buildDefinitivePath(kind, ext) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const safeExt = String(ext || '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(safeExt) || !resolved.entry.exts.has(safeExt)) {
    throw new Error(`Extensão "${safeExt}" inválida para ${resolved.kind}.`);
  }
  const config = getStorageConfig();
  const prefix = config.prefixes[resolved.kind];
  const ts = Date.now();
  const hex = crypto.randomBytes(16).toString('hex');
  return `${prefix}/${ts}_${hex}.${safeExt}`;
}

function buildPathForKind(kind, filename) {
  const ext = validateExtForKind(kind, filename);
  return buildQuarantinePath(kind, ext);
}

// ─────────────────────────────────────────────────────────────
// Kind a partir de chave
// ─────────────────────────────────────────────────────────────
const QUARANTINE_SEGMENTS = 3;

function inferKindFromKey(key) {
  validateObjectKey(key);
  const k = String(key);

  if (k.startsWith(QUARANTINE_PREFIX + '/')) {
    const segments = k.split('/');
    if (segments.length !== QUARANTINE_SEGMENTS) {
      const err = new Error('Caminho de quarentena com estrutura inválida.');
      err.code = 'INVALID_KEY_PREFIX';
      throw err;
    }
    const kind = segments[1];
    if (kind === 'audio-full' || kind === 'audio-preview' || kind === 'image') return kind;
    const err = new Error('Caminho de quarentena com kind inválido.');
    err.code = 'INVALID_KEY_PREFIX';
    throw err;
  }

  const config = getStorageConfig();
  const first = k.split('/')[0];

  // Compatibilidade com objetos legados já armazenados no bucket privado.
  // A chave permanece intacta (premium/...) e o tipo resolve para audio-full.
  if (first === 'premium') return 'audio-full';

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
// Upload direto (apenas DIRECT_UPLOAD_KINDS)
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
    err.code = 'DIRECT_UPLOAD_FORBIDDEN';
    throw err;
  }
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

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('Tamanho do arquivo inválido.');
  if (sizeBytes > entry.maxBytes) throw new Error(`Arquivo excede o limite para ${kind}.`);
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido (1–3600s).');
  }

  const bucket = getStorageConfig().privateBucket; // B-01: quarentena sempre no privado
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
  const bucket = isQuarantinePath(key) // B-01: HEAD de quarentena no privado
    ? getStorageConfig().privateBucket
    : resolveBucket(kind);

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

  if (isQuarantinePath(key)) {
    const err = new Error('Download de objeto em quarentena não é permitido.');
    err.code = 'QUARANTINE_FORBIDDEN';
    throw err;
  }

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
    params.ResponseContentDisposition = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
  }

  const url = await getSignedUrl(getS3Client(), new GetObjectCommand(params), { expiresIn: expiresInSec });
  return { url, kind, bucket, expiresIn: expiresInSec };
}

async function getPlaybackUrl(key, expiresInSec = 3600) { // B-04: antes fixo em 300s
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);
  if (isQuarantinePath(key)) {
    const err = new Error('Reprodução de objeto em quarentena não é permitida.');
    err.code = 'QUARANTINE_FORBIDDEN';
    throw err;
  }
  const kind = inferKindFromKey(key);
  if (kind !== 'audio-full') {
    const err = new Error('getPlaybackUrl aceita apenas audio-full.');
    err.code = 'INVALID_KIND';
    throw err;
  }
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
async function promoteFromQuarantine(quarantineKey, kind, opts = {}) {
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
  if (opts.definitiveKey !== undefined && opts.definitiveKey !== null) {
    const candidate = String(opts.definitiveKey);
    validateObjectKey(candidate);
    if (isQuarantinePath(candidate)) throw new Error('definitiveKey não pode ser caminho de quarentena.');
    const k = inferKindFromKey(candidate);
    if (k !== resolved.kind) throw new Error('definitiveKey não corresponde ao kind informado.');
    validateExtForKind(resolved.kind, candidate);
    definitiveKey = candidate;
  } else {
    definitiveKey = buildDefinitivePath(resolved.kind, ext);
  }

  const expectedSize = opts.expectedSize !== undefined && opts.expectedSize !== null ? Number(opts.expectedSize) : null;
  const expectedMime = opts.expectedMime ? String(opts.expectedMime).split(';')[0].trim().toLowerCase() : null;

  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
    throw new Error('expectedSize inválido.');
  }
  if (expectedMime !== null) {
    validateMimeForKind(resolved.kind, expectedMime);
    validateMimeExtConsistency(resolved.kind, expectedMime, quarantineKey);
  }

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
    err.code = 'QUARANTINE_MISSING';
    throw err;
  }

  const originMime = (originMeta.contentType || '').split(';')[0].trim().toLowerCase();
  if (!originMime || !ALLOWED_MEDIA[resolved.kind].mimes.has(originMime)) {
    const err = new Error(`Content-Type do objeto (${originMime || 'vazio'}) não é permitido para ${resolved.kind}.`);
    err.code = 'MIME_MISMATCH';
    throw err;
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
    throw err;
  }
  if (expectedMime !== null && originMime !== expectedMime) {
    const err = new Error(`MIME do objeto (${originMime}) difere do esperado (${expectedMime}).`);
    err.code = 'MIME_MISMATCH';
    throw err;
  }

  const etag = originMeta.etag;
  if (!etag) {
    const err = new Error('ETag da origem ausente — impossível proteger a cópia.');
    err.code = 'ETAG_MISSING';
    throw err;
  }

  const copyParams = {
    Bucket: destBucket,
    Key: definitiveKey,
    CopySource: `/${sourceBucket}/${encodeKey(quarantineKey)}`, // B-01: cópia entre buckets
    MetadataDirective: 'COPY',
    CopySourceIfMatch: etag
  };

  try {
    await c.send(new CopyObjectCommand(copyParams));
  } catch (err) {
    if (err?.name === 'PreconditionFailed' || err?.$metadata?.httpStatusCode === 412) {
      const e = new Error('Objeto de quarentena foi modificado entre a leitura e a cópia.');
      e.code = 'SOURCE_CHANGED';
      throw e;
    }
    throw err;
  }

  const destMeta = await getObjectMetadata(definitiveKey);
  if (!destMeta || destMeta.contentLength <= 0) {
    const err = new Error('Falha ao promover objeto — definitivo vazio.');
    err.code = 'PROMOTE_FAILED';
    throw err;
  }
  if (destMeta.contentLength !== originMeta.contentLength) {
    try { await c.send(new DeleteObjectCommand({ Bucket: destBucket, Key: definitiveKey })); } catch {}
    const err = new Error('Tamanho do definitivo difere da origem.');
    err.code = 'PROMOTE_SIZE_MISMATCH';
    throw err;
  }
  const destMime = (destMeta.contentType || '').split(';')[0].trim().toLowerCase();
  if (destMime !== originMime) {
    try { await c.send(new DeleteObjectCommand({ Bucket: destBucket, Key: definitiveKey })); } catch {}
    const err = new Error('MIME do definitivo difere da origem.');
    err.code = 'PROMOTE_MIME_MISMATCH';
    throw err;
  }

  try {
    await c.send(new DeleteObjectCommand({ Bucket: sourceBucket, Key: quarantineKey })); // B-01
  } catch (err) {
    console.warn('[storage] falha ao apagar quarentena:', quarantineKey, err.message);
  }

  return {
    definitiveKey,
    meta: destMeta,
    originMeta,
    etag,
    kind: resolved.kind
  };
}

// ─────────────────────────────────────────────────────────────
// Exclusão / limpeza
// ─────────────────────────────────────────────────────────────
async function deleteObject(key) {
  validateObjectKey(key); // B-12: erro de validação propaga ao chamador
  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);
  try {
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return true;
    console.warn('[storage] deleteObject falhou:', key, err.message);
    return false;
  }
}

async function purgeOldQuarantine(olderThanHours = QUARANTINE_TTL_HOURS_DEFAULT) {
  const hours = Number(olderThanHours);
  if (!Number.isInteger(hours) || hours <= 0 || hours > QUARANTINE_TTL_HOURS_MAX) {
    throw new Error(`olderThanHours deve ser um inteiro entre 1 e ${QUARANTINE_TTL_HOURS_MAX}.`);
  }

  const c = getS3Client();
  const cutoff = Date.now() - hours * 3600 * 1000;
  let deleted = 0;

  for (const kind of Object.keys(ALLOWED_MEDIA)) {
    const bucket = getStorageConfig().privateBucket; // B-01: quarentena no privado
    const prefix = `${QUARANTINE_PREFIX}/${kind}/`;
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token
      }));
      // B-10: remoção em lote (DeleteObjects) por página de até 1000 chaves
      const stale = (list.Contents || []).filter((obj) => {
        const lm = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
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
    } while (token);
  }
  return { deleted };
}

// ─────────────────────────────────────────────────────────────
// Configuração pública (para o frontend)
// ─────────────────────────────────────────────────────────────
function getPublicR2Config() {
  const c = getStorageConfig();
  return { // B-05: só o que o frontend consome (sem accountId/buckets/s3Host)
    ok: true,
    publicBaseUrl: c.publicBaseUrl,
    allowedMedia: Object.fromEntries(
      Object.entries(ALLOWED_MEDIA).map(([k, v]) => [k, {
        exts: [...v.exts],
        mimes: [...v.mimes],
        maxBytes: v.maxBytes
      }])
    ),
    quarantine: {
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
