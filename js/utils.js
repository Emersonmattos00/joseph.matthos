/* ============================================================
   js/utils.js — Funções utilitárias compartilhadas
   ------------------------------------------------------------
   Uso:
     - Módulos ES:      import { esc, formatPrice } from './utils.js';
     - Script clássico: window.esc, window.formatPrice, ...

   Nada aqui é específico do site, do admin ou do player.
   Tudo é determinístico, sem estado global mutável,
   exceto o timer interno do `toast`.

   ⚠️ SEGURANÇA
   ------------------------------------------------------------
   - Hashing de senha NUNCA deve acontecer no cliente.
   - Login/signup usam /api/auth?action=* (scrypt no servidor).
   - Não reintroduza hashStr/verifyPassword aqui.
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// AMBIENTE
// ─────────────────────────────────────────────────────────────
export function isProductionMode() {
  if (typeof location === 'undefined') return false;
  const host = location.hostname;
  return (
    host !== 'localhost' &&
    host !== '127.0.0.1' &&
    !host.startsWith('192.168.') &&
    !host.startsWith('10.') &&
    !host.endsWith('.local')
  );
}

// ─────────────────────────────────────────────────────────────
// HTML / XSS
// ─────────────────────────────────────────────────────────────
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * Sanitiza HTML permitindo apenas um subconjunto de tags.
 * Usa DOMParser quando disponível (navegador); cai para esc() em
 * ambientes sem DOM.
 */
export function sanitizeHtml(value) {
  if (typeof DOMParser === 'undefined') return esc(value);

  const allowedTags = new Set([
    'B', 'BR', 'EM', 'I', 'P', 'SMALL', 'SPAN', 'STRONG', 'U'
  ]);

  const doc = new DOMParser().parseFromString(
    String(value == null ? '' : value),
    'text/html'
  );

  doc.body.querySelectorAll('*').forEach((node) => {
    if (!allowedTags.has(node.tagName)) {
      node.replaceWith(doc.createTextNode(node.textContent || ''));
      return;
    }
    Array.from(node.attributes).forEach((attr) => {
      // Só span.gold pode manter classe
      if (node.tagName === 'SPAN' && attr.name === 'class') {
        if (attr.value !== 'gold') node.removeAttribute('class');
        return;
      }
      node.removeAttribute(attr.name);
    });
  });

  return doc.body.innerHTML;
}

// ─────────────────────────────────────────────────────────────
// URLs
// ─────────────────────────────────────────────────────────────
export function safeExternalUrl(value) {
  if (!value) return '#';
  try {
    const url = new URL(String(value), window.location.href);

    if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
      return url.href;
    }
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && !isProductionMode()) return url.href;
  } catch {}
  return '#';
}

export function safeMediaUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  // Bloqueia esquemas perigosos
  if (/^(javascript|vbscript|file|data:text|data:application|data:image\/svg)/i.test(raw)) {
    return '';
  }

  // Aceita data:image (exceto svg) e blob:
  if (/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(raw)) return raw;
  if (/^blob:/i.test(raw)) return raw;

  try {
    const parsed = new URL(raw, window.location.href);
    if (parsed.protocol === 'https:') return raw;
    if (parsed.protocol === 'http:' && !isProductionMode()) return raw;
  } catch {}
  return '';
}

// ─────────────────────────────────────────────────────────────
// FORMATAÇÃO
// ─────────────────────────────────────────────────────────────
export function formatPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'R$ 0,00';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatCents(cents) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return 'R$ 0,00';
  return (n / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

export function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(bytes);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v >= 10 || i === 0 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

export function slugify(s) {
  const result = String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return result || 'sem-titulo';
}

// ─────────────────────────────────────────────────────────────
// ASSÍNCRONOS / TIMING
// ─────────────────────────────────────────────────────────────
export function debounce(func, wait) {
  wait = wait || 300;
  let timeout;
  return function (...args) {
    const ctx = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(ctx, args), wait);
  };
}

// ─────────────────────────────────────────────────────────────
// IDs
// ─────────────────────────────────────────────────────────────
export function generateId(prefix) {
  prefix = prefix || 'id';
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ─────────────────────────────────────────────────────────────
// CLONE PROFUNDO
// ─────────────────────────────────────────────────────────────
export function clone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {}
  }
  return JSON.parse(JSON.stringify(obj));
}

// ─────────────────────────────────────────────────────────────
// ÁUDIO
// ─────────────────────────────────────────────────────────────
export const AUDIO_EXTS = [
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'mp4', 'flac', 'aac',
  'wma', 'opus', 'webm', 'aif', 'aiff', 'amr', 'mid', 'midi', '3gp'
];

export function isAudioFile(file) {
  if (!file) return false;
  if (file.type && file.type.startsWith('audio/')) return true;
  const name = String(file.name || '');
  const ext = name.split('.').pop().toLowerCase();
  return AUDIO_EXTS.includes(ext);
}

// ─────────────────────────────────────────────────────────────
// IMAGEM — compressão via Canvas
// ─────────────────────────────────────────────────────────────
export function compressImage(file, maxWidth, quality) {
  maxWidth = maxWidth || 1920;
  quality = quality || 0.82;

  return new Promise((resolve, reject) => {
    if (!file) return reject(new Error('Arquivo ausente'));
    if (!file.type || !file.type.startsWith('image/')) {
      return reject(new Error('Arquivo não é imagem'));
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Falha ao carregar imagem'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Falha ao ler arquivo'));
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────────────────────
// LUHN (validação local — não substitui gateway)
// ─────────────────────────────────────────────────────────────
export function luhnCheck(num) {
  const digits = String(num).replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.charAt(i), 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ─────────────────────────────────────────────────────────────
// TOAST
// ------------------------------------------------------------
// Requer no DOM:
//   <div id="toast" class="toast">
//     <span class="icon" id="toastIcon">✦</span>
//     <span id="toastMsg"></span>
//   </div>
// ─────────────────────────────────────────────────────────────
let _toastTimer = null;

export function toast(msg, icon) {
  const el = document.getElementById('toast');
  if (!el) {
    console.log('[toast]', msg);
    return;
  }

  const msgEl = document.getElementById('toastMsg');
  const iconEl = document.getElementById('toastIcon');

  if (msgEl) msgEl.textContent = String(msg == null ? '' : msg);
  if (iconEl) iconEl.textContent = icon || '✦';

  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ─────────────────────────────────────────────────────────────
// COMPATIBILIDADE COM CÓDIGO LEGADO (script clássico)
// ------------------------------------------------------------
// Permite que arquivos que ainda usam `esc(...)` sem import
// continuem funcionando durante a migração para módulos ES.
//
// ⚠️ Não expõe funções de hashing/verificação de senha.
//    Autenticação é 100% server-side via /api/auth?action=*.
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.esc = esc;
  window.sanitizeHtml = sanitizeHtml;
  window.safeExternalUrl = safeExternalUrl;
  window.safeMediaUrl = safeMediaUrl;
  window.formatPrice = formatPrice;
  window.formatCents = formatCents;
  window.formatTime = formatTime;
  window.formatBytes = formatBytes;
  window.slugify = slugify;
  window.debounce = debounce;
  window.generateId = generateId;
  window.clone = clone;
  window.isAudioFile = isAudioFile;
  window.AUDIO_EXTS = AUDIO_EXTS;
  window.compressImage = compressImage;
  window.luhnCheck = luhnCheck;
  window.toast = toast;
  window.isProductionMode = isProductionMode;
}
