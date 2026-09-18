/* ============================================================
   js/admin/ui/modal.js — Modal compartilhado do painel admin
   ------------------------------------------------------------
   - openAdminModal(html): recebe HTML já sanitizado
   - closeAdminModal(): fecha o modal
   - Bind delegado de [data-close]
   - Fecha ao clicar fora (overlay)
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
 * Abre o modal do admin com o HTML fornecido.
 *
 * ⚠️ O HTML DEVE ser sanitizado antes de ser passado.
 *    Use `esc()` de ui/dom.js ou ui/format.js para conteúdo dinâmico.
 *
 * Uso correto:
 *   openAdminModal(`<h3>Olá, ${esc(user.name)}</h3>`)
 *
 * Uso ERRADO:
 *   openAdminModal(`<h3>Olá, ${user.name}</h3>`)  // ← XSS se name contém HTML
 */
export function openAdminModal(html) {
  if (!HAS_DOM) return;

  const modal = document.getElementById('adminModal');
  const content = document.getElementById('adminModalContent');
  if (!modal || !content) return;

  // Garantia mínima: se não for string, não abre
  if (typeof html !== 'string') {
    console.warn('[admin-modal] conteúdo não é string, ignorando');
    return;
  }

  content.innerHTML = html;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  // Foco no primeiro campo interativo (a11y)
  setTimeout(() => {
    const first = modal.querySelector(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])'
    );
    if (first && typeof first.focus === 'function') first.focus();
  }, 50);
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

  // Limpa o conteúdo depois de fechar (evita listeners órfãos)
  const content = document.getElementById('adminModalContent');
  if (content) content.innerHTML = '';
}

// ─────────────────────────────────────────────────────────────
// Bind único do modal container (delegação + fechar fora)
// ─────────────────────────────────────────────────────────────
if (HAS_DOM) {
  // Aguarda o DOM estar pronto
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
// Compatibilidade com onclick inline (legado)
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.closeAdminModal = closeAdminModal;
}
