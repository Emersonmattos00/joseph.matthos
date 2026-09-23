/* ============================================================
   js/admin/ui/modal.js — Modal compartilhado do painel admin
   ------------------------------------------------------------
   🛡️ SEGURANÇA
   ------------------------------------------------------------
   Este módulo é usado SOMENTE no painel admin (usuário já
   autenticado via HMAC + cookie __Host-jm_admin).

   Diferente do `sanitizeHtml` de `dom.js` (usado para conteúdo
   de USUÁRIO como hero.title), o `openAdminModal` aqui aceita
   HTML CONTROLADO PELO SISTEMA — formulários, botões, inputs,
   divs, etc.

   Se o caller interpolar dados do usuário (nome, email), DEVE
   usar `esc()` do `dom.js` em cada valor.

   🔧 CORREÇÃO APLICADA
   ------------------------------------------------------------
   Antes, openAdminModal() chamava sanitizeHtml() que só
   permitia b/i/em/strong/br/span/p/a — transformando o HTML
   dos modais (formulários) em texto puro. Agora ele insere
   o HTML diretamente (comportamento de openAdminModalTrusted).

   Funcionalidades
   ------------------------------------------------------------
   - Abre/fecha o modal
   - Bind delegado de [data-close]
   - Fecha ao clicar fora (overlay)
   - Esc fecha
   - Foco automático no primeiro campo interativo
   - Guard contra DOM indisponível
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// Guard: DOM deve existir
// ─────────────────────────────────────────────────────────────
const HAS_DOM = typeof document !== 'undefined';

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────

/**
 * Abre o modal com HTML do sistema.
 *
 * Aceita string, Node ou DocumentFragment.
 *
 * ⚠️  NÃO sanitiza — o caller é responsável por escapar dados
 *     dinâmicos com `esc()` de `./dom.js`.
 *
 * @param {string | Node | DocumentFragment} input
 */
export function openAdminModal(input) {
  if (!HAS_DOM) return;

  const { modal, content } = getModalRefs();
  if (!modal || !content) {
    console.warn('[admin-modal] #adminModal ou #adminModalContent não encontrado');
    return;
  }

  // ── Node / DocumentFragment → direto
  if (isDomNode(input)) {
    content.replaceChildren(input);
    showModal(modal);
    focusFirst(content);
    return;
  }

  // ── String → injeta como HTML
  if (typeof input !== 'string') {
    console.warn('[admin-modal] input inválido (nem string nem Node)');
    return;
  }

  content.innerHTML = input;
  showModal(modal);
  focusFirst(content);
}

/**
 * Alias para openAdminModal (compatibilidade).
 * Antes era a versão "trusted", agora todas são iguais.
 */
export function openAdminModalTrusted(input) {
  return openAdminModal(input);
}

/**
 * Fecha o modal do admin.
 */
export function closeAdminModal() {
  if (!HAS_DOM) return;

  const modal = document.getElementById('adminModal');
  if (!modal) return;

  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');

  const content = document.getElementById('adminModalContent');
  if (content) {
    content.replaceChildren();
  }
}

// ─────────────────────────────────────────────────────────────
// Internos
// ─────────────────────────────────────────────────────────────

function getModalRefs() {
  return {
    modal: document.getElementById('adminModal'),
    content: document.getElementById('adminModalContent')
  };
}

function isDomNode(x) {
  if (!HAS_DOM || !x) return false;
  return (
    x instanceof Node ||
    (typeof x === 'object' && typeof x.nodeType === 'number')
  );
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
      'button:not([disabled]), ' +
      'a[href]'
    );
    if (first && typeof first.focus === 'function') first.focus();
  }, 50);
}

// ─────────────────────────────────────────────────────────────
// Bind único do modal container (delegação + fechar fora)
// ─────────────────────────────────────────────────────────────
if (HAS_DOM) {
  const initModalBindings = () => {
    const modal = document.getElementById('adminModal');
    if (!modal) return;
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';

    // 1) Delegado: clique em [data-close] fecha
    modal.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn && modal.contains(closeBtn)) {
        e.preventDefault();
        closeAdminModal();
        return;
      }
    });

    // 2) Clique no overlay (fora do .admin-modal) fecha
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeAdminModal();
      }
    });

    // 3) Esc fecha (se o foco estiver dentro do modal)
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

// ─────────────────────────────────────────────────────────────
// Compatibilidade
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.closeAdminModal = closeAdminModal;
}
