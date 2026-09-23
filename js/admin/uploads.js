/* ============================================================
   js/admin/uploads.js — Upload de imagens e áudios
   ------------------------------------------------------------
   - Imagens: Base64 via /api/admin?action=upload
       (pequenas, cabem no body da Vercel)
   - Áudio:   presigned upload URL
       1) POST /api/admin?action=upload-sign  → recebe uploadUrl
       2) PUT direto no Supabase Storage (binário, sem Vercel)
       3) POST /api/admin?action=upload-confirm → valida + grava
   - Comprime imagens no cliente antes de enviar
   - Progresso real via XHR para áudio
   - Sem IndexedDB, sem Data URLs persistidas

   🔧 CORREÇÕES APLICADAS
   ------------------------------------------------------------
   1. Áudio usa presigned URL — sem limite de body da Vercel
   2. MAX_AUDIO_SIZE = 200 MB (era 4 MB)
   3. MAX_IMAGE_SIZE = 5 MB (mantido, Base64)
   4. Validação MIME por extensão (fallback)
   5. putFileXHR com progresso
   6. upload-confirm chamado automaticamente
   7. Erros detalhados com status HTTP
   8. Retorno consistente { url, path, bucket }
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────

// Imagens: Base64 (cabe no body da Vercel de 4.5 MB)
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;              // 5 MB

// Áudio: presigned (sem limite de body da Vercel)
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;            // 200 MB

// ⚠️  O limite real de áudio via Base64 era 4 MB (Vercel body = 4.5 MB).
//     Agora usamos presigned, então o céu é o limite.

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp'
]);

const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
  'audio/x-m4a',      // Safari
  'audio/aac',
  'audio/opus',
  'audio/webm',
  'audio/flac',
  'audio/x-wav'       // Windows
]);

// Extensões por fallback (quando o browser não preenche file.type)
const AUDIO_EXTENSIONS = new Set([
  'mp3', 'm4a', 'mp4', 'wav', 'ogg', 'oga', 'opus',
  'flac', 'aac', 'webm', 'aif', 'aiff'
]);

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp'
]);

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────

/**
 * Faz upload de imagem (capa, fundo, sobre, etc.).
 * Usa Base64 via API (imagens são pequenas).
 *
 * @returns {Promise<{ url: string, path: string, bucket: string }>}
 */
export async function uploadImage(file) {
  if (!file) throw new Error('Arquivo ausente.');

  if (!isValidImage(file)) {
    throw new Error('Formato de imagem não suportado (use JPG, PNG ou WebP).');
  }

  if (file.size > MAX_IMAGE_SIZE) {
    const maxMb = Math.round(MAX_IMAGE_SIZE / 1024 / 1024);
    throw new Error(`Imagem muito grande (máx ${maxMb} MB).`);
  }

  const base64 = await compressImage(file, 1920, 0.82);

  return uploadBase64(base64, file.name || 'image.jpg', 'image/jpeg', 'image');
}

/**
 * Faz upload de preview de áudio (bucket público).
 * Usa presigned upload URL.
 *
 * @returns {Promise<{ url: string, path: string, bucket: string }>}
 */
export async function uploadAudioPreview(file, onProgress) {
  return uploadAudioPresigned(file, 'audio-preview', onProgress);
}

/**
 * Faz upload de áudio completo (bucket privado).
 * Usa presigned upload URL.
 *
 * ⚠️ Retorna `url: null` — use `path` para gravar em `tracks.full_path`.
 *
 * @returns {Promise<{ url: null, path: string, bucket: string }>}
 */
export async function uploadAudioFull(file, onProgress) {
  return uploadAudioPresigned(file, 'audio-full', onProgress);
}

/**
 * Compatibilidade: `uploadAudio()` assume áudio completo.
 * @deprecated Use `uploadAudioFull()` explicitamente.
 */
export async function uploadAudio(file, onProgress) {
  return uploadAudioFull(file, onProgress);
}

// ─────────────────────────────────────────────────────────────
// Presigned upload — áudio
// ─────────────────────────────────────────────────────────────
async function uploadAudioPresigned(file, kind, onProgress) {
  if (!file) throw new Error('Arquivo ausente.');

  if (!isValidAudio(file)) {
    throw new Error('Formato de áudio não suportado. Use MP3, M4A, WAV ou OGG.');
  }

  if (file.size > MAX_AUDIO_SIZE) {
    const maxMb = Math.round(MAX_AUDIO_SIZE / 1024 / 1024);
    throw new Error(`Áudio muito grande (máx ${maxMb} MB).`);
  }

  // 1) Pede URL assinada ao backend
  const signRes = await apiFetch('upload-sign', {
    method: 'POST',
    body: {
      kind,
      filename: file.name || 'audio.mp3',
      contentType: normalizeAudioMime(file),
      size: file.size
    }
  });

  if (!signRes?.ok || !signRes.uploadUrl || !signRes.path) {
    const msg = signRes?.error || 'Falha ao preparar upload.';
    throw new Error(msg);
  }

  // 2) PUT binário direto no Supabase Storage
  await putFileXHR(
    signRes.uploadUrl,
    file,
    normalizeAudioMime(file),
    onProgress
  );

  // 3) Confirma no backend (valida que o arquivo existe no Storage)
  const confirm = await apiFetch('upload-confirm', {
    method: 'POST',
    body: {
      kind,
      path: signRes.path
    }
  });

  if (!confirm?.ok) {
    throw new Error(confirm?.error || 'Falha ao confirmar upload.');
  }

  return {
    url: confirm.url || null,
    path: confirm.path || signRes.path,
    bucket: confirm.bucket || signRes.bucket
  };
}

/**
 * PUT binário via XHR.
 * fetch() não expõe upload.onprogress — por isso XHR.
 */
function putFileXHR(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.setRequestHeader('x-upsert', 'true');

    xhr.timeout = 180_000; // 3 min

    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(xhr.responseText);
      } else {
        const body = (xhr.responseText || '').slice(0, 300);
        reject(new Error(`Upload falhou (${xhr.status}): ${body}`));
      }
    };

    xhr.onerror = () => reject(new Error('Erro de rede no upload.'));
    xhr.ontimeout = () => reject(new Error('Upload excedeu o tempo limite (3 min).'));
    xhr.onabort = () => reject(new Error('Upload cancelado.'));

    xhr.send(file);
  });
}

// ─────────────────────────────────────────────────────────────
// Upload Base64 — imagens (via API)
// ─────────────────────────────────────────────────────────────
async function uploadBase64(base64, filename, contentType, kind) {
  const result = await apiFetch('upload', {
    method: 'POST',
    body: { kind, filename, contentType, base64 }
  });

  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'Falha no upload.');
  }

  if (!result.url && !result.path) {
    throw new Error('Servidor não retornou URL nem path.');
  }

  return {
    url: result.url || null,
    path: result.path || null,
    bucket: result.bucket || null
  };
}

// ─────────────────────────────────────────────────────────────
// Bind de <input type="file">
// ------------------------------------------------------------
// `kind` aceita: 'image' | 'audio-preview' | 'audio-full'
//
// onUploaded recebe { url, path, bucket }.
// Para imagens e previews (buckets públicos), use `.url`.
// Para áudio full (bucket privado), use `.path`.
// ─────────────────────────────────────────────────────────────
export function bindUpload(inputId, onUploaded, kind = 'image') {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.dataset.bound === '1') return;
  input.dataset.bound = '1';

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    const labels = {
      'image': 'imagem',
      'audio-preview': 'prévia',
      'audio-full': 'áudio'
    };
    const label = labels[kind] || 'arquivo';

    try {
      toast(`Enviando ${label}...`, '⬆');

      let result;

      if (kind === 'image') {
        result = await uploadImage(file);
      } else if (kind === 'audio-preview') {
        result = await uploadAudioPreview(file, (pct) => {
          if (pct % 25 === 0) {
            console.debug(`[upload] ${label}: ${pct}%`);
          }
        });
      } else if (kind === 'audio-full') {
        result = await uploadAudioFull(file, (pct) => {
          if (pct % 25 === 0) {
            console.debug(`[upload] ${label}: ${pct}%`);
          }
        });
      } else {
        throw new Error(`Tipo de upload inválido: ${kind}`);
      }

      if (typeof onUploaded === 'function') {
        onUploaded(result);
      }

      toast('Upload concluído.', '✓');
    } catch (err) {
      console.error('[upload]', err);
      toast(err?.message || 'Erro no upload.', '⚠');
    } finally {
      input.value = '';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Helpers de validação
// ─────────────────────────────────────────────────────────────

/**
 * Valida imagem por MIME e extensão.
 */
function isValidImage(file) {
  if (!file) return false;

  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_IMAGE_TYPES.has(mime)) return true;

  // Fallback por extensão
  const ext = getExtension(file.name);
  return IMAGE_EXTENSIONS.has(ext);
}

/**
 * Valida áudio por MIME e extensão.
 */
function isValidAudio(file) {
  if (!file) return false;

  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_AUDIO_TYPES.has(mime)) return true;

  // Fallback por extensão (Safari/Windows às vezes não preenchem type)
  const ext = getExtension(file.name);
  return AUDIO_EXTENSIONS.has(ext);
}

/**
 * Normaliza o MIME do áudio para envio ao backend.
 * Se o browser não preencheu, infere pela extensão.
 */
function normalizeAudioMime(file) {
  const mime = String(file.type || '').toLowerCase();
  if (ALLOWED_AUDIO_TYPES.has(mime)) return mime;

  const ext = getExtension(file.name);
  const map = {
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    mp4: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    aac: 'audio/aac',
    webm: 'audio/webm',
    aif: 'audio/aiff',
    aiff: 'audio/aiff'
  };

  return map[ext] || 'audio/mpeg';
}

function getExtension(filename) {
  const s = String(filename || '');
  const dot = s.lastIndexOf('.');
  if (dot < 0) return '';
  return s.slice(dot + 1).toLowerCase();
}

// ─────────────────────────────────────────────────────────────
// Helpers de conversão (imagem)
// ─────────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error('Falha ao ler arquivo.'));
    reader.readAsDataURL(file);
  });
}

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
