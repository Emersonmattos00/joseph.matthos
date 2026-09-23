/* ============================================================
   js/admin/ui/modal.js — v3 (autossuficiente + diagnóstico)
   ------------------------------------------------------------
   - Abre o modal com HTML do sistema (NÃO sanitiza)
   - Cria o #adminModal dinamicamente se não existir no DOM
     (fallback para quando o index.html é servido de cache antigo)
   - Bind de fechamento: [data-close], clique fora, Esc
   - Foco automático no primeiro campo
   - Logs de diagnóstico

   ⚠️  NÃO sanitiza — o caller deve usar esc() em dados dinâmicos.
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// Referências e criação dinâmica
// ─────────────────────────────────────────────────────────────

function ensureModalExists() {
  let modal = document.getElementById('adminModal');
  let content = document.getElementById('adminModalContent');

  if (modal && content) {
    return { modal, content };
  }

  console.warn('[modal] #adminModal ausente — criando dinamicamente');

  modal = document.createElement('div');
  modal.id = 'adminModal';
  modal.className = 'admin-modal-overlay';
  modal.setAttribute('aria-hidden', 'true');

  const inner = document.createElement('div');
  inner.className = 'admin-modal';

  content = document.createElement('div');
  content.id = 'adminModalContent';

  inner.appendChild(content);
  modal.appendChild(inner);
  document.body.appendChild(modal);

  // Bind de fechamento (uma vez só, na criação)
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      e.preventDefault();
      closeAdminModal();
      return;
    }
    if (e.target === modal) closeAdminModal();
  });

  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAdminModal();
    }
  });

  console.log('[modal] #adminModal criado dinamicamente');
  return { modal, content };
}

// ─────────────────────────────────────────────────────────────
// API pública
// ─────────────────────────────────────────────────────────────

/**
 * Abre o modal do admin.
 *
 * Aceita string (HTML controlado pelo sistema) ou Node.
 * NÃO sanitiza.
 *
 * @param {string | Node | DocumentFragment} input
 */
export function openAdminModal(input) {
  if (typeof document === 'undefined') return;

  const { modal, content } = ensureModalExists();

  if (!modal || !content) {
    console.error('[modal] falha ao obter/criar #adminModal');
    return;
  }

  // ── Node / DocumentFragment
  if (input instanceof Node) {
    content.replaceChildren(input);
  }
  // ── String (HTML)
  else if (typeof input === 'string') {
    content.innerHTML = input;
  }
  // ── Inválido
  else {
    console.error('[modal] input inválido:', input);
    return;
  }

  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  const len = content.innerHTML.length;
  console.log('[modal] aberto com', len, 'bytes de HTML');

  // Foco no primeiro campo interativo
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

/**
 * Alias de compatibilidade.
 */
export function openAdminModalTrusted(input) {
  return openAdminModal(input);
}

/**
 * Fecha o modal.
 */
export function closeAdminModal() {
  if (typeof document === 'undefined') return;

  const modal = document.getElementById('adminModal');
  if (!modal) return;

  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');

  const content = document.getElementById('adminModalContent');
  if (content) content.replaceChildren();
}

// ─────────────────────────────────────────────────────────────
// Bind inicial (caso o modal já exista no HTML)
// ─────────────────────────────────────────────────────────────

if (typeof document !== 'undefined') {
  const initBindings = () => {
    const modal = document.getElementById('adminModal');
    if (!modal) return;
    if (modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';

    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        e.preventDefault();
        closeAdminModal();
        return;
      }
      if (e.target === modal) closeAdminModal();
    });

    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeAdminModal();
      }
    });

    console.log('[modal] bind inicial aplicado');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBindings);
  } else {
    initBindings();
  }
}

// ─────────────────────────────────────────────────────────────
// Expor no window (compatibilidade com código legado)
// ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.closeAdminModal = closeAdminModal;
  window.openAdminModal = openAdminModal;
}
