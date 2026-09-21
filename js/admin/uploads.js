/* ============================================================
   js/admin/uploads.js — Upload de imagens e áudios
   ------------------------------------------------------------
   - Envia para /api/admin?action=upload
   - Backend roteia para o bucket correto conforme `kind`:
       image         → site-assets     (retorna url pública)
       audio-preview → audio-preview   (retorna url pública)
       audio-full    → audio-premium   (retorna path; url = null)
   - Comprime imagens no cliente antes de enviar
   - Valida tamanho ANTES de converter para base64
   - Sem IndexedDB, sem Data URLs persistidas
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;   // 5 MB
const MAX_AUDIO_SIZE = 4 * 1024 * 1024;   // 4 MB (limite Vercel body)

// Base64 inflaciona ~33%. Bloqueia antes de enviar.
const MAX_BASE64_LENGTH = Math.ceil(MAX_AUDIO_SIZE * 4 / 3) + 1024;

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const ALLOWED_AUDIO_TYPES = ['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg'];

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────

/**
 * Faz upload de imagem (capa, fundo, sobre, etc.).
 * @returns {Promise<{ url: string, path: string, bucket: string }>}
 */
export async function uploadImage(file) {
  if (!file) throw new Error('Arquivo ausente.');

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new Error('Formato de imagem não suportado (use JPG, PNG ou WebP).');
  }

  if (file.size > MAX_IMAGE_SIZE) {
    throw new Error('Imagem muito grande (máx 5 MB).');
  }

  const base64 = await compressImage(file, 1920, 0.82);

  if (base64.length > MAX_BASE64_LENGTH) {
    throw new Error('Imagem comprimida ainda muito grande. Reduza a resolução.');
  }

  return uploadBase64(base64, file.name || 'image.jpg', 'image/jpeg', 'image');
}

/**
 * Faz upload de preview de áudio (30s, bucket público).
 * @returns {Promise<{ url: string, path: string, bucket: string }>}
 */
export async function uploadAudioPreview(file) {
  return uploadAudioByKind(file, 'audio-preview');
}

/**
 * Faz upload de áudio completo (bucket privado).
 * ⚠️ Retorna `url: null` — use `path` para gravar em `tracks.full_path`.
 * @returns {Promise<{ url: null, path: string, bucket: string }>}
 */
export async function uploadAudioFull(file) {
  return uploadAudioByKind(file, 'audio-full');
}

/**
 * Compatibilidade: `uploadAudio()` assume áudio completo.
 * @deprecated Use `uploadAudioFull()` explicitamente.
 * @returns {Promise<{ url: null, path: string, bucket: string }>}
 */
export async function uploadAudio(file) {
  return uploadAudioFull(file);
}

// ─────────────────────────────────────────────────────────────
// Internos
// ─────────────────────────────────────────────────────────────
async function uploadAudioByKind(file, kind) {
  if (!file) throw new Error('Arquivo ausente.');

  if (!ALLOWED_AUDIO_TYPES.includes(file.type)) {
    throw new Error('Formato de áudio não suportado.');
  }

  if (file.size > MAX_AUDIO_SIZE) {
    const maxMb = Math.round(MAX_AUDIO_SIZE / 1024 / 1024);
    throw new Error(`Áudio muito grande (máx ${maxMb} MB).`);
  }

  const base64 = await fileToBase64(file);

  if (base64.length > MAX_BASE64_LENGTH) {
    throw new Error('Áudio codificado excede o limite permitido.');
  }

  return uploadBase64(base64, file.name || 'audio.mp3', file.type, kind);
}

async function uploadBase64(base64, filename, contentType, kind) {
  const result = await apiFetch('upload', {
    method: 'POST',
    body: { kind, filename, contentType, base64 }
  });

  if (!result || !result.ok) {
    throw new Error((result && result.error) || 'Falha no upload.');
  }

  // Buckets públicos retornam `url`; áudio full retorna só `path`.
  // Validação: precisa ter pelo menos um dos dois.
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
// O callback `onUploaded` recebe o objeto completo:
//   { url, path, bucket }
//
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
        result = await uploadAudioPreview(file);
      } else if (kind === 'audio-full') {
        result = await uploadAudioFull(file);
      } else {
        throw new Error(`Tipo de upload inválido: ${kind}`);
      }

      if (typeof onUploaded === 'function') {
        // Backward-compat: se o caller espera uma string (url), entrega a url.
        // Se espera o objeto, entrega o objeto inteiro.
        // Heurística: passa o objeto; callers antigos podem usar `.url`.
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
// Helpers de conversão
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
