/* ============================================================
   admin/state.js — Estado compartilhado do painel
   ------------------------------------------------------------
   Vive separado para evitar import circular entre
   index.js ↔ auth.js ↔ users.js ↔ ...

   ⚠️  Este objeto só deve conter estado que CRUZA fronteiras.

   ❌ NÃO adicionar aqui:
      - albums, tracks (cada editor mantém o seu)
      - users, sales, audit (cada tabela mantém o seu)
      - loading, error (cada módulo tem o seu ciclo)

   ✅ Adicionar aqui quando:
      - 2+ módulos precisam ler o mesmo dado
      - 2+ módulos precisam escrever no mesmo dado
      - A mudança precisa notificar "fora" do módulo
        (beforeunload, botão salvar global, etc)

   Estado:
     - content           → conteúdo atual em memória
     - contentVersion    → versão (controle otimista)
     - contentUpdatedAt  → timestamp do último save
     - user              → admin logado
     - dirty             → alterações não salvas
     - busy              → operação em andamento (upload/import/save)

   ⚠️  O aviso `beforeunload` dispara se `dirty` OU `busy` estiver ativo.
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
// PUB/SUB — notificação de mudanças
// ------------------------------------------------------------
// Módulos podem se inscrever para reagir a mudanças de estado
// sem que o state.js precise conhecer cada um deles.
//
// Uso:
//   const off = subscribe((event, payload) => {
//     if (event === 'dirty') console.log('alterações pendentes');
//   });
//   // ... mais tarde
//   off();  // unsubscribe
//
// Eventos emitidos:
//   - 'dirty'    → markDirty() foi chamado
//   - 'clean'    → markClean() foi chamado
//   - 'busy'     → beginBusy() foi chamado
//   - 'idle'     → endBusy() foi chamado
// ─────────────────────────────────────────────────────────────
const _listeners = new Set();

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

function notify(event, payload) {
  for (const fn of _listeners) {
    try {
      fn(event, payload);
    } catch (err) {
      console.warn('[state] listener falhou:', err);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Mutação do estado "dirty"
// ─────────────────────────────────────────────────────────────
export function markDirty() {
  AdminState.dirty = true;
  updateSaveButtonState();
  notify('dirty');
}

export function markClean() {
  AdminState.dirty = false;
  updateSaveButtonState();
  notify('clean');
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
  notify('busy', { label });
}

export function endBusy() {
  AdminState.busy = false;
  AdminState.busyLabel = null;
  updateSaveButtonState();
  notify('idle');
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
  notify('clean');
  notify('idle');
}

// ─────────────────────────────────────────────────────────────
// Snapshot imutável (opcional — para debug e logs)
// ------------------------------------------------------------
// Retorna uma cópia rasa. Útil para console.log e para
// expor via window.__admin.state.
// ─────────────────────────────────────────────────────────────
export function getSnapshot() {
  return {
    contentVersion: AdminState.contentVersion,
    contentUpdatedAt: AdminState.contentUpdatedAt,
    user: AdminState.user,
    dirty: AdminState.dirty,
    busy: AdminState.busy,
    busyLabel: AdminState.busyLabel
  };
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
