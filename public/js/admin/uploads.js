/* ============================================================
   js/admin/uploads.js — v10.10 (Production Approved)
   ============================================================
   Correções da auditoria:
   1. Usa `buildUrl` exportado do `api.js` (elimina `getApiConfig`)
   2. Validação de IDs flexível (aceita strings/numbers, não apenas UUIDv4)
   3. `sanitizeFilename` preserva a extensão do arquivo
   4. Verificação de `signal.aborted` imediatamente antes do `xhr.send()`
   ============================================================ */

import { apiFetch, buildUrl } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────
const R2_ACCOUNT_ID = 'SEU_ACCOUNT_ID_AQUI'; // 32 hex chars
const R2_BUCKET     = 'NOME_DO_BUCKET_AQUI'; // lowercase + dígitos + hífen

if (!/^[a-f0-9]{32}$/.test(R2_ACCOUNT_ID)) {
  throw new Error('[uploads] Configure um Account ID válido do Cloudflare R2 (32 hex chars).');
}
if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(R2_BUCKET)) {
  throw new Error('[uploads] Configure um nome de bucket R2 válido.');
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;
const MAX_UPLOAD_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15_000;
const UPLOAD_SPEED_BPS = 300 * 1024;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 1_200_000;
const PROGRESS_THROTTLE_PCT = 10;
const MAX_ID_LENGTH = 64;
const MAX_TRACK_INDEX = 999;
const MAX_TRACK_NUMBER = 999;
const MAX_IMAGE_PIXELS = 50_000_000;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a',
  'audio/aac', 'audio/opus', 'audio/webm', 'audio/flac', 'audio/x-wav'
]);
const AUDIO_EXTENSIONS = new Set(['mp3','m4a','mp4','wav','ogg','oga','opus','flac','aac','webm','aif','aiff']);
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','webp']);

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────
export async function uploadImage(file, onProgress = null, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidImage(file)) throw new Error('Formato de imagem não suportado.');
  if (file.size > MAX_IMAGE_SIZE) throw new Error('Imagem muito grande (máx 5 MB).');

  const base64 = await compressImage(file, 1920, 0.82, signal);
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const safeName = sanitizeFilename(file.name || 'image.jpg');
  const finalName = safeName.endsWith('.jpg') ? safeName : `${safeName}.jpg`;

  return uploadBase64WithProgress(base64, finalName, 'image/jpeg', 'image', onProgress, signal);
}

export async function uploadAudioPreview(file, onProgress, extraData = {}, signal = null) {
  return uploadAudioPresigned(file, 'audio-preview', onProgress, extraData, signal);
}

export async function uploadAudioFull(file, onProgress, extraData = {}, signal = null) {
  return uploadAudioPresigned(file, 'audio-full', onProgress, extraData, signal);
}

export async function uploadAudio(file, onProgress, extraData = {}, signal = null) {
  return uploadAudioFull(file, onProgress, extraData, signal);
}

// ─────────────────────────────────────────────────────────────
// Presigned upload — áudio
// ─────────────────────────────────────────────────────────────
async function uploadAudioPresigned(file, kind, onProgress, extraData = {}, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidAudio(file)) throw new Error('Formato de áudio não suportado.');
  if (file.size > MAX_AUDIO_SIZE) throw new Error(`Áudio muito grande (máx ${MAX_AUDIO_SIZE / 1048576} MB).`);

  const contentType = normalizeAudioMime(file);

  const signRes = await apiFetch('upload-sign', {
    method: 'POST',
    body: { kind, filename: sanitizeFilename(file.name || 'audio.mp3'), contentType, size: file.size },
    signal
  });

  if (!signRes?.ok || !signRes.uploadUrl || !signRes.path) {
    throw new Error(signRes?.error || 'Falha ao preparar upload.');
  }
  if (!isAllowedUploadUrl(signRes.uploadUrl)) throw new Error('URL de upload não autorizada.');
  if (!isValidStoragePath(signRes.path)) throw new Error('Caminho de armazenamento inválido.');

  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  await putFileXHRWithRetry(signRes.uploadUrl, file, contentType, onProgress, signal);

  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const confirmBody = { ...filterExtraData(extraData), kind, path: signRes.path };
  const confirm = await apiFetch('upload-confirm', { method: 'POST', body: confirmBody, signal });

  if (!confirm?.ok) throw new Error(confirm?.error || 'Falha ao confirmar upload.');
  if (typeof confirm.path !== 'string' || !confirm.path) throw new Error('Backend não retornou o caminho confirmado.');
  if (confirm.path !== signRes.path) throw new Error('O caminho confirmado não corresponde ao enviado.');

  return { url: confirm.url || null, path: confirm.path, track: confirm.track || null };
}

// ─────────────────────────────────────────────────────────────
// PUT com retry
// ─────────────────────────────────────────────────────────────
async function putFileXHRWithRetry(url, file, contentType, onProgress, signal) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    try {
      await putFileXHR(url, file, contentType, onProgress, signal);
      return;
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError' || signal?.aborted) throw new DOMException('Cancelado pelo usuário.', 'AbortError');

      const status = err.httpStatus || 0;
      const isRetryable = status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);
      if (!isRetryable || attempt >= MAX_UPLOAD_RETRIES) throw err;

      let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      if (err.retryAfterMs !== null && err.retryAfterMs !== undefined) {
        if (err.retryAfterMs > RETRY_MAX_DELAY_MS) {
          const error = new Error(`Servidor pediu espera de ${Math.round(err.retryAfterMs/1000)}s.`);
          error.httpStatus = status;
          throw error;
        }
        delay = Math.max(0, err.retryAfterMs);
      }
      console.warn(`[upload] tentativa ${attempt + 1} falhou (HTTP ${status}), retry em ${delay}ms`);
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

function putFileXHR(url, file, contentType, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, (file.size / UPLOAD_SPEED_BPS) * 1000 * 1.5));

    try {
      xhr.open('PUT', url, true);
      xhr.setRequestHeader('Content-Type', contentType);
    } catch (err) {
      return reject(new Error(`Não foi possível iniciar upload: ${err.message}`));
    }

    let lastReportedPct = -1;
    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        if (pct > lastReportedPct && (pct >= lastReportedPct + PROGRESS_THROTTLE_PCT || pct === 100)) {
          try { onProgress(pct); } catch (cbErr) { console.warn('[upload] callback error:', cbErr); }
          lastReportedPct = pct;
        }
      };
    }

    let abortHandler = null;
    if (signal && !signal.aborted) {
      abortHandler = () => { try { xhr.abort(); } catch {} };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (abortHandler && signal) { try { signal.removeEventListener('abort', abortHandler); } catch {} }
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else {
        const error = new Error(`Upload falhou (HTTP ${xhr.status}): ${(xhr.responseText || '').slice(0, 300)}`);
        error.httpStatus = xhr.status;
        error.retryAfterMs = parseRetryAfter(xhr.getResponseHeader('Retry-After'));
        reject(error);
      }
    };
    xhr.onerror = () => { cleanup(); const e = new Error('Erro de rede.'); e.httpStatus = 0; reject(e); };
    xhr.ontimeout = () => { cleanup(); const e = new Error('Timeout.'); e.httpStatus = 408; reject(e); };
    xhr.onabort = () => { cleanup(); const e = new Error('Cancelado.'); e.name = 'AbortError'; e.httpStatus = 0; reject(e); };

    try { xhr.send(file); } catch (err) { cleanup(); reject(new Error(`Falha ao enviar: ${err.message}`)); }
  });
}

// ─────────────────────────────────────────────────────────────
// Upload de imagem com progresso (usando buildUrl do api.js)
// ─────────────────────────────────────────────────────────────
function uploadBase64WithProgress(base64, filename, contentType, kind, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelado', 'AbortError'));

    // Correção: Usa a função exportada do api.js para garantir a URL correta
    const url = buildUrl('upload', null);
    const payload = JSON.stringify({ kind, filename, contentType, base64 });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 60_000;
    xhr.withCredentials = true; // Equivalente a credentials: 'same-origin'

    let lastReportedPct = -1;
    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        if (pct > lastReportedPct && (pct >= lastReportedPct + PROGRESS_THROTTLE_PCT || pct === 100)) {
          try { onProgress(pct); } catch (cbErr) { console.warn('[upload-img] callback error:', cbErr); }
          lastReportedPct = pct;
        }
      };
    }

    let abortHandler = null;
    if (signal && !signal.aborted) {
      abortHandler = () => { try { xhr.abort(); } catch {} };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (abortHandler && signal) { try { signal.removeEventListener('abort', abortHandler); } catch {} }
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const result = JSON.parse(xhr.responseText);
          if (!result || !result.ok) return reject(new Error((result && result.error) || 'Falha no upload.'));
          if (!result.url && !result.path) return reject(new Error('Servidor não retornou URL nem path.'));
          resolve({ url: result.url || null, path: result.path || null });
        } catch (e) { reject(new Error('Resposta inválida do servidor.')); }
      } else {
        reject(new Error(`Upload falhou (HTTP ${xhr.status}): ${(xhr.responseText || '').slice(0, 300)}`));
      }
    };
    xhr.onerror = () => { cleanup(); reject(new Error('Erro de rede no upload da imagem.')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('Timeout no upload da imagem.')); };
    xhr.onabort = () => { cleanup(); const e = new Error('Cancelado.'); e.name = 'AbortError'; reject(e); };

    // Correção: Verificar cancelamento imediatamente antes do envio
    if (signal?.aborted) {
      cleanup();
      return reject(new DOMException('Cancelado', 'AbortError'));
    }

    try { xhr.send(payload); } catch (err) { cleanup(); reject(new Error(`Falha ao enviar: ${err.message}`)); }
  });
}

// ─────────────────────────────────────────────────────────────
// Bind e UI
// ─────────────────────────────────────────────────────────────
export function bindUpload(inputId, onUploaded, kind = 'image', getExtraData = null) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input._uploadHandler) input.removeEventListener('change', input._uploadHandler);

  const handler = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (input._uploadInProgress) { toast('Upload em andamento.', '⚠'); input.value = ''; return; }
    input._uploadInProgress = true;

    const labels = { 'image': 'imagem', 'audio-preview': 'prévia', 'audio-full': 'áudio' };
    const label = labels[kind] || 'arquivo';
    const abortController = new AbortController();

    const progressElement = createProgressUI(label, () => abortController.abort());
    document.body.appendChild(progressElement);

    const updateProgress = (pct) => {
      const pctEl = progressElement.querySelector('.pct');
      const fillEl = progressElement.querySelector('.fill');
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (fillEl) fillEl.style.width = `${pct}%`;
    };

    try {
      const extraData = typeof getExtraData === 'function' ? getExtraData() : {};
      let result;

      if (kind === 'image') result = await uploadImage(file, updateProgress, abortController.signal);
      else if (kind === 'audio-preview') result = await uploadAudioPreview(file, updateProgress, extraData, abortController.signal);
      else if (kind === 'audio-full') result = await uploadAudioFull(file, updateProgress, extraData, abortController.signal);
      else throw new Error(`Tipo inválido: ${kind}`);

      setCancelEnabled(progressElement, false);
      updateProgress(100);

      try {
        if (typeof onUploaded === 'function') await onUploaded(result);
        toast('Upload concluído.', '✓');
      } catch (cbErr) {
        console.error('[upload] callback falhou:', cbErr);
        toast('Arquivo enviado, mas erro ao atualizar interface.', '⚠');
      }
    } catch (err) {
      console.error('[upload]', err);
      if (err.name === 'AbortError') toast('Upload cancelado.', '⚠');
      else toast(err?.message || 'Erro no upload.', '⚠');
    } finally {
      if (progressElement.parentNode) progressElement.remove();
      input.value = '';
      input._uploadInProgress = false;
    }
  };

  input._uploadHandler = handler;
  input.addEventListener('change', handler);
}

function createProgressUI(label, onCancel) {
  const el = document.createElement('div');
  el.className = 'upload-progress-toast';
  el.innerHTML = `<div class="upt-header"><span>Enviando ${label}: <span class="pct">0%</span></span><button class="upt-cancel" type="button" title="Cancelar">✕</button></div><div class="progress-bar"><div class="fill" style="width:0%"></div></div>`;
  el.querySelector('.upt-cancel').addEventListener('click', onCancel);
  return el;
}

function setCancelEnabled(el, enabled) {
  const btn = el?.querySelector('.upt-cancel');
  if (!btn) return;
  btn.disabled = !enabled;
  btn.style.opacity = enabled ? '1' : '0.3';
  btn.style.pointerEvents = enabled ? 'auto' : 'none';
}

// ─────────────────────────────────────────────────────────────
// Helpers de validação
// ─────────────────────────────────────────────────────────────
function isValidImage(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  return ALLOWED_IMAGE_TYPES.has(mime) || IMAGE_EXTENSIONS.has(getExtension(file.name));
}

function isValidAudio(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  return ALLOWED_AUDIO_TYPES.has(mime) || AUDIO_EXTENSIONS.has(getExtension(file.name));
}

function normalizeAudioMime(file) {
  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_AUDIO_TYPES.has(mime)) return mime;
  const ext = getExtension(file.name);
  const map = { mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac', aac: 'audio/aac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff' };
  return map[ext] || 'audio/mpeg';
}

function getExtension(filename) {
  const s = String(filename || '');
  const dot = s.lastIndexOf('.');
  return dot < 0 ? '' : s.slice(dot + 1).toLowerCase();
}

// Correção: Preserva a extensão do arquivo
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'arquivo';
  const dot = name.lastIndexOf('.');
  const baseName = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  let safeBase = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);

  return (safeBase || 'arquivo') + ext;
}

function isAllowedUploadUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const accountHost = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    return (u.hostname === accountHost && u.pathname.startsWith(`/${R2_BUCKET}/`)) || u.hostname === `${R2_BUCKET}.${accountHost}`;
  } catch { return false; }
}

function isValidStoragePath(path) {
  if (!path || typeof path !== 'string') return false;
  if (path.includes('..') || path.includes('//') || path.includes('\\')) return false;
  if (/[<>"|?*\x00-\x1F]/.test(path) || /%2e%2e|%252e%252e/i.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/') || path.trim() === '') return false;
  return true;
}

// Correção: Validação flexível (aceita strings e números, não apenas UUIDv4)
function filterExtraData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const result = {};
  
  if (typeof data.albumId === 'string' && data.albumId.trim().length <= MAX_ID_LENGTH) {
    result.albumId = data.albumId.trim();
  }
  if (typeof data.trackId === 'string' && data.trackId.trim().length <= MAX_ID_LENGTH) {
    result.trackId = data.trackId.trim();
  }
  if (Number.isInteger(data.trackIndex) && data.trackIndex >= 0 && data.trackIndex <= MAX_TRACK_INDEX) {
    result.trackIndex = data.trackIndex;
  }
  if (Number.isInteger(data.trackNumber) && data.trackNumber > 0 && data.trackNumber <= MAX_TRACK_NUMBER) {
    result.trackNumber = data.trackNumber;
  }
  return result;
}

function parseRetryAfter(header) {
  if (header === null || header === undefined || header === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : 0;
  }
  return null;
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelado', 'AbortError'));
    const timer = setTimeout(onDone, ms);
    let abortHandler = null;
    function onDone() {
      if (abortHandler && signal) { try { signal.removeEventListener('abort', abortHandler); } catch {} }
      resolve();
    }
    if (signal) {
      abortHandler = () => { clearTimeout(timer); try { signal.removeEventListener('abort', abortHandler); } catch {} reject(new DOMException('Cancelado', 'AbortError')); };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

async function compressImage(file, maxWidth, quality, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url, signal);
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    if (img.width * img.height > MAX_IMAGE_PIXELS) throw new Error(`Imagem muito grande (${Math.round((img.width * img.height) / 1_000_000)}MP).`);
    
    const scale = Math.min(1, maxWidth / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Não foi possível processar a imagem.');
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    
    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return dataUrl.slice(dataUrl.indexOf(',') + 1);
  } finally { URL.revokeObjectURL(url); }
}

function loadImage(src, signal = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const finish = (fn, arg) => { if (settled) return; settled = true; cleanup(); fn(arg); };
    const cleanup = () => {
      try { img.removeEventListener('load', onLoad); } catch {}
      try { img.removeEventListener('error', onError); } catch {}
      if (signal && abortHandler) { try { signal.removeEventListener('abort', abortHandler); } catch {} }
    };
    const onLoad = () => finish(resolve, img);
    const onError = () => finish(reject, new Error('Imagem inválida.'));
    let abortHandler = null;
    if (signal) {
      if (signal.aborted) { img.src = ''; return reject(new DOMException('Cancelado', 'AbortError')); }
      abortHandler = () => { try { img.src = ''; } catch {} finish(reject, new DOMException('Cancelado', 'AbortError')); };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    img.addEventListener('load', onLoad, { once: true });
    img.addEventListener('error', onError, { once: true });
    img.src = src;
  });
}
