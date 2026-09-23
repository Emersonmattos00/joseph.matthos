/* ============================================================
   js/admin/ui/modal.js — Modal compartilhado do painel admin
   ------------------------------------------------------------
   ⚠️  NÃO sanitiza o HTML — o caller é responsável por escapar
       dados dinâmicos com esc() de ./dom.js.
   ============================================================ */

const HAS_DOM = typeof document !== 'undefined';

export function openAdminModal(input) {
  if (!HAS_DOM) return;

  const { modal, content } = getModalRefs();
  if (!modal || !content) {
    console.warn('[admin-modal] #adminModal ou #adminModalContent não encontrado');
    return;
  }

  if (isDomNode(input)) {
    content.replaceChildren(input);
    showModal(modal);
    focusFirst(content);
    return;
  }

  if (typeof input !== 'string') {
    console.warn('[admin-modal] input inválido');
    return;
  }

  content.innerHTML = input;
  showModal(modal);
  focusFirst(content);
}

export function openAdminModalTrusted(input) {
  return openAdminModal(input);
}

export function closeAdminModal() {
  if (!HAS_DOM) return;

  const modal = document.getElementById('adminModal');
  if (!modal) return;

  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');

  const content = document.getElementById('adminModalContent');
  if (content) content.replaceChildren();
}

function getModalRefs() {
  return {
    modal: document.getElementById('adminModal'),
    content: document.getElementById('adminModalContent')
  };
}

function isDomNode(x) {
  if (!HAS_DOM || !x) return false;
  return x instanceof Node || (typeof x === 'object' && typeof x.nodeType === 'number');
}

function showModal(modal) {
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
}

function focusFirst(content) {
  setTimeout(() => {
    const first = content.querySelector(
      'input:not([type="hidden"]):not([disabled]), ' +
      'textarea:not([disabled]), ' +
      'select:not([disabled]), ' +
      'button:not([disabled]), a[href]'
    );
    if (first && typeof first.focus === 'function') first.focus();
  }, 50);
}

if (HAS_DOM) {
  const initModalBindings = () => {
    const modal = document.getElementById('adminModal');
    if (!modal) return;
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';

    modal.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn && modal.contains(closeBtn)) {
        e.preventDefault();
        closeAdminModal();
        return;
      }
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeAdminModal();
    });

    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAdminModal();
      }
    });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModalBindings);
  } else {
    initModalBindings();
  }
}

if (typeof window !== 'undefined') {
  window.closeAdminModal = closeAdminModal;
}
