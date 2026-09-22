/* ============================================================
   admin/state.js — Estado compartilhado do painel
   ------------------------------------------------------------
   Vive separado para evitar import circular entre
   index.js ↔ auth.js ↔ users.js ↔ ...
   ------------------------------------------------------------
   Estado:
     - content           → conteúdo atual em memória
     - contentVersion    → versão (controle otimista)
     - contentUpdatedAt  → timestamp do último save
     - user              → admin logado
     - dirty             → alterações não salvas
     - busy              → operação em andamento (upload/import/save)
   ------------------------------------------------------------
   ⚠️ O aviso `beforeunload` dispara se `dirty` OU `busy` estiver ativo.
   ============================================================ */

export const AdminState = {
  content: null,
  contentVersion: 0,
  contentUpdatedAt: null,
  user: null,
  dirty: false,
  busy: false
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
// Mutação do estado "busy"
// ------------------------------------------------------------
// Uso:
//   beginBusy('upload')  → AdminState.busy = true, label = 'upload'
//   endBusy()            → AdminState.busy = false
// ------------------------------------------------------------
export function beginBusy(label = 'operação') {
  AdminState.busy = true;
  AdminState.busyLabel = label;
  updateSaveButtonState();
}

export function endBusy() {
  AdminState.busy = false;
  AdminState.busyLabel = null;
  updateSaveButtonState();
}

export function isBusy() {
  return AdminState.busy === true;
}

// ─────────────────────────────────────────────────────────────
// Reset completo (usado no logout, troca de usuário)
// ─────────────────────────────────────────────────────────────
export function resetState() {
  AdminState.content = null;
  AdminState.contentVersion = 0;
  AdminState.contentUpdatedAt = null;
  AdminState.user = null;
  AdminState.dirty = false;
  AdminState.busy = false;
  AdminState.busyLabel = null;
  updateSaveButtonState();
}

// ─────────────────────────────────────────────────────────────
// Botão "Salvar" — sincronização visual
// ------------------------------------------------------------
// Prioridades:
//   1) busy     → "⏳ <label>..." + disabled
//   2) dirty    → "💾 Salvar alterações *" + is-dirty
//   3) clean    → "💾 Salvar alterações"
// ─────────────────────────────────────────────────────────────
export function updateSaveButtonState() {
  const btn = document.getElementById('adminSaveBtn');
  if (!btn) return;

  // 1) Operação em andamento (upload/import/save)
  if (AdminState.busy) {
    const label = AdminState.busyLabel || 'processando';
    btn.disabled = true;
    btn.classList.remove('is-dirty');
    btn.classList.add('is-busy');
    btn.textContent = `⏳ ${capitalize(label)}...`;
    return;
  }

  // 2) Alterações pendentes
  if (AdminState.dirty) {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    btn.classList.add('is-dirty');
    btn.textContent = '💾 Salvar alterações *';
    return;
  }

  // 3) Estado limpo
  btn.disabled = false;
  btn.classList.remove('is-dirty', 'is-busy');
  btn.textContent = '💾 Salvar alterações';
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─────────────────────────────────────────────────────────────
// Aviso ao sair com alterações não salvas OU operação em andamento
// ------------------------------------------------------------
// Dispara se:
//   - `dirty` = true  (alterações não salvas)
//   - `busy` = true   (upload/import/save em andamento)
// ─────────────────────────────────────────────────────────────
if (typeof window !== 'undefined' && !window.__adminBeforeUnloadBound) {
  window.__adminBeforeUnloadBound = true;

  window.addEventListener('beforeunload', (e) => {
    if (AdminState.dirty || AdminState.busy) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
}
