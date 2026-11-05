/* ============================================================
   js/admin/ui/toast.js — Notificações flutuantes (admin)
   ------------------------------------------------------------
   Componente independente de toast.

   - Sem dependências externas
   - Funciona no site público E no painel admin
   - Não usa innerHTML (seguro contra XSS)
   - Acessibilidade: role="status"/"alert", aria-live
   - Fila: múltiplos toasts simultâneos (max 3)
   - Tipos: success, error, warning, info, music, cart, premium
   - CSS injetado dinamicamente (namespace jm-toast*)

   Correções aplicadas (auditoria):
   - Remove delegação automática para window.toast (evita
     conflito com o toast público de utils.js, que depende
     de elementos #toast/#toastIcon/#toastMsg e pode falhar
     silenciosamente no painel)
   - enforceMaxVisible agora descarta o toast mais antigo
     via dismissToast (mapa é a fonte da verdade)
   - dismissToast usa el.remove() e limpa timer
   - CSS: overflow-wrap, tamanho mínimo do botão fechar,
     focus-visible e prefers-reduced-motion reforçado
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
const TOAST_CONFIG = {
  duration: 3200,
  maxVisible: 3,
  position: 'bottom-center',
  animationDuration: 300
};

// ─────────────────────────────────────────────────────────────
// ÍCONES POR TIPO
// ─────────────────────────────────────────────────────────────
const TOAST_ICONS = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
  music: '🎵',
  cart: '🛒',
  premium: '✦',
  lock: '🔒',
  download: '⬇',
  save: '💾',
  trash: '🗑',
  gear: '⚙',
  clock: '⏱'
};

const VALID_TYPES = new Set([
  'success',
  'error',
  'warning',
  'info',
  'music',
  'cart',
  'premium'
]);

// ─────────────────────────────────────────────────────────────
// ESTADO INTERNO
// ─────────────────────────────────────────────────────────────
let _container = null;
let _toastIdCounter = 0;
const _activeToasts = new Map();

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

/**
 * Cria (ou retorna) o container de toasts.
 */
function getContainer() {
  if (_container && document.body.contains(_container)) {
    return _container;
  }

  _container = document.getElementById('jmToastContainer');

  if (!_container) {
    _container = document.createElement('div');
    _container.id = 'jmToastContainer';
    _container.className = 'jm-toast-container';
    _container.setAttribute('role', 'region');
    _container.setAttribute('aria-label', 'Notificações');
    _container.dataset.position = TOAST_CONFIG.position;
    document.body.appendChild(_container);
  }

  return _container;
}

/**
 * Remove os toasts mais antigos se exceder o limite.
 * Usa dismissToast (mapa é a fonte da verdade), garantindo
 * que o timer seja limpo e o elemento saia com animação.
 */
function enforceMaxVisible() {
  while (_activeToasts.size >= TOAST_CONFIG.maxVisible) {
    const firstKey = _activeToasts.keys().next().value;

    if (!firstKey) break;

    dismissToast(firstKey);
  }
}

// ─────────────────────────────────────────────────────────────
// API PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * Exibe uma notificação flutuante.
 *
 * @param {string} message - Mensagem a exibir
 * @param {string} [icon='ℹ'] - Ícone (emoji ou caractere)
 * @param {number} [duration] - Duração em ms (padrão: 3200)
 * @param {string} [type] - Tipo ('success', 'error', 'warning', 'info', ...)
 * @returns {string|null} ID do toast (para dismiss manual)
 */
export function toast(message, icon = 'ℹ', duration, type) {
  if (message == null || String(message).trim() === '') {
    console.warn('[admin-toast] Mensagem vazia ignorada');
    return null;
  }

  if (typeof document === 'undefined') {
    console.log('[admin-toast]', message);
    return null;
  }

  const safeType = VALID_TYPES.has(type) ? type : 'info';

  const finalDuration =
    Number.isFinite(duration) && duration > 0
      ? Math.min(duration, 60000)
      : TOAST_CONFIG.duration;

  const finalIcon =
    icon == null || icon === 'ℹ'
      ? TOAST_ICONS[safeType] || 'ℹ'
      : String(icon);

  enforceMaxVisible();

  const id = `toast-${++_toastIdCounter}-${Date.now()}`;

  const el = document.createElement('div');

  el.className = 'jm-toast';
  el.id = id;

  el.classList.add(`jm-toast--${safeType}`);

  el.setAttribute(
    'role',
    safeType === 'error' ? 'alert' : 'status'
  );

  el.setAttribute(
    'aria-live',
    safeType === 'error' ? 'assertive' : 'polite'
  );

  el.setAttribute('aria-atomic', 'true');

  const iconSpan = document.createElement('span');

  iconSpan.className = 'jm-toast__icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = finalIcon;

  const msgSpan = document.createElement('span');

  msgSpan.className = 'jm-toast__message';
  msgSpan.textContent = String(message);

  const closeBtn = document.createElement('button');

  closeBtn.type = 'button';
  closeBtn.className = 'jm-toast__close';
  closeBtn.setAttribute('aria-label', 'Fechar notificação');
  closeBtn.textContent = '×';

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissToast(id);
  });

  el.append(iconSpan, msgSpan, closeBtn);

  getContainer().appendChild(el);

  const timeoutId = setTimeout(() => {
    dismissToast(id);
  }, finalDuration);

  _activeToasts.set(id, {
    el,
    timeoutId
  });

  const show = () => {
    if (!_activeToasts.has(id)) return;
    el.classList.add('jm-toast--visible');
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => {
      requestAnimationFrame(show);
    });
  } else {
    show();
  }

  return id;
}

/**
 * Remove um toast por ID.
 * @param {string} id
 */
export function dismissToast(id) {
  const entry = _activeToasts.get(id);

  if (!entry) return;

  const { el, timeoutId } = entry;

  clearTimeout(timeoutId);

  _activeToasts.delete(id);

  el.classList.remove('jm-toast--visible');
  el.classList.add('jm-toast--leaving');

  setTimeout(() => {
    el.remove();
  }, TOAST_CONFIG.animationDuration);
}

/**
 * Remove todos os toasts.
 */
export function dismissAllToasts() {
  const ids = Array.from(_activeToasts.keys());

  ids.forEach((id) => dismissToast(id));
}

// ─────────────────────────────────────────────────────────────
// ATALHOS POR TIPO
// ─────────────────────────────────────────────────────────────
toast.success = function (message, duration) {
  return toast(message, TOAST_ICONS.success, duration, 'success');
};

toast.error = function (message, duration) {
  return toast(message, TOAST_ICONS.error, duration, 'error');
};

toast.warning = function (message, duration) {
  return toast(message, TOAST_ICONS.warning, duration, 'warning');
};

toast.info = function (message, duration) {
  return toast(message, TOAST_ICONS.info, duration, 'info');
};

toast.music = function (message, duration) {
  return toast(message, TOAST_ICONS.music, duration, 'music');
};

toast.cart = function (message, duration) {
  return toast(message, TOAST_ICONS.cart, duration, 'cart');
};

toast.premium = function (message, duration) {
  return toast(message, TOAST_ICONS.premium, duration, 'premium');
};

// ─────────────────────────────────────────────────────────────
// CSS DINÂMICO (injetado uma vez)
// ─────────────────────────────────────────────────────────────
function injectToastStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('jm-toast-styles')) return;

  const style = document.createElement('style');
  style.id = 'jm-toast-styles';
  style.textContent = `
    /* Container de toasts */
    .jm-toast-container {
      position: fixed;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      pointer-events: none;
      max-width: min(92vw, 480px);
      width: max-content;
    }

    .jm-toast-container[data-position="bottom-center"] {
      bottom: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      align-items: center;
    }

    .jm-toast-container[data-position="bottom-right"] {
      bottom: 1.5rem;
      right: 1.5rem;
      align-items: flex-end;
    }

    .jm-toast-container[data-position="top-right"] {
      top: 1.5rem;
      right: 1.5rem;
      align-items: flex-end;
    }

    .jm-toast-container[data-position="top-center"] {
      top: 1.5rem;
      left: 50%;
      transform: translateX(-50%);
      align-items: center;
    }

    /* Toast individual */
    .jm-toast {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.75rem 1rem 0.75rem 1.1rem;
      background: var(--bg-elev, #131216);
      border: 1px solid var(--accent, #d4af37);
      border-radius: 40px;
      color: var(--text, #eee9e0);
      font-family: var(--font-sans, 'Inter', system-ui, sans-serif);
      font-size: 0.9rem;
      line-height: 1.4;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      opacity: 0;
      transform: translateY(20px);
      transition:
        opacity 0.3s ease,
        transform 0.3s ease;
      pointer-events: auto;
      max-width: 100%;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    .jm-toast--visible {
      opacity: 1;
      transform: translateY(0);
    }

    .jm-toast--leaving {
      opacity: 0;
      transform: translateY(10px) scale(0.95);
    }

    .jm-toast__icon {
      flex-shrink: 0;
      font-size: 1.1rem;
      color: var(--accent, #d4af37);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.2em;
    }

    .jm-toast__message {
      flex: 1;
      min-width: 0;
    }

    .jm-toast__close {
      flex-shrink: 0;
      background: none;
      border: none;
      color: var(--text-dim, #b0a9a0);
      font-size: 1.2rem;
      line-height: 1;
      cursor: pointer;
      padding: 0 0.25rem;
      margin-left: 0.25rem;
      border-radius: 50%;
      transition: color 0.2s, background 0.2s;
      opacity: 0.6;
      min-width: 32px;
      min-height: 32px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .jm-toast__close:hover {
      color: var(--accent, #d4af37);
      opacity: 1;
    }

    .jm-toast__close:focus-visible {
      outline: 2px solid var(--accent, #d4af37);
      outline-offset: 3px;
      opacity: 1;
    }

    /* Tipos */
    .jm-toast--success {
      border-color: #4ade80;
    }
    .jm-toast--success .jm-toast__icon {
      color: #4ade80;
    }

    .jm-toast--error {
      border-color: #f87171;
    }
    .jm-toast--error .jm-toast__icon {
      color: #f87171;
    }

    .jm-toast--warning {
      border-color: #fbbf24;
    }
    .jm-toast--warning .jm-toast__icon {
      color: #fbbf24;
    }

    .jm-toast--info {
      border-color: #60a5fa;
    }
    .jm-toast--info .jm-toast__icon {
      color: #60a5fa;
    }

    /* Mobile */
    @media (max-width: 600px) {
      .jm-toast-container[data-position="bottom-center"],
      .jm-toast-container[data-position="top-center"] {
        left: 1rem;
        right: 1rem;
        transform: none;
        max-width: none;
      }

      .jm-toast-container[data-position="bottom-right"],
      .jm-toast-container[data-position="top-right"] {
        left: 1rem;
        right: 1rem;
        max-width: none;
      }

      .jm-toast {
        border-radius: 12px;
        width: 100%;
      }
    }

    /* Acessibilidade */
    @media (prefers-reduced-motion: reduce) {
      .jm-toast,
      .jm-toast--visible,
      .jm-toast--leaving {
        transition: none !important;
        transform: none !important;
        opacity: 1;
      }
    }
  `;

  document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────────────
// INICIALIZAÇÃO AUTOMÁTICA
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectToastStyles);
  } else {
    injectToastStyles();
  }
}

// ─────────────────────────────────────────────────────────────
// EXPORTAÇÃO GLOBAL (compatibilidade com onclick inline)
// ─────────────────────────────────────────────────────────────
// ⚠️ Só registra window.toast se ainda não existir — o site
//    público (utils.js) tem prioridade. O módulo admin NÃO
//    delega para window.toast; usa sempre o próprio container.
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  if (typeof window.toast !== 'function') {
    window.toast = toast;
  }
  window.dismissToast = dismissToast;
  window.dismissAllToasts = dismissAllToasts;
}