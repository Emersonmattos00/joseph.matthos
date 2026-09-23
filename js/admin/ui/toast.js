/* ============================================================
   js/admin/ui/toast.js — Notificações flutuantes (admin)
   ------------------------------------------------------------
   Componente independente de toast.

   - Sem dependências externas
   - Funciona no site público E no painel admin
   - Não usa innerHTML (seguro contra XSS)
   - Acessibilidade: role="status", aria-live="polite"
   - Fila: múltiplos toasts simultâneos (max 3)
   - Tipos: success, error, warning, info, music, cart, premium
   - CSS injetado dinamicamente (namespace jm-toast*, sem
     colidir com `.toast` de css/style.css)

   ⚠️ Fallback: se `window.toast` existir (site público já
      carregou utils.js), delega para ele. Isso evita dois
      sistemas de toast concorrentes na mesma página.
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
// CONFIGURAÇÃO
// ─────────────────────────────────────────────────────────────
const TOAST_CONFIG = {
  duration: 3200,
  maxVisible: 3,
  position: 'bottom-center', // 'top-right' | 'top-center' | 'bottom-right' | 'bottom-center'
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
 */
function enforceMaxVisible() {
  while (_activeToasts.size >= TOAST_CONFIG.maxVisible) {
    const firstKey = _activeToasts.keys().next().value;
    if (firstKey) {
      dismissToast(firstKey);
    } else {
      break;
    }
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
 * @param {string} [type] - Tipo ('success', 'error', 'warning', 'info')
 * @returns {string|null} ID do toast (para dismiss manual)
 *
 * @example
 *   toast('Álbum salvo!', '💿');
 *   toast('Erro ao salvar.', '⚠', 5000);
 *   toast.success('Compra concluída!');
 *   toast.error('Falha na conexão.');
 *   toast.warning('Sessão expirando...');
 *   toast.info('Nova versão disponível.');
 */
export function toast(message, icon = 'ℹ', duration, type) {
  // Fallback: se o site público já registrou window.toast, delega
  // (evita dois sistemas de toast concorrentes na mesma página)
  if (typeof window !== 'undefined' && typeof window.toast === 'function') {
    return window.toast(message, icon);
  }

  if (message == null) {
    console.warn('[toast] Mensagem vazia ignorada');
    return null;
  }

  if (typeof document === 'undefined') {
    console.log('[toast]', message);
    return null;
  }

  const finalDuration = typeof duration === 'number' && duration > 0
    ? duration
    : TOAST_CONFIG.duration;

  // Aplica ícone padrão do tipo (se tipo passado e ícone não)
  let finalIcon = icon;
  if (type && TOAST_ICONS[type] && (icon === 'ℹ' || icon == null)) {
    finalIcon = TOAST_ICONS[type];
  }

  // Enforce limite
  enforceMaxVisible();

  // Cria ID único
  const id = 'toast-' + (++_toastIdCounter) + '-' + Date.now();

  // Cria elemento
  const el = document.createElement('div');
  el.className = 'jm-toast';
  el.id = id;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');

  if (type) {
    el.classList.add('jm-toast--' + type);
  }

  // Ícone
  const iconSpan = document.createElement('span');
  iconSpan.className = 'jm-toast__icon';
  iconSpan.setAttribute('aria-hidden', 'true');
  iconSpan.textContent = finalIcon;

  // Mensagem
  const msgSpan = document.createElement('span');
  msgSpan.className = 'jm-toast__message';
  msgSpan.textContent = String(message);

  el.appendChild(iconSpan);
  el.appendChild(msgSpan);

  // Botão de fechar
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'jm-toast__close';
  closeBtn.setAttribute('aria-label', 'Fechar notificação');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissToast(id);
  });

  el.appendChild(closeBtn);

  // Adiciona ao container
  const container = getContainer();
  container.appendChild(el);

  // Registra no mapa
  const timeoutId = setTimeout(() => {
    dismissToast(id);
  }, finalDuration);

  _activeToasts.set(id, { el, timeoutId });

  // Animação de entrada
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add('jm-toast--visible');
    });
  });

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

  // Animação de saída
  el.classList.remove('jm-toast--visible');
  el.classList.add('jm-toast--leaving');

  setTimeout(() => {
    if (el.parentNode) {
      el.parentNode.removeChild(el);
    }
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
    }

    .jm-toast__close:hover {
      color: var(--accent, #d4af37);
      opacity: 1;
    }

    .jm-toast__close:focus-visible {
      outline: 2px solid var(--accent, #d4af37);
      outline-offset: 2px;
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
      .jm-toast {
        transition: none;
        opacity: 1;
        transform: none;
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
// ------------------------------------------------------------
// ⚠️ Só registra window.toast se ainda não existir — o site
//    público (utils.js) tem prioridade.
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  if (typeof window.toast !== 'function') {
    window.toast = toast;
  }
  window.dismissToast = dismissToast;
  window.dismissAllToasts = dismissAllToasts;
}
