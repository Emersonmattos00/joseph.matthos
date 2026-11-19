/* ============================================================
   js/admin/uploads.js — v10.6 (Audit Final — Cloudflare R2)
   ============================================================
   Correções aplicadas da auditoria v10.5:
   1. Validação hostname R2 restrita ao Account ID configurado
   2. AbortSignal propagado para upload-sign e upload-confirm
   3. sleep() remove listener em ambos caminhos (resolve/reject)
   4. Lógica de retry simplificada (removida isClientError)
   5. Retry-After respeitado integralmente (>MAX aborta retry)
   6. Cancelamento propagado em compressImage (por etapas)
   7. Callback onProgress protegido com try/catch
   8. extraData com whitelist de campos permitidos
   9. Botão de cancelar na interface (progress toast)
   10. Account ID documentado como configuração (não presumido)
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Configuração — AJUSTAR conforme seu ambiente Cloudflare
// ─────────────────────────────────────────────────────────────

/**
 * ⚠ CONFIGURAÇÃO OBRIGATÓRIA
 * Account ID do Cloudflare: obtido em https://dash.cloudflare.com/
 * (painel principal → coluna direita, "Account ID")
 * 
 * NÃO é o mesmo ID do bucket público (pub-...).
 * O endpoint S3 do R2 usa: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 */
const R2_ACCOUNT_ID = 'SEU_ACCOUNT_ID_AQUI'; // ← AJUSTE AQUI

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;
const MAX_UPLOAD_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 15_000;       // se Retry-After > 15s, abortamos retry
const UPLOAD_SPEED_BPS = 300 * 1024;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 1_200_000;        // 20 min
const PROGRESS_THROTTLE_PCT = 10;

// Whitelist de campos aceitos em extraData (correção #8)
const ALLOWED_EXTRA_FIELDS = new Set([
  'albumId', 'trackId', 'trackIndex', 'trackNumber', 'kind'
]);

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a',
  'audio/aac', 'audio/opus', 'audio/webm', 'audio/flac', 'audio/x-wav'
]);
const AUDIO_EXTENSIONS = new Set(['mp3','m4a','mp4','wav','ogg','oga','opus','flac','aac','webm','aif','aiff']);
const IMAGE_EXTENSIONS = new Set(['jpg','jpeg','png','webp']);

// ─────────────────────────────────────────────────────────────
// API pública — AbortSignal propagado em todas as funções
// ─────────────────────────────────────────────────────────────
export async function uploadImage(file, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidImage(file)) throw new Error('Formato de imagem não suportado (use JPG, PNG ou WebP).');
  if (file.size > MAX_IMAGE_SIZE) throw new Error('Imagem muito grande (máx 5 MB).');

  const base64 = await compressImage(file, 1920, 0.82, signal);
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const filename = file.name ? file.name.replace(/\.[^.]+$/, '') : 'image';
  const finalName = `${filename}.jpg`;
  return uploadBase64(base64, finalName, 'image/jpeg', 'image', signal);
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
  if (file.size > MAX_AUDIO_SIZE) {
    throw new Error(`Áudio muito grande (máx ${MAX_AUDIO_SIZE / 1048576} MB).`);
  }

  const contentType = normalizeAudioMime(file);

  // 1) URL assinada — com AbortSignal (correção #2)
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  const signRes = await apiFetch('upload-sign', {
    method: 'POST',
    body: {
      kind,
      filename: file.name || 'audio.mp3',
      contentType,
      size: file.size
    },
    signal // propagado se apiFetch aceitar
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

  // 2) PUT com retry
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
  await putFileXHRWithRetry(signRes.uploadUrl, file, contentType, onProgress, signal);

  // 3) Confirmação — com AbortSignal (correção #2)
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const confirmBody = {
    ...filterExtraData(extraData), // whitelist aplicada (correção #8)
    kind,
    path: signRes.path
  };

  const confirm = await apiFetch('upload-confirm', {
    method: 'POST',
    body: confirmBody,
    signal
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
// PUT com retry — lógica simplificada
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

      if (err.name === 'AbortError' || signal?.aborted) {
        throw new DOMException('Upload cancelado pelo usuário.', 'AbortError');
      }

      const status = err.httpStatus || 0;

      // Correção #4: lógica simplificada, sem isClientError
      const isRetryable =
        status === 0 ||                            // erro de rede
        status === 408 ||                          // timeout
        status === 429 ||                          // rate limit
        (status >= 500 && status <= 599);          // qualquer 5xx

      if (!isRetryable || attempt >= MAX_UPLOAD_RETRIES) {
        throw err;
      }

      // Correção #5: Retry-After respeitado integralmente
      let delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      if (err.retryAfterMs && err.retryAfterMs > 0) {
        if (err.retryAfterMs > RETRY_MAX_DELAY_MS) {
          // Servidor pede espera maior que nosso limite operacional → aborta retry
          const error = new Error(
            `Servidor pediu espera de ${Math.round(err.retryAfterMs/1000)}s. Tente novamente em instantes.`
          );
          error.httpStatus = status;
          throw error;
        }
        delay = err.retryAfterMs;
      }

      console.warn(`[upload] tentativa ${attempt + 1}/${MAX_UPLOAD_RETRIES + 1} falhou (HTTP ${status || 'rede'}), retry em ${delay}ms`);
      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/**
 * PUT binário via XHR.
 * Listener de abort com { once: true } e cleanup em todos os caminhos.
 */
function putFileXHR(url, file, contentType, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    const estimatedTime = (file.size / UPLOAD_SPEED_BPS) * 1000;
    xhr.timeout = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, estimatedTime * 1.5));

    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);

    // Progresso protegido contra exceções do callback (correção #7)
    let lastReportedPct = -1;
    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const pct = Math.round((e.loaded / e.total) * 100);
        if (pct > lastReportedPct && (pct >= lastReportedPct + PROGRESS_THROTTLE_PCT || pct === 100)) {
          try { onProgress(pct); } catch (cbErr) {
            console.warn('[upload] callback onProgress lançou erro:', cbErr);
          }
          lastReportedPct = pct;
        }
      };
    }

    // Listener com { once: true } — removido automaticamente após 1ª chamada
    let abortHandler = null;
    if (signal && !signal.aborted) {
      abortHandler = () => { try { xhr.abort(); } catch {} };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const cleanup = () => {
      if (abortHandler && signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
        abortHandler = null;
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
// Upload Base64 — imagens (com AbortSignal)
// ─────────────────────────────────────────────────────────────
async function uploadBase64(base64, filename, contentType, kind, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const result = await apiFetch('upload', {
    method: 'POST',
    body: { kind, filename, contentType, base64 },
    signal
  });

  if (!result || !result.ok) throw new Error((result && result.error) || 'Falha no upload.');
  if (!result.url && !result.path) throw new Error('Servidor não retornou URL nem path.');

  return { url: result.url || null, path: result.path || null };
}

// ─────────────────────────────────────────────────────────────
// Bind de <input> — com botão cancelar na interface
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

      // Progresso visual COM botão cancelar (correção #9)
      const updateProgress = (pct) => {
        if (!progressElement) {
          progressElement = document.createElement('div');
          progressElement.className = 'upload-progress-toast';
          progressElement.innerHTML = `
            <div class="upt-header">
              <span>Enviando ${label}: <span class="pct">0%</span></span>
              <button class="upt-cancel" type="button" aria-label="Cancelar upload" title="Cancelar">✕</button>
            </div>
            <div class="progress-bar"><div class="fill" style="width:0%"></div></div>
          `;
          document.body.appendChild(progressElement);

          progressElement.querySelector('.upt-cancel').addEventListener('click', () => {
            abortController.abort();
          });
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

      if (typeof onUploaded === 'function') {
        await onUploaded(result);
      }

      toast('Upload concluído.', '✓');
    } catch (err) {
      console.error('[upload]', err);
      if (err.name !== 'AbortError') {
        toast(err?.message || 'Erro no upload.', '⚠');
      } else {
        toast('Upload cancelado.', '⚠');
      }
    } finally {
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
 * Correção #1: Validação restrita ao Account ID configurado.
 * Aceita apenas https://<ACCOUNT_ID>.r2.cloudflarestorage.com
 */
function isAllowedUploadUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password || u.port) return false;

    const expectedHost = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    return u.hostname === expectedHost;
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
 * Whitelist de campos permitidos em extraData (correção #8)
 */
function filterExtraData(extraData) {
  if (!extraData || typeof extraData !== 'object') return {};
  const filtered = {};
  for (const key of Object.keys(extraData)) {
    if (ALLOWED_EXTRA_FIELDS.has(key)) {
      filtered[key] = extraData[key];
    }
  }
  return filtered;
}

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

/**
 * Correção #3: sleep remove listener em AMBOS caminhos
 */
function sleep(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('Cancelado', 'AbortError'));
    }

    const timer = setTimeout(onDone, ms);
    let abortHandler = null;

    function onDone() {
      if (abortHandler && signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }
      resolve();
    }

    if (signal) {
      abortHandler = () => {
        clearTimeout(timer);
        try { signal.removeEventListener('abort', abortHandler); } catch {}
        reject(new DOMException('Cancelado', 'AbortError'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Conversão de imagem — com checkpoints de cancelamento (correção #6)
// ─────────────────────────────────────────────────────────────
async function compressImage(file, maxWidth, quality, signal = null) {
  if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url, signal);
    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    const scale = Math.min(1, maxWidth / img.width);
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Não foi possível processar a imagem.');

    if (signal?.aborted) throw new DOMException('Cancelado', 'AbortError');

    ctx.drawImage(img, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src, signal = null) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    const abortHandler = () => {
      img.src = '';
      reject(new DOMException('Cancelado', 'AbortError'));
    };

    if (signal) {
      if (signal.aborted) return abortHandler();
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    img.onload = () => {
      if (signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }
      resolve(img);
    };
    img.onerror = () => {
      if (signal) {
        try { signal.removeEventListener('abort', abortHandler); } catch {}
      }
      reject(new Error('Imagem inválida.'));
    };
    img.src = src;
  });
}
