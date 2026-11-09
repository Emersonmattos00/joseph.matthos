/* ============================================================
   js/admin/uploads.js — Upload de imagens e áudios
   (Versão Final Consolidada e Integrada)
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;              // 5 MB
const MAX_AUDIO_SIZE = 200 * 1024 * 1024;            // 200 MB

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_AUDIO_TYPES = new Set([
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/x-m4a',
  'audio/aac', 'audio/opus', 'audio/webm', 'audio/flac', 'audio/x-wav'
]);

const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'mp4', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aac', 'webm', 'aif', 'aiff']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────

export async function uploadImage(file) {
  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidImage(file)) throw new Error('Formato de imagem não suportado (use JPG, PNG ou WebP).');
  if (file.size > MAX_IMAGE_SIZE) throw new Error('Imagem muito grande (máx 5 MB).');

  const base64 = await compressImage(file, 1920, 0.82);

  // Correção da auditoria: Força a extensão para .jpg pois o canvas gera JPEG
  const filename = file.name ? file.name.replace(/\.[^.]+$/, '') : 'image';
  const finalName = `${filename}.jpg`;

  return uploadBase64(base64, finalName, 'image/jpeg', 'image');
}

export async function uploadAudioPreview(file, onProgress) {
  return uploadAudioPresigned(file, 'audio-preview', onProgress);
}

export async function uploadAudioFull(file, onProgress, extraData = {}) {
  return uploadAudioPresigned(file, 'audio-full', onProgress, extraData);
}

export async function uploadAudio(file, onProgress, extraData = {}) {
  return uploadAudioFull(file, onProgress, extraData);
}

// ─────────────────────────────────────────────────────────────
// Presigned upload — áudio
// ─────────────────────────────────────────────────────────────
async function uploadAudioPresigned(file, kind, onProgress, extraData = {}) {
  if (!file) throw new Error('Arquivo ausente.');
  if (!isValidAudio(file)) throw new Error('Formato de áudio não suportado.');
  if (file.size > MAX_AUDIO_SIZE) throw new Error(`Áudio muito grande (máx 200 MB).`);

  const contentType = normalizeAudioMime(file);

  // 1) Pede URL assinada ao backend
  const signRes = await apiFetch('upload-sign', {
    method: 'POST',
    body: {
      kind,
      filename: file.name || 'audio.mp3',
      contentType: contentType,
      size: file.size // Enviamos o tamanho para o admin.js registrar
    }
  });

  if (!signRes?.ok || !signRes.uploadUrl || !signRes.path) {
    throw new Error(signRes?.error || 'Falha ao preparar upload.');
  }

  // 2) PUT binário direto no Backblaze B2
  await putFileXHR(signRes.uploadUrl, file, contentType, onProgress);

  // 3) Confirma no backend (Passando albumId e trackIndex se existirem)
  const confirmBody = {
    kind,
    path: signRes.path,
    ...extraData
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
    track: confirm.track || null // Retorno da associação
  };
}

/**
 * PUT binário via XHR.
 */
function putFileXHR(url, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    
    // Correção da auditoria: x-upsert removido, o B2 não suporta nativamente via assinatura.
    
    // Timeout proporcional (min 1 min, max 10 min baseado em ~300KB/s)
    xhr.timeout = Math.max(60_000, Math.min(600_000, (file.size / 300) * 1000));

    if (typeof onProgress === 'function') {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.responseText);
      else reject(new Error(`Upload falhou (${xhr.status}): ${(xhr.responseText || '').slice(0, 300)}`));
    };

    xhr.onerror = () => reject(new Error('Erro de rede no upload.'));
    xhr.ontimeout = () => reject(new Error('Upload excedeu o tempo limite.'));
    xhr.onabort = () => reject(new Error('Upload cancelado.'));

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
// Bind de <input type="file">
// ─────────────────────────────────────────────────────────────
export function bindUpload(inputId, onUploaded, kind = 'image') {
  const input = document.getElementById(inputId);
  if (!input) return;
  
  // Correção da auditoria: Remove listener anterior para evitar duplicação
  if (input._uploadHandler) {
    input.removeEventListener('change', input._uploadHandler);
  }

  const handler = async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    const labels = { 'image': 'imagem', 'audio-preview': 'prévia', 'audio-full': 'áudio' };
    const label = labels[kind] || 'arquivo';

    try {
      toast(`Enviando ${label}...`, '⬆');
      let result;

      // Callback de progresso visual (opcional, caso o toast suporte)
      const updateProgress = (pct) => {
        if (pct % 25 === 0) toast(`Enviando ${label}: ${pct}%`, '⬆');
      };

      if (kind === 'image') result = await uploadImage(file);
      else if (kind === 'audio-preview') result = await uploadAudioPreview(file, updateProgress);
      else if (kind === 'audio-full') result = await uploadAudioFull(file, updateProgress);
      else throw new Error(`Tipo de upload inválido: ${kind}`);

      if (typeof onUploaded === 'function') onUploaded(result);
      toast('Upload concluído.', '✓');
    } catch (err) {
      console.error('[upload]', err);
      toast(err?.message || 'Erro no upload.', '⚠');
    } finally {
      input.value = '';
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

// ─────────────────────────────────────────────────────────────
// Helpers de conversão (imagem)
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
    // Correção da auditoria: checar se o contexto falhou
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