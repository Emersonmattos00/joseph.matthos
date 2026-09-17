/* ============================================================
   admin/users.js — Lista e gestão de usuários (via API)
   ------------------------------------------------------------
   - Endpoint consolidado: /api/admin?action=users
   - Fetch único + filtragem em memória
   - Modal para alterar plano
   - Estados: carregando / vazio / erro
   - Propaga 401 para o caller
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';
import { esc, formatDate } from './ui/format.js';
import { openAdminModal, closeAdminModal } from './ui/modal.js';

const CACHE_TTL_MS = 30_000;

const state = {
  all: [],
  loading: false,
  error: null,
  total: 0,
  fetchedAt: 0
};

// ─────────────────────────────────────────────────────────────
// Entrada
// ─────────────────────────────────────────────────────────────
export async function renderUsersTable({ force = false } = {}) {
  const wrap = document.getElementById('usersTable');
  if (!wrap) return;

  const stale = Date.now() - state.fetchedAt > CACHE_TTL_MS;
  if (force || !state.all.length || stale) {
    await fetchUsers();
  }
  paint();
}

async function fetchUsers() {
  state.loading = true;
  state.error = null;
  paint();

  try {
    const result = await apiFetch('users', { method: 'GET' });
    state.all = Array.isArray(result?.users) ? result.users : [];
    state.total = Number(result?.total) || state.all.length;
    state.fetchedAt = Date.now();
  } catch (err) {
    // Sessão expirada ou sem permissão → propaga
    if (err && (err.status === 401 || err.status === 403)) {
      throw err;
    }
    state.error = err?.message || 'Falha ao carregar usuários.';
    state.all = [];
  } finally {
    state.loading = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
function paint() {
  const wrap = document.getElementById('usersTable');
  if (!wrap) return;

  if (state.loading) {
    wrap.innerHTML = '<p class="loading">Carregando usuários…</p>';
    updateCount(0, 0);
    return;
  }

  if (state.error) {
    wrap.innerHTML = `
      <div class="error-box">
        <p>${esc(state.error)}</p>
        <button class="btn btn-outline btn-sm" id="usersRetry">Tentar novamente</button>
      </div>`;
    const retry = document.getElementById('usersRetry');
    if (retry) retry.addEventListener('click', () => renderUsersTable({ force: true }));
    updateCount(0, 0);
    return;
  }

  const filter = document.getElementById('userFilter')?.value || 'all';
  const search = (document.getElementById('userSearch')?.value || '').toLowerCase().trim();

  let filtered = state.all;
  if (filter !== 'all') filtered = filtered.filter((u) => u.plan === filter);
  if (search) {
    filtered = filtered.filter(
      (u) =>
        (u.name || '').toLowerCase().includes(search) ||
        (u.email || '').toLowerCase().includes(search)
    );
  }

  updateCount(filtered.length, state.all.length);

  if (!filtered.length) {
    wrap.innerHTML =
      '<p style="color:var(--text-dim);padding:1rem;text-align:center;">' +
      (state.all.length
        ? 'Nenhum usuário corresponde ao filtro.'
        : 'Nenhum usuário cadastrado.') +
      '</p>';
    return;
  }

  const truncated = state.total > state.all.length;

  wrap.innerHTML = `
    ${
      truncated
        ? `<p class="hint" style="color:var(--warning,#f0a100);">Mostrando ${state.all.length} de ${state.total} usuários. Refine o filtro para ver mais.</p>`
        : ''
    }
    <table class="admin-table">
      <thead><tr>
        <th>Nome</th><th>E-mail</th><th>Plano</th><th>Cadastro</th><th>Ações</th>
      </tr></thead>
      <tbody>
        ${filtered
          .map(
            (u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td>${badgePlan(u.plan)}</td>
            <td>${formatDate(u.createdAt)}</td>
            <td>
              <div class="actions">
                <button class="btn btn-ghost btn-sm"
                        data-action="plan"
                        data-id="${esc(u.id)}">Plano</button>
              </div>
            </td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;

  wrap.querySelectorAll('[data-action="plan"]').forEach((btn) => {
    btn.addEventListener('click', () => openPlanModal(btn.dataset.id));
  });
}

function updateCount(shown, total) {
  const el = document.getElementById('usersCount');
  if (el) el.textContent = `${shown} de ${total}`;
}

// ─────────────────────────────────────────────────────────────
// Modal de mudança de plano
// ─────────────────────────────────────────────────────────────
function openPlanModal(userId) {
  const user = state.all.find((u) => u.id === userId);
  if (!user) {
    toast('Usuário não encontrado.', '⚠');
    return;
  }

  openAdminModal(`
    <h3>Alterar plano</h3>
    <p style="color:var(--text-dim);margin-bottom:1rem;">
      <strong>${esc(user.name || 'Sem nome')}</strong><br>
      <span style="font-size:0.85rem;">${esc(user.email)}</span>
    </p>

    <div class="form-group">
      <label for="planSelect">Plano</label>
      <select id="planSelect">
        <option value="free"    ${user.plan === 'free'    ? 'selected' : ''}>Free</option>
        <option value="premium" ${user.plan === 'premium' ? 'selected' : ''}>Premium</option>
        <option value="anual"   ${user.plan === 'anual'   ? 'selected' : ''}>Anual</option>
      </select>
    </div>

    <p class="hint" style="color:var(--text-dim);font-size:0.8rem;">
      Ao mudar para <strong>free</strong>, a assinatura ativa será cancelada.
      Ao mudar para <strong>premium</strong> ou <strong>anual</strong>, será criada uma
      assinatura manual marcada como <code>provider: manual</code>.
    </p>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="planCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="planConfirm">Confirmar</button>
    </div>
  `);

  document.getElementById('planCancel').addEventListener('click', closeAdminModal);

  document.getElementById('planConfirm').addEventListener('click', async () => {
    const select = document.getElementById('planSelect');
    const newPlan = select.value;
    if (newPlan === user.plan) {
      closeAdminModal();
      return;
    }
    await applyPlanChange(user, newPlan);
  });
}

async function applyPlanChange(user, plan) {
  const confirmBtn = document.getElementById('planConfirm');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Aplicando…';
  }

  try {
    await apiFetch('users', {
      method: 'PATCH',
      body: { userId: user.id, plan }
    });

    toast(`Plano de ${user.name || user.email} alterado para "${plan}".`, '✓');
    closeAdminModal();

    // Atualiza cache local (evita refetch)
    user.plan = plan;
    paint();
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      closeAdminModal();
      toast('Sessão expirada. Faça login novamente.', '⚠');
      throw err;
    }

    toast(err?.message || 'Falha ao atualizar plano.', '⚠');

    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Confirmar';
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Badge
// ─────────────────────────────────────────────────────────────
function badgePlan(plan) {
  if (plan === 'free') return '<span class="badge-mini badge-free">Free</span>';
  if (plan === 'premium') return '<span class="badge-mini badge-premium">Premium</span>';
  if (plan === 'anual') return '<span class="badge-mini badge-anual">Anual</span>';
  return `<span class="badge-mini">${esc(plan || '—')}</span>`;
}

// ─────────────────────────────────────────────────────────────
// Invalidação
// ─────────────────────────────────────────────────────────────
export function invalidateUsersCache() {
  state.fetchedAt = 0;
}