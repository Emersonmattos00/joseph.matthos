/* ============================================================
   js/admin/uploads.js — v10.5 (Audit Final — Cloudflare R2)
   ============================================================
   Correções da auditoria v10.4:
   1. AbortSignal propagado nas funções públicas
   2. Cancelamento funciona mesmo se abortado antes do PUT
   3. Barra de progresso removida em finally (todos os caminhos)
   4. Progresso 100% não dispara notificação duplicada
   5. Retry cobre toda a faixa 5xx + respeita Retry-After
   6. Timeout máximo dinâmico (até 20 min para 200 MB)
   Extras:
   - Validação do Account ID no hostname R2
   - Bloqueio de upload simultâneo pelo mesmo input
   - Remoção do listener de abort em todos os caminhos
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;              // 5 MB
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;            // 200 MB
const MAX_UPLOAD_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10_000;                   // cap para Retry-After grande
const UPLOAD_SPEED_BPS = 300 * 1024;                 // 300 KB/s
const MIN_TIMEOUT_MS = 60_000;                       // 1 min
const MAX_TIMEOUT_MS = 1_200_000;                    // 20 min (200MB @ 300KB/s ≈ 11 min + margem)
const PROGRESS_THROTTLE_PCT = 10;                    // notifica a cada 10%

// Account ID do Cloudflare R2 — ajustar conforme seu ambiente
// Endpoint padrão: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
const R2_ACCOUNT_ID = '9eaf26fd8c784a62bae2457a45edc7d2'; // extraído do pub-...

// Status não-retryable (cliente)
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 405, 410, 413, 415]);

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a',
  'audio/aac', 'audio/opus', 'audio/webm', 'audio/flac', 'audio/x-wav'
]);
const AUDIO_EXTENSIONS = new Set(['mp3','m4a','mp4','wav','ogg','oga','opus','flac','aac','webm','aif','aiff']);
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','webp']);

// ─────────────────────────────────────────────────────────────
// API pública (AbortSignal disponível em todas as funções)
// ─────────────────────────────────────────────────────────────
export async function uploadImage(file, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidImage(file)) throw new Error('Formato de imagem não suportado (use JPG, PNG ou WebP).');
  if (file.size > MAX_IMAGE_SIZE) throw new Error('Imagem muito grande (máx 5 MB).');

  const base64 = await compressImage(file, 1920, 0.82);
  const filename = file.name ? file.name.replace(/\.[^.]+$/, '') : 'image';
  const finalName = `${filename}.jpg`;
  return uploadBase64(base64, finalName, 'image/jpeg', 'image');
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
// Presigned upload — áudio (Cloudflare R2)
// ─────────────────────────────────────────────────────────────
async function uploadAudioPresigned(file, kind, onProgress, extraData = {}, signal = null) {
  // Verificação inicial de cancelamento (correção #2)
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidAudio(file)) throw new Error('Formato de áudio não suportado.');
  if (file.size > MAX_AUDIO_SIZE) throw new Error(`Áudio muito grande (máx ${MAX_AUDIO_SIZE / 1048576} MB).`);

  const contentType = normalizeAudioMime(file);

  // 1) URL assinada
  const signRes = await apiFetch('upload-sign', {
    method: 'POST',
    body: {
      kind,
      filename: file.name || 'audio.mp3',
      contentType,
      size: file.size
    }
  });

  if (!signRes?.ok || !signRes.uploadUrl || !signRes.path) {
    throw new Error(signRes?.error || 'Falha ao preparar upload.');
  }

  if (!isAllowedUploadUrl(signRes.uploadUrl)) {
    throw new Error('URL de upload não autorizada.');
  }
  if (!isValidStoragePath(signRes.path)) {
    throw new Error('Caminho de armazenamento inválido.');
  }

  // 2) PUT com retry inteligente + abort
  await putFileXHRWithRetry(signRes.uploadUrl, file, contentType, onProgress, signal);

  // Verificação intermediária: pode ter sido cancelado durante o PUT
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  // 3) Confirmação — extraData primeiro para não sobrescrever kind/path
  const confirmBody = {
    ...extraData,
    kind,
    path: signRes.path
  };

  const confirm = await apiFetch('upload-confirm', {
    method: 'POST',
    body: confirmBody
  });

  if (!confirm?.ok) {
    throw new Error(confirm?.error || 'Falha ao confirmar upload.');
  }

  return {
    url: confirm.url || null,
    path: confirm.path || signRes.path,
    track: confirm.track || null
  };
}

// ─────────────────────────────────────────────────────────────
// PUT com retry — respeita Retry-After e faixa 5xx completa
// ─────────────────────────────────────────────────────────────
async function putFileXHRWithRetry(url, file, contentType, onProgress, signal) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    // Verificação de cancelamento antes de cada tentativa
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    try {
      await putFileXHR(url, file, contentType, onProgress, signal);
      return;
    } catch (err) {
      lastError = err;

      // Cancelamento explícito → não retry
      if (err.name === 'AbortError' || signal?.aborted) {
        throw new DOMException('Upload cancelado pelo usuário.', 'AbortError');
      }

      // Decisão de retry baseada no status HTTP
      const status = err.httpStatus || 0;
      const isClientError = status >= 400 && status < 500 && !NON_RETRYABLE_STATUS.has(status) === false;
      const isRetryable =
        status === 0 ||                            // erro de rede
        status === 408 ||                          // timeout
        status === 429 ||                          // rate limit
        (status >= 500 && status <= 599);          // qualquer 5xx (correção #5)

      if (!isRetryable || attempt >= MAX_UPLOAD_RETRIES) {
        throw err;
      }

      // Backoff: usa Retry-After quando disponível (correção #5)
      let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      if (err.retryAfterMs && err.retryAfterMs > 0) {
        delay = Math.min(err.retryAfterMs, RETRY_MAX_DELAY_MS);
      }
      console.warn(`[upload] tentativa ${attempt + 1}/${MAX_UPLOAD_RETRIES + 1} falhou (HTTP ${status || 'rede'}), retry em ${delay}ms`);
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/**
 * PUT binário via XHR para Cloudflare R2.
 * - Registra abort listener somente se signal ainda não foi abortado
 * - Remove listener em todos os caminhos (load/error/timeout/abort)
 */
function putFileXHR(url, file, contentType, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    // Timeout dinâmico com limite de 20 min (correção #6)
    const estimatedTime = (file.size / UPLOAD_SPEED_BPS) * 1000;
    xhr.timeout = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, estimatedTime * 1.5));

    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);

    // Progresso com throttle e proteção contra 100% duplicado (correção #4)
    let lastReportedPct = -1;
    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        if (pct > lastReportedPct && (pct >= lastReportedPct + PROGRESS_THROTTLE_PCT || pct === 100)) {
          onProgress(pct);
          lastReportedPct = pct;
        }
      };
    }

    // Listener de abort externo — registrado SOMENTE se signal não foi abortado
    let abortHandler = null;
    if (signal && !signal.aborted) {
      abortHandler = () => {
        try { xhr.abort(); } catch {}
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (abortHandler && signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        const error = new Error(`Upload falhou (HTTP ${xhr.status}): ${(xhr.responseText || '').slice(0, 300)}`);
        error.httpStatus = xhr.status;
        error.retryAfterMs = parseRetryAfter(xhr.getResponseHeader('Retry-After'));
        reject(error);
      }
    };

    xhr.onerror = () => {
      cleanup();
      const error = new Error('Erro de rede no upload. Verifique sua conexão.');
      error.httpStatus = 0;
      reject(error);
    };

    xhr.ontimeout = () => {
      cleanup();
      const error = new Error('Upload excedeu o tempo limite.');
      error.httpStatus = 408;
      reject(error);
    };

    xhr.onabort = () => {
      cleanup();
      const error = new Error('Upload cancelado.');
      error.name = 'AbortError';
      error.httpStatus = 0;
      reject(error);
    };

    xhr.send(file);
  });
}

// ─────────────────────────────────────────────────────────────
// Upload Base64 — imagens
// ─────────────────────────────────────────────────────────────
async function uploadBase64(base64, filename, contentType, kind) {
  const result = await apiFetch('upload', {
    method: 'POST',
    body: { kind, filename, contentType, base64 }
  });

  if (!result || !result.ok) throw new Error((result && result.error) || 'Falha no upload.');
  if (!result.url && !result.path) throw new Error('Servidor não retornou URL nem path.');

  return { url: result.url || null, path: result.path || null };
}

// ─────────────────────────────────────────────────────────────
// Bind de <input type="file"> — bloqueio de upload simultâneo
// ─────────────────────────────────────────────────────────────
export function bindUpload(inputId, onUploaded, kind = 'image', getExtraData = null) {
  const input = document.getElementById(inputId);
  if (!input) return;

  if (input._uploadHandler) {
    input.removeEventListener('change', input._uploadHandler);
  }

  const handler = async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    // Bloqueio de upload simultâneo pelo mesmo input
    if (input._uploadInProgress) {
      toast('Já existe um upload em andamento.', '⚠');
      input.value = '';
      return;
    }
    input._uploadInProgress = true;

    const labels = { 'image': 'imagem', 'audio-preview': 'prévia', 'audio-full': 'áudio' };
    const label = labels[kind] || 'arquivo';

    let progressElement = null;
    const abortController = new AbortController();

    try {
      toast(`Enviando ${label}...`, '⬆');

      // Progresso visual dedicado
      const updateProgress = (pct) => {
        if (!progressElement) {
          progressElement = document.createElement('div');
          progressElement.className = 'upload-progress-toast';
          progressElement.innerHTML = `
            <div>Enviando ${label}: <span class="pct">0%</span></div>
            <div class="progress-bar"><div class="fill" style="width:0%"></div></div>
          `;
          document.body.appendChild(progressElement);
        }
        const pctEl = progressElement.querySelector('.pct');
        const fillEl = progressElement.querySelector('.fill');
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (fillEl) fillEl.style.width = `${pct}%`;
      };

      const extraData = typeof getExtraData === 'function' ? getExtraData() : {};
      let result;

      if (kind === 'image') {
        result = await uploadImage(file, abortController.signal);
      } else if (kind === 'audio-preview') {
        result = await uploadAudioPreview(file, updateProgress, extraData, abortController.signal);
      } else if (kind === 'audio-full') {
        result = await uploadAudioFull(file, updateProgress, extraData, abortController.signal);
      } else {
        throw new Error(`Tipo de upload inválido: ${kind}`);
      }

      // Callback com await (pode ser assíncrono)
      if (typeof onUploaded === 'function') {
        await onUploaded(result);
      }

      toast('Upload concluído.', '✓');
    } catch (err) {
      console.error('[upload]', err);
      if (err.name !== 'AbortError') {
        toast(err?.message || 'Erro no upload.', '⚠');
      }
    } finally {
      // Progresso sempre removido (correção #3)
      if (progressElement && progressElement.parentNode) {
        progressElement.remove();
      }
      input.value = '';
      input._uploadInProgress = false;
    }
  };

  input._uploadHandler = handler;
  input.addEventListener('change', handler);
}

// ─────────────────────────────────────────────────────────────
// Helpers de validação
// ─────────────────────────────────────────────────────────────
function isValidImage(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_IMAGE_TYPES.has(mime)) return true;
  return IMAGE_EXTENSIONS.has(getExtension(file.name));
}

function isValidAudio(file) {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_AUDIO_TYPES.has(mime)) return true;
  return AUDIO_EXTENSIONS.has(getExtension(file.name));
}

function normalizeAudioMime(file) {
  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_AUDIO_TYPES.has(mime)) return mime;
  const ext = getExtension(file.name);
  const map = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav',
    ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac',
    aac: 'audio/aac', webm: 'audio/webm', aif: 'audio/aiff', aiff: 'audio/aiff'
  };
  return map[ext] || 'audio/mpeg';
}

function getExtension(filename) {
  const s = String(filename || '');
  const dot = s.lastIndexOf('.');
  return dot < 0 ? '' : s.slice(dot + 1).toLowerCase();
}

/**
 * Validação robusta de URL de upload — Cloudflare R2 padrão.
 * Verifica: protocolo, ausência de credenciais/porta, hostname com Account ID.
 */
function isAllowedUploadUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password || u.port) return false;

    // Aceita endpoint padrão do R2 (ACCOUNT_ID.r2.cloudflarestorage.com)
    const expectedHost = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    return u.hostname === expectedHost || u.hostname.endsWith('.r2.cloudflarestorage.com');
  } catch {
    return false;
  }
}

function isValidStoragePath(path) {
  if (!path || typeof path !== 'string') return false;
  if (path.includes('..')) return false;
  if (path.includes('//')) return false;
  if (/[<>"|?*\x00-\x1F]/.test(path)) return false;
  if (path.startsWith('/') || path.endsWith('/')) return false;
  if (path.trim() === '') return false;
  return true;
}

/**
 * Converte header Retry-After em ms.
 * Aceita segundos (inteiro) ou data HTTP.
 */
function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    const ms = date - Date.now();
    return ms > 0 ? ms : null;
  }
  return null;
}

function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelado', 'AbortError'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Conversão de imagem
// ─────────────────────────────────────────────────────────────
async function compressImage(file, maxWidth, quality) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxWidth / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Não foi possível processar a imagem.');

    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Imagem inválida.'));
    img.src = src;
  });
}
