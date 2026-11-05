/* ============================================================
   js/admin/ui/modal.js
   Gerenciamento dos modais administrativos
   ------------------------------------------------------------
   Correções aplicadas (auditoria):
   - Sem duplicação de IDs (#adminModal / #adminModalContent)
   - role="dialog", aria-modal, aria-label e tabindex=-1
   - Foco inicial no primeiro elemento focável (sem setTimeout)
   - Focus trap com Tab/Shift+Tab
   - Esc tratado no document (funciona mesmo se o foco escapar)
   - Bloqueio da rolagem de fundo (body.style.overflow)
   - Restauração do foco ao elemento que abriu o modal
   - Conteúdo pode ser string (HTML confiável) ou Node
   ------------------------------------------------------------
   ⚠️  NÃO sanitiza HTML. O caller deve usar esc()/escAttr()
       em dados dinâmicos ou passar um Node com textContent.
   ============================================================ */

let previousFocus = null;
let previousBodyOverflow = '';
let modalOpen = false;

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

// ============================================================
// LOCALIZAÇÃO E CRIAÇÃO DO MODAL
// ------------------------------------------------------------
// Garante que #adminModal, .admin-modal e #adminModalContent
// existam exatamente uma vez, sem IDs duplicados.
// ============================================================

function ensureModalExists() {
  let modal = document.getElementById('adminModal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'adminModal';
    modal.className = 'admin-modal-overlay';
    modal.setAttribute('aria-hidden', 'true');
    document.body.appendChild(modal);
  }

  let inner = modal.querySelector('.admin-modal');

  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'admin-modal';
    modal.appendChild(inner);
  }

  let content = document.getElementById('adminModalContent');

  if (!content || !modal.contains(content)) {
    content = document.createElement('div');
    content.id = 'adminModalContent';
    inner.replaceChildren(content);
  }

  inner.setAttribute('role', 'dialog');
  inner.setAttribute('aria-modal', 'true');
  inner.setAttribute('aria-label', 'Janela administrativa');

  if (!inner.hasAttribute('tabindex')) {
    inner.setAttribute('tabindex', '-1');
  }

  bindModalEvents(modal);

  return { modal, inner, content };
}

// ============================================================
// EVENTOS DE FECHAMENTO (clique)
// ============================================================

function bindModalEvents(modal) {
  if (modal.dataset.bound === '1') return;

  modal.dataset.bound = '1';

  modal.addEventListener('click', event => {
    const closeButton = event.target.closest('[data-close]');

    if (closeButton && modal.contains(closeButton)) {
      event.preventDefault();
      closeAdminModal();
      return;
    }

    if (event.target === modal) {
      closeAdminModal();
    }
  });
}

// ============================================================
// ELEMENTOS FOCÁVEIS
// ============================================================

function getFocusableElements(container) {
  return Array.from(
    container.querySelectorAll(FOCUSABLE_SELECTOR)
  ).filter(element => {
    return (
      element.getClientRects().length > 0 &&
      element.getAttribute('aria-hidden') !== 'true'
    );
  });
}

// ============================================================
// CONTROLE DE TECLADO (Esc + focus trap)
// ------------------------------------------------------------
// Registrado no document para funcionar mesmo se o foco
// escapar do modal (ex.: por clique em elemento externo).
// ============================================================

function handleDocumentKeydown(event) {
  if (!modalOpen) return;

  const modal = document.getElementById('adminModal');

  if (!modal || !modal.classList.contains('open')) {
    return;
  }

  const dialog = modal.querySelector('.admin-modal');

  if (!dialog) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeAdminModal();
    return;
  }

  if (event.key !== 'Tab') return;

  const elements = getFocusableElements(dialog);

  if (!elements.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = elements[0];
  const last = elements[elements.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    document.activeElement === last
  ) {
    event.preventDefault();
    first.focus();
  }
}

// ============================================================
// ABERTURA
// ------------------------------------------------------------
// Aceita string (HTML confiável do sistema) ou Node.
// NÃO sanitiza. Dados externos devem chegar já escapados
// ou como Node com textContent.
// ============================================================

export function openAdminModal(input) {
  if (typeof document === 'undefined') return;

  if (
    typeof input !== 'string' &&
    (!input || typeof input.nodeType !== 'number')
  ) {
    console.error('[modal] Conteúdo inválido:', input);
    return;
  }

  const { modal, inner, content } = ensureModalExists();

  // Guarda o foco e o overflow só na primeira abertura.
  if (!modalOpen) {
    previousFocus = document.activeElement;
    previousBodyOverflow = document.body.style.overflow;

    document.addEventListener(
      'keydown',
      handleDocumentKeydown
    );
  }

  if (typeof input === 'string') {
    content.innerHTML = input;
  } else {
    content.replaceChildren(input);
  }

  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  document.body.style.overflow = 'hidden';

  modalOpen = true;

  // Foco inicial: primeiro campo focável; se não houver,
  // foca o próprio diálogo (que tem tabindex=-1).
  const first = getFocusableElements(inner)[0];

  if (first) {
    first.focus();
  } else {
    inner.focus();
  }
}

// ============================================================
// COMPATIBILIDADE
// ============================================================

export function openAdminModalTrusted(input) {
  return openAdminModal(input);
}

// ============================================================
// FECHAMENTO
// ------------------------------------------------------------
// Restaura overflow do body, remove listener de teclado e
// devolve o foco ao elemento que abriu o modal.
// ============================================================

export function closeAdminModal() {
  if (typeof document === 'undefined') return;

  const modal = document.getElementById('adminModal');

  if (!modal) return;

  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');

  const content = document.getElementById('adminModalContent');

  if (content) {
    content.replaceChildren();
  }

  document.body.style.overflow = previousBodyOverflow;

  document.removeEventListener(
    'keydown',
    handleDocumentKeydown
  );

  modalOpen = false;

  if (
    previousFocus &&
    previousFocus.isConnected &&
    typeof previousFocus.focus === 'function'
  ) {
    previousFocus.focus();
  }

  previousFocus = null;
  previousBodyOverflow = '';
}

// ============================================================
// INICIALIZAÇÃO
// ------------------------------------------------------------
// Se o #adminModal já existir no HTML, aplica bind de clique.
// Se não existir, ele será criado na primeira abertura.
// ============================================================

if (typeof document !== 'undefined') {
  const initialize = () => {
    const modal = document.getElementById('adminModal');

    if (modal) {
      bindModalEvents(modal);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }
}

// ============================================================
// API GLOBAL PARA CÓDIGO LEGADO
// ============================================================

if (typeof window !== 'undefined') {
  window.closeAdminModal = closeAdminModal;
  window.openAdminModal = openAdminModal;
}