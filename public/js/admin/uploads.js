/* ============================================================
   js/admin/uploads.js — v10.15 (Production Approved)
   ============================================================
   Correções da auditoria:
   1. Importação correta de `isPlainObject` do `api.js`
   2. Uso de `Object.hasOwn` em `filterExtraData` (propriedades próprias)
   3. Lógica de MIME prioriza o mapa de extensões para evitar metadados incorretos
   4. Removido `status === 0` da lista de retry (evita loops em falhas de CORS/DNS)
   5. Validação de configuração R2 mantida em runtime (evita quebra de importação)
   ============================================================ */

import { apiFetch, buildUrl, isPlainObject } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// ⚠ CONFIGURAÇÃO (Substitua pelos valores reais do ambiente)
// ─────────────────────────────────────────────────────────────
const R2_ACCOUNT_ID = 'f44bf615f12d9cb5159bd73d89c652cb'; // 32 hex chars
const R2_BUCKET     = 'josephmatthos'; // lowercase + dígitos + hífen

function validateR2Config() {
  if (!/^[a-f0-9]{32}$/.test(R2_ACCOUNT_ID)) {
    throw new Error('[uploads] ERRO: Configure R2_ACCOUNT_ID no topo do arquivo.');
  }
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(R2_BUCKET)) {
    throw new Error('[uploads] ERRO: Configure R2_BUCKET no topo do arquivo.');
  }
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;
const MAX_UPLOAD_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15_000;
const UPLOAD_SPEED_BPS = 300 * 1024;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 1_200_000;
const MAX_ID_LENGTH = 64;
const MAX_TRACK_INDEX = 999;   // Ajuste conforme contrato do banco
const MAX_TRACK_NUMBER = 999;  // Ajuste conforme contrato do banco
const MAX_IMAGE_PIXELS = 20_000_000; // 20MP

const ALLOWED_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const ALLOWED_AUDIO_EXTS = new Set(['mp3', 'm4a', 'mp4', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac', 'webm', 'aif', 'aiff']);
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a',
  'audio/aac', 'audio/opus', 'audio/webm', 'audio/flac', 'audio/x-wav', 'audio/aiff'
]);

// Correção: Mapa para garantir metadados corretos no R2
const AUDIO_MIME_BY_EXT = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
  aac: 'audio/aac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff'
};

// ─────────────────────────────────────────────────────────────
// Helpers de Validação Rigorosa
// ─────────────────────────────────────────────────────────────
function normalizeId(value, fieldName) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const id = value.trim();
    if (!id || id.length > MAX_ID_LENGTH) {
      throw new TypeError(`${fieldName} inválido (vazio ou excede ${MAX_ID_LENGTH} caracteres).`);
    }
    return id;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new TypeError(`${fieldName} deve ser string ou número inteiro seguro.`);
}

function filterExtraData(data) {
  if (data === undefined || data === null) return {};
  if (!isPlainObject(data)) {
    throw new TypeError('extraData deve ser um objeto simples ou null/undefined.');
  }
  
  const result = {};
  // Correção: Uso de Object.hasOwn para verificar propriedades próprias
  if (Object.hasOwn(data, 'albumId')) {
    const id = normalizeId(data.albumId, 'albumId');
    if (id !== undefined) result.albumId = id;
  }
  if (Object.hasOwn(data, 'trackId')) {
    const id = normalizeId(data.trackId, 'trackId');
    if (id !== undefined) result.trackId = id;
  }
  if (Object.hasOwn(data, 'trackIndex')) {
    if (!Number.isInteger(data.trackIndex) || data.trackIndex < 0 || data.trackIndex > MAX_TRACK_INDEX) {
      throw new TypeError('trackIndex deve ser um inteiro entre 0 e 999.');
    }
    result.trackIndex = data.trackIndex;
  }
  if (Object.hasOwn(data, 'trackNumber')) {
    if (!Number.isInteger(data.trackNumber) || data.trackNumber <= 0 || data.trackNumber > MAX_TRACK_NUMBER) {
      throw new TypeError('trackNumber deve ser um inteiro entre 1 e 999.');
    }
    result.trackNumber = data.trackNumber;
  }
  return result;
}

function getExtension(filename) {
  const s = String(filename || '');
  const dot = s.lastIndexOf('.');
  return dot < 0 ? '' : s.slice(dot + 1).toLowerCase();
}

function sanitizeFilename(name, allowedExts, forceExt = null) {
  if (!name || typeof name !== 'string') return forceExt ? `arquivo.${forceExt}` : 'arquivo';
  
  const dot = name.lastIndexOf('.');
  const baseName = dot > 0 ? name.slice(0, dot) : name;
  
  let safeBase = baseName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  
  safeBase = safeBase || 'arquivo';
  if (forceExt) return `${safeBase}.${forceExt}`;

  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (allowedExts.has(ext) && ext.length <= 10) {
    return `${safeBase}.${ext}`;
  }
  return safeBase;
}

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────
export async function uploadImage(file, onProgress = null, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (!file || file.size === 0) throw new Error('Arquivo ausente ou vazio.');
  
  const mime = String(file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  if (!ALLOWED_IMAGE_TYPES.has(mime) && !ALLOWED_IMAGE_EXTS.has(ext)) {
    throw new Error('Formato de imagem não suportado.');
  }
  if (file.size > MAX_IMAGE_SIZE) throw new Error('Imagem muito grande (máx 5 MB).');

  const base64 = await compressImage(file, 1920, 0.82, signal);
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const safeName = sanitizeFilename(file.name || 'image.jpg', ALLOWED_IMAGE_EXTS, 'jpg');
  return uploadBase64WithProgress(base64, safeName, 'image/jpeg', 'image', onProgress, signal);
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
  validateR2Config();
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (!file || file.size === 0) throw new Error('Arquivo ausente ou vazio.');
  
  const browserMime = String(file.type || '').toLowerCase();
  const ext = getExtension(file.name);
  
  if (!ALLOWED_AUDIO_TYPES.has(browserMime) && !ALLOWED_AUDIO_EXTS.has(ext)) {
    throw new Error('Formato de áudio não suportado.');
  }
  if (file.size > MAX_AUDIO_SIZE) throw new Error(`Áudio muito grande (máx ${MAX_AUDIO_SIZE / 1048576} MB).`);

  // Correção: Prioriza o MIME mapeado pela extensão para garantir metadados corretos no R2
  const mappedMime = AUDIO_MIME_BY_EXT[ext];
  const contentType = mappedMime || (ALLOWED_AUDIO_TYPES.has(browserMime) ? browserMime : 'audio/mpeg');

  const signRes = await apiFetch('upload-sign', {
    method: 'POST',
    body: { kind, filename: sanitizeFilename(file.name || 'audio.mp3', ALLOWED_AUDIO_EXTS), contentType, size: file.size },
    signal
  });

  if (!signRes?.ok || !signRes.uploadUrl || !signRes.path) {
    throw new Error(signRes?.error || 'Falha ao preparar upload.');
  }
  if (!isAllowedUploadUrl(signRes.uploadUrl, signRes.path)) throw new Error('URL de upload não autorizada ou path inconsistente.');
  if (!isValidStoragePath(signRes.path)) throw new Error('Caminho de armazenamento inválido.');

  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  await putFileXHRWithRetry(signRes.uploadUrl, file, contentType, onProgress, signal);

  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const confirmBody = { ...filterExtraData(extraData), kind, path: signRes.path };
  const confirm = await apiFetch('upload-confirm', { method: 'POST', body: confirmBody, signal });

  if (!confirm?.ok) throw new Error(confirm?.error || 'Falha ao confirmar upload.');
  if (typeof confirm.path !== 'string' || !confirm.path) throw new Error('Backend não retornou o caminho confirmado.');
  if (confirm.path !== signRes.path) throw new Error('O caminho confirmado não corresponde ao enviado.');

  if (typeof onProgress === 'function') {
    try { onProgress(100); } catch (err) { console.warn('[upload] callback final error:', err); }
  }

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

      const status = err.status || err.httpStatus || 0;
      
      // Correção: Removido status === 0 da lista de retry para evitar loops em falhas de CORS/DNS
      const isRetryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      
      if (!isRetryable || attempt >= MAX_UPLOAD_RETRIES) throw err;

      let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      if (err.retryAfterMs !== null && err.retryAfterMs !== undefined) {
        if (err.retryAfterMs > RETRY_MAX_DELAY_MS) {
          const error = new Error(`Servidor pediu espera de ${Math.round(err.retryAfterMs/1000)}s.`);
          error.status = status;
          throw error;
        }
        delay = Math.max(0, err.retryAfterMs);
      }
      
      if (status === 0) {
        console.warn(`[upload] Falha de rede/CORS (status 0). Verifique a configuração do bucket R2.`);
      } else {
        console.warn(`[upload] tentativa ${attempt + 1} falhou (HTTP ${status}), retry em ${delay}ms`);
      }
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

function parseXhrError(xhr, defaultMsg) {
  const err = new Error(defaultMsg || `Falha HTTP ${xhr.status}`);
  err.status = xhr.status;
  err.code = null;
  err.data = null;
  
  const contentType = xhr.getResponseHeader('content-type') || '';
  const isJson = /(?:application\/json|application\/[^;]+\+json)/i.test(contentType);

  if (isJson && xhr.responseText) {
    try {
      const data = JSON.parse(xhr.responseText);
      err.message = data.error || data.message || err.message;
      err.code = data.code || null;
      err.data = data;
    } catch {
      err.message += `: ${(xhr.responseText || '').slice(0, 300)}`;
    }
  } else if (xhr.responseText) {
    err.message += `: ${(xhr.responseText || '').slice(0, 300)}`;
  }
  return err;
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
        const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
        if (pct > lastReportedPct && (pct >= lastReportedPct + 10 || pct === 99)) {
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
        const err = parseXhrError(xhr, `Upload falhou (HTTP ${xhr.status})`);
        err.retryAfterMs = parseRetryAfter(xhr.getResponseHeader('Retry-After'));
        reject(err);
      }
    };
    xhr.onerror = () => { cleanup(); const e = new Error('Erro de rede.'); e.status = 0; reject(e); };
    xhr.ontimeout = () => { cleanup(); const e = new Error('Timeout.'); e.status = 408; reject(e); };
    xhr.onabort = () => { cleanup(); const e = new Error('Cancelado.'); e.name = 'AbortError'; e.status = 0; reject(e); };

    if (signal?.aborted) { cleanup(); return reject(new DOMException('Cancelado', 'AbortError')); }
    try { xhr.send(file); } catch (err) { cleanup(); reject(new Error(`Falha ao enviar: ${err.message}`)); }
  });
}

// ─────────────────────────────────────────────────────────────
// Upload de imagem com progresso (Padronizado)
// ─────────────────────────────────────────────────────────────
function uploadBase64WithProgress(base64, filename, contentType, kind, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelado', 'AbortError'));

    const url = buildUrl('upload', null);
    const payload = JSON.stringify({ kind, filename, contentType, base64 });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 60_000;
    xhr.withCredentials = true;

    let lastReportedPct = -1;
    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
        if (pct > lastReportedPct && (pct >= lastReportedPct + 10 || pct === 99)) {
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
          if (!result || !result.ok) return reject(parseXhrError(xhr, 'Falha no upload.'));
          if (!result.url && !result.path) return reject(new Error('Servidor não retornou URL nem path.'));
          
          if (typeof onProgress === 'function') {
            try { onProgress(100); } catch (err) { console.warn('[upload-img] callback final error:', err); }
          }
          resolve({ url: result.url || null, path: result.path || null });
        } catch (e) { 
          const err = new Error('Resposta inválida do servidor.');
          err.status = xhr.status;
          reject(err);
        }
      } else {
        reject(parseXhrError(xhr, `Upload falhou (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => { cleanup(); const e = new Error('Erro de rede na imagem.'); e.status = 0; reject(e); };
    xhr.ontimeout = () => { cleanup(); const e = new Error('Timeout na imagem.'); e.status = 408; reject(e); };
    xhr.onabort = () => { cleanup(); const e = new Error('Cancelado.'); e.name = 'AbortError'; e.status = 0; reject(e); };

    if (signal?.aborted) { cleanup(); return reject(new DOMException('Cancelado', 'AbortError')); }
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
// Validações de Segurança
// ─────────────────────────────────────────────────────────────
function isAllowedUploadUrl(url, expectedPath) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;

    const accountHost = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    const isPathStyle = u.hostname === accountHost;
    const isVirtualHost = u.hostname === `${R2_BUCKET}.${accountHost}`;

    if (!isPathStyle && !isVirtualHost) return false;

    if (expectedPath) {
      let urlPath;
      if (isPathStyle) {
        urlPath = decodeURIComponent(u.pathname.slice(`/${R2_BUCKET}/`.length));
      } else {
        urlPath = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
      }
      if (urlPath !== expectedPath) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isValidStoragePath(path) {
  if (!path || typeof path !== 'string') return false;
  if (path.includes('..') || path.includes('//') || path.includes('\\')) return false;
  if (/[<>"|?*\x00-\x1F]/.test(path) || /%2e%2e|%252e%252e/i.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/') || path.trim() === '') return false;
  return true;
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

// ─────────────────────────────────────────────────────────────
// Processamento de Imagem
// ─────────────────────────────────────────────────────────────
async function compressImage(file, maxWidth, quality, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url, signal);
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    
    if (img.width * img.height > MAX_IMAGE_PIXELS) {
      throw new Error(`Imagem muito grande (${Math.round((img.width * img.height) / 1_000_000)}MP).`);
    }
    
    const scale = Math.min(1, maxWidth / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Não foi possível processar a imagem.');
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
    
    ctx.drawImage(img, 0, 0, w, h);
    
    let dataUrl;
    try {
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    } catch (err) {
      throw new Error('Falha ao comprimir imagem (memória insuficiente ou formato inválido).');
    }
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
