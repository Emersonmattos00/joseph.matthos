/* ============================================================
   admin/state.js — Estado compartilhado do painel
   ------------------------------------------------------------
   Vive separado para evitar import circular entre
   index.js ↔ auth.js ↔ users.js ↔ ...
   ============================================================ */

export const AdminState = {
  content: null,
  contentVersion: 0,
  contentUpdatedAt: null,  // ← novo
  user: null,
  dirty: false
};

// ─────────────────────────────────────────────────────────────
// Mutação do estado "dirty"
// ─────────────────────────────────────────────────────────────
export function markDirty() {
  AdminState.dirty = true;
  updateSaveButtonState();
}

export function markClean() {
  AdminState.dirty = false;
  updateSaveButtonState();
}

// ─────────────────────────────────────────────────────────────
// Reset completo (usado no logout, troca de usuário)
// ─────────────────────────────────────────────────────────────
export function resetState() {
  AdminState.content = null;
  AdminState.contentVersion = 0;
  AdminState.user = null;
  AdminState.dirty = false;
  updateSaveButtonState();
}


// ─────────────────────────────────────────────────────────────
// Botão "Salvar" — sincronização visual
// ─────────────────────────────────────────────────────────────
export function updateSaveButtonState() {
  const btn = document.getElementById('adminSaveBtn');
  if (!btn) return;

  if (AdminState.dirty) {
    btn.classList.add('is-dirty');
    btn.textContent = '💾 Salvar alterações *';
  } else {
    btn.classList.remove('is-dirty');
    btn.textContent = '💾 Salvar alterações';
  }
}

// ─────────────────────────────────────────────────────────────
// Aviso ao sair com alterações não salvas
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && !window.__adminBeforeUnloadBound) {
  window.__adminBeforeUnloadBound = true;

  window.addEventListener('beforeunload', (e) => {
    if (AdminState.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}