/* ============================================================
   js/admin/ui/modal.js — Modal compartilhado do painel admin
   ------------------------------------------------------------
   🛡️ SEGURANÇA
   ------------------------------------------------------------
   openAdminModal(html)  → sanitiza por padrão.
   openAdminModalTrusted(html) → NÃO sanitiza. Use apenas com
     HTML 100% controlado pelo sistema (sem interpolação de
     dados externos). Aceita também Node/DocumentFragment.

   Regra prática:
     - Conteúdo dinâmico (nome, email, título, etc.) → openAdminModal()
       + esc() nos valores interpolados.
     - Conteúdo estático de template → openAdminModalTrusted().

   Funcionalidades
   ------------------------------------------------------------
   - Abre/fecha o modal
   - Bind delegado de [data-close]
   - Fecha ao clicar fora (overlay)
   - Esc fecha
   - Foco automático no primeiro campo interativo
   - Guard contra DOM indisponível
   ============================================================ */

import { sanitizeHtml } from './dom.js';

// ─────────────────────────────────────────────────────────────
// Guard: DOM deve existir
// ─────────────────────────────────────────────────────────────
const HAS_DOM = typeof document !== 'undefined';

// ─────────────────────────────────────────────────────────────
// API pública — versão SEGURA (padrão)
// ─────────────────────────────────────────────────────────────

/**
 * Abre o modal com HTML SANITIZADO.
 *
 * Aceita:
 *   - string → sanitizada automaticamente
 *   - Node / DocumentFragment → inserido via replaceChildren (sem innerHTML)
 *
 * Uso recomendado:
 *   openAdminModal(`<h3>Olá, ${esc(user.name)}</h3>`)
 *
 * O html de entrada ainda passa pelo sanitizeHtml(), então tags
 * maliciosas ou atributos perigosos são removidos mesmo se o
 * caller esquecer de escapar.
 */
export function openAdminModal(input) {
  if (!HAS_DOM) return;

  const { modal, content } = getModalRefs();
  if (!modal || !content) return;

  // ── Caso 1: Node / DocumentFragment → direto (sem innerHTML)
  if (isDomNode(input)) {
    content.replaceChildren(input);
    showModal(modal);
    focusFirst(content);
    return;
  }

  // ── Caso 2: string → sanitiza antes de inserir
  if (typeof input !== 'string') {
    console.warn('[admin-modal] input inválido (nem string nem Node)');
    return;
  }

  const safeHtml = sanitizeHtml(input);
  content.innerHTML = safeHtml;
  showModal(modal);
  focusFirst(content);
}

/**
 * Abre o modal SEM sanitizar.
 *
 * ⚠️ Use APENAS com HTML 100% controlado pelo sistema.
 *    NUNCA interpole dados do usuário sem escapar.
 *
 * Aceita string, Node ou DocumentFragment.
 *
 * Uso correto:
 *   openAdminModalTrusted(`
 *     <h3>Confirmar</h3>
 *     <p>Deseja continuar?</p>
 *     <button data-close>Não</button>
 *   `)
 */
export function openAdminModalTrusted(input) {
  if (!HAS_DOM) return;

  const { modal, content } = getModalRefs();
  if (!modal || !content) return;

  if (isDomNode(input)) {
    content.replaceChildren(input);
  } else if (typeof input === 'string') {
    content.innerHTML = input;
  } else {
    console.warn('[admin-modal] input inválido (nem string nem Node)');
    return;
  }

  showModal(modal);
  focusFirst(content);
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

  // Limpa o conteúdo (evita listeners órfãos e nós residualmente focáveis)
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
  // Foco no primeiro campo interativo (a11y)
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
// Helpers para construir HTML seguro programaticamente
// ------------------------------------------------------------
// Quando o modal tem muitos dados dinâmicos, é mais seguro
// construir um <template> e substituir os nós do que concatenar
// strings. Estes helpers facilitam.
// ─────────────────────────────────────────────────────────────

/**
 * Cria um elemento DOM a partir de HTML e retorna o primeiro
 * elemento filho (útil para usar com openAdminModalTrusted).
 *
 * @param {string} html - HTML controlado pelo sistema
 * @returns {HTMLElement | null}
 */
export function htmlToElement(html) {
  if (!HAS_DOM || typeof html !== 'string') return null;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

/**
 * Cria um DocumentFragment a partir de HTML (útil para múltiplos
 * filhos). Retorna o fragment, não o primeiro elemento.
 *
 * @param {string} html - HTML controlado pelo sistema
 * @returns {DocumentFragment | null}
 */
export function htmlToFragment(html) {
  if (!HAS_DOM || typeof html !== 'string') return null;
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content;
}

// ─────────────────────────────────────────────────────────────
// Compatibilidade com onclick inline (legado)
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.closeAdminModal = closeAdminModal;
}
