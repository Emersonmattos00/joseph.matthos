/* ============================================================
   admin/users.js — v2.0 (Auditoria corrigida)
   ------------------------------------------------------------
   Correções:
   - CACHE: controla fetched (não apenas lista vazia)
   - CONCORRÊNCIA: aborta requisição anterior se houver
   - PAGINAÇÃO: preserva lista anterior durante recarga
   - ERROS: diferencia 401 (sessão) de 403 (permissão)
   - MODAL: trata fechamento externo corretamente
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';
import { esc, formatDate } from './ui/format.js';
import { openAdminModal, closeAdminModal } from './ui/modal.js';

const CACHE_TTL_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 250;
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 10;

const state = {
  all: [],
  loading: false,
  error: null,
  total: 0,
  fetchedAt: 0,
  fetched: false,          // Correção: controla se já buscou (mesmo se vazio)
  inflight: null,          // Correção: AbortController da requisição atual

  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  search: '',
  filter: 'all',
  searchDebounceId: null
};

// ─────────────────────────────────────────────────────────────
// Entrada pública
// ─────────────────────────────────────────────────────────────
export async function renderUsersTable({ force = false, resetPage = false } = {}) {
  const wrap = document.getElementById('usersTable');
  if (!wrap) return;

  if (resetPage) state.page = 1;

  const stale = Date.now() - state.fetchedAt > CACHE_TTL_MS;

  // Correção: usa `state.fetched` em vez de `!state.all.length`
  if (force || !state.fetched || stale) {
    await fetchUsers();
  }

  paint();
}

// ─────────────────────────────────────────────────────────────
// Fetch com controle de concorrência
// ─────────────────────────────────────────────────────────────
async function fetchUsers() {
  // Correção: aborta requisição anterior
  if (state.inflight) {
    try { state.inflight.abort(); } catch {}
    state.inflight = null;
  }

  const ctrl = new AbortController();
  state.inflight = ctrl;

  // Correção: mantém lista anterior visível durante recarga
  const hadData = state.all.length > 0;
  state.loading = true;
  state.error = null;
  if (!hadData) paint();

  try {
    const result = await apiFetch('users', {
      method: 'GET',
      signal: ctrl.signal
    });

    if (ctrl.signal.aborted) return;

    state.all = Array.isArray(result?.users) ? result.users : [];
    state.total = Number(result?.total) || state.all.length;
    state.fetchedAt = Date.now();
    state.fetched = true;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    if (ctrl.signal.aborted) return;

    // Correção: diferencia 401 de 403
    if (err && err.status === 401) {
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (err && err.status === 403) {
      throw new Error('Sem permissão para acessar esta área.');
    }

    state.error = err?.message || 'Falha ao carregar usuários.';
    if (!hadData) state.all = [];
  } finally {
    if (state.inflight === ctrl) {
      state.loading = false;
      state.inflight = null;
      paint();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Render principal
// ─────────────────────────────────────────────────────────────
function paint() {
  const wrap = document.getElementById('usersTable');
  if (!wrap) return;

  // Correção: preserva dados antigos durante recarga
  if (state.loading && !state.all.length) {
    wrap.innerHTML = '<p class="loading">Carregando usuários…</p>';
    updateCount(0, 0);
    return;
  }

  if (state.error && !state.all.length) {
    wrap.innerHTML = `
      <div class="error-box">
        <p>${esc(state.error)}</p>
        <button class="btn btn-outline btn-sm" id="usersRetry">
          Tentar novamente
        </button>
      </div>`;

    document.getElementById('usersRetry')?.addEventListener('click', () => {
      renderUsersTable({ force: true });
    });

    updateCount(0, 0);
    return;
  }

  // Filtragem
  const search = state.search.toLowerCase().trim();
  const filter = state.filter;

  let filtered = state.all;

  if (filter !== 'all') {
    filtered = filtered.filter((u) => u.plan === filter);
  }

  if (search) {
    filtered = filtered.filter(
      (u) =>
        (u.name || '').toLowerCase().includes(search) ||
        (u.email || '').toLowerCase().includes(search)
    );
  }

  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / state.pageSize));
  const currentPage = Math.min(Math.max(1, state.page), totalPages);
  const startIdx = (currentPage - 1) * state.pageSize;
  const endIdx = startIdx + state.pageSize;
  const pageItems = filtered.slice(startIdx, endIdx);

  state.page = currentPage;
  updateCount(totalFiltered, state.all.length);

  if (!pageItems.length) {
    wrap.innerHTML = `
      <div class="users-toolbar">${renderToolbarHTML()}</div>
      <p style="color:var(--text-dim);padding:1.5rem 1rem;text-align:center;">
        ${state.all.length ? 'Nenhum usuário corresponde ao filtro/busca.' : 'Nenhum usuário cadastrado.'}
      </p>`;
    bindToolbar();
    return;
  }

  const truncated = state.total > state.all.length;

  wrap.innerHTML = `
    <div class="users-toolbar">${renderToolbarHTML()}</div>
    ${truncated ? `<p class="hint" style="color:var(--warning,#f0a100);">Mostrando ${state.all.length} de ${state.total} usuários. Refine o filtro.</p>` : ''}

    <table class="admin-table">
      <thead>
        <tr>
          <th>Nome</th>
          <th>E-mail</th>
          <th>Plano</th>
          <th>Cadastro</th>
          <th>Ações</th>
        </tr>
      </thead>
      <tbody>
        ${pageItems.map((u) => `
          <tr>
            <td>${esc(u.name || '—')}</td>
            <td>${esc(u.email || '—')}</td>
            <td>${badgePlan(u.plan)}</td>
            <td>${formatDate(u.createdAt)}</td>
            <td>
              <div class="actions" style="display:flex;gap:0.5rem;align-items:center;">
                <button class="btn btn-ghost btn-sm" data-action="plan" data-id="${esc(u.id)}">Alterar plano</button>
                <button class="action-btn danger" data-action="delete" data-id="${esc(u.id)}" data-name="${esc(u.name || u.email)}">Anonimizar</button>
              </div>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <div class="users-pagination">${renderPaginationHTML(currentPage, totalPages, totalFiltered)}</div>
  `;

  wrap.querySelectorAll('[data-action="plan"]').forEach((btn) => {
    btn.addEventListener('click', () => openPlanModal(btn.dataset.id));
  });

  wrap.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => openDeleteModal(btn.dataset.id, btn.dataset.name));
  });

  bindToolbar();
  bindPagination(totalPages);
}

// ─────────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────────
function renderToolbarHTML() {
  const q = esc(state.search);
  const f = state.filter;

  return `
    <div class="users-toolbar__row">
      <input type="search" id="userSearch" class="shop-search" placeholder="Buscar por nome ou e-mail..." aria-label="Buscar usuários" value="${q}">
      <select id="userFilter" aria-label="Filtrar por plano">
        <option value="all" ${f === 'all' ? 'selected' : ''}>Todos</option>
        <option value="free" ${f === 'free' ? 'selected' : ''}>Free</option>
        <option value="premium" ${f === 'premium' ? 'selected' : ''}>Premium</option>
        <option value="anual" ${f === 'anual' ? 'selected' : ''}>Anual</option>
      </select>
      <select id="userPageSize" aria-label="Itens por página">
        ${PAGE_SIZE_OPTIONS.map((n) => `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n} por página</option>`).join('')}
      </select>
    </div>`;
}

function bindToolbar() {
  const searchEl = document.getElementById('userSearch');
  if (searchEl && searchEl.dataset.bound !== '1') {
    searchEl.dataset.bound = '1';
    searchEl.addEventListener('input', () => {
      if (state.searchDebounceId) clearTimeout(state.searchDebounceId);
      state.searchDebounceId = setTimeout(() => {
        state.search = searchEl.value;
        state.page = 1;
        paint();
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  const filterEl = document.getElementById('userFilter');
  if (filterEl && filterEl.dataset.bound !== '1') {
    filterEl.dataset.bound = '1';
    filterEl.addEventListener('change', () => {
      state.filter = filterEl.value || 'all';
      state.page = 1;
      paint();
    });
  }

  const sizeEl = document.getElementById('userPageSize');
  if (sizeEl && sizeEl.dataset.bound !== '1') {
    sizeEl.dataset.bound = '1';
    sizeEl.addEventListener('change', () => {
      state.pageSize = Number(sizeEl.value) || DEFAULT_PAGE_SIZE;
      state.page = 1;
      paint();
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Paginação
// ─────────────────────────────────────────────────────────────
function renderPaginationHTML(currentPage, totalPages, totalFiltered) {
  if (totalPages <= 1) {
    return `<span class="users-pagination__info">${totalFiltered} usuário${totalFiltered === 1 ? '' : 's'}</span>`;
  }

  const prevDisabled = currentPage <= 1 ? 'disabled' : '';
  const nextDisabled = currentPage >= totalPages ? 'disabled' : '';

  const windowSize = 5;
  let start = Math.max(1, currentPage - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  if (end - start + 1 < windowSize) start = Math.max(1, end - windowSize + 1);

  const buttons = [];
  for (let p = start; p <= end; p++) {
    buttons.push(`<button type="button" class="users-pagination__btn ${p === currentPage ? 'is-active' : ''}" data-page="${p}" aria-current="${p === currentPage ? 'page' : 'false'}">${p}</button>`);
  }

  return `
    <button type="button" class="users-pagination__btn" data-page="prev" ${prevDisabled} aria-label="Página anterior">‹</button>
    ${buttons.join('')}
    <button type="button" class="users-pagination__btn" data-page="next" ${nextDisabled} aria-label="Próxima página">›</button>
    <span class="users-pagination__info">${totalFiltered} usuário${totalFiltered === 1 ? '' : 's'}</span>`;
}

function bindPagination(totalPages) {
  const wrap = document.querySelector('.users-pagination');
  if (!wrap) return;

  wrap.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.page;
      if (val === 'prev') state.page = Math.max(1, state.page - 1);
      else if (val === 'next') state.page = Math.min(totalPages, state.page + 1);
      else state.page = Number(val) || 1;
      paint();
      document.getElementById('usersTable')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function updateCount(shown, total) {
  const el = document.getElementById('usersCount');
  if (el) el.textContent = `${shown} de ${total}`;
}

// ─────────────────────────────────────────────────────────────
// Modal de alteração de plano
// ─────────────────────────────────────────────────────────────
function openPlanModal(userId) {
  const user = state.all.find((u) => u.id === userId);
  if (!user) { toast('Usuário não encontrado.', '⚠'); return; }

  const planLabels = { free: 'Free', premium: 'Premium', anual: 'Anual' };

  const cleanup = () => { closeAdminModal(); };

  openAdminModal(`
    <h3>Alterar plano</h3>
    <div class="plan-change-header">
      <strong>${esc(user.name || 'Sem nome')}</strong>
      <span>${esc(user.email)}</span>
    </div>
    <div class="form-group">
      <label for="planSelect">Novo plano</label>
      <select id="planSelect">
        <option value="free" ${user.plan === 'free' ? 'selected' : ''}>Free — apenas prévias</option>
        <option value="premium" ${user.plan === 'premium' ? 'selected' : ''}>Premium — mensal</option>
        <option value="anual" ${user.plan === 'anual' ? 'selected' : ''}>Anual — assinatura anual</option>
      </select>
    </div>
    <div id="planChangePreview" class="plan-change-preview" hidden>
      <span class="plan-change-preview__label">Plano atual:</span>
      <span class="badge-mini">${esc(planLabels[user.plan] || user.plan || '—')}</span>
      <span class="plan-change-preview__arrow">→</span>
      <span class="plan-change-preview__label">Novo:</span>
      <span class="badge-mini" id="planChangePreviewNew">—</span>
    </div>
    <p class="hint" style="color:var(--text-dim);font-size:0.8rem;margin-top:0.8rem;">
      Ao mudar para <strong>Free</strong>, a assinatura ativa será cancelada.
      Ao mudar para <strong>Premium</strong> ou <strong>Anual</strong>, será criada uma assinatura manual.
    </p>
    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="planCancel" type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="planConfirm" type="button" disabled>Confirmar alteração</button>
    </div>
  `);

  const select = document.getElementById('planSelect');
  const confirmBtn = document.getElementById('planConfirm');
  const preview = document.getElementById('planChangePreview');
  const previewNew = document.getElementById('planChangePreviewNew');

  const updateConfirmState = () => {
    const newPlan = select.value;
    const changed = newPlan !== user.plan;
    confirmBtn.disabled = !changed;
    if (changed) {
      preview.hidden = false;
      previewNew.textContent = planLabels[newPlan] || newPlan;
    } else {
      preview.hidden = true;
      previewNew.textContent = '—';
    }
  };

  select.addEventListener('change', updateConfirmState);
  updateConfirmState();

  document.getElementById('planCancel')?.addEventListener('click', cleanup);

  confirmBtn.addEventListener('click', async () => {
    const newPlan = select.value;
    if (newPlan === user.plan) return;
    const proceed = await confirmPlanChange(user, newPlan);
    if (proceed) await applyPlanChange(user, newPlan);
  });
}

// ─────────────────────────────────────────────────────────────
// Confirmação final (correção: resolve mesmo se fechar externamente)
// ─────────────────────────────────────────────────────────────
function confirmPlanChange(user, newPlan) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (val) => { if (resolved) return; resolved = true; resolve(val); };

    const planLabels = { free: 'Free', premium: 'Premium', anual: 'Anual' };

    closeAdminModal();

    openAdminModal(`
      <h3>Confirmar alteração</h3>
      <p style="color:var(--text-dim);margin-bottom:1rem;">Tem certeza que deseja alterar o plano deste usuário?</p>
      <div class="plan-change-header">
        <strong>${esc(user.name || 'Sem nome')}</strong>
        <span>${esc(user.email)}</span>
      </div>
      <div class="plan-change-preview">
        <span class="plan-change-preview__label">De:</span>
        <span class="badge-mini">${esc(planLabels[user.plan] || user.plan || '—')}</span>
        <span class="plan-change-preview__arrow">→</span>
        <span class="plan-change-preview__label">Para:</span>
        <span class="badge-mini" style="background:var(--accent);color:var(--bg);">${esc(planLabels[newPlan] || newPlan)}</span>
      </div>
      <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
        <button class="btn btn-outline btn-sm" id="confirmCancel" type="button">Cancelar</button>
        <button class="btn btn-primary btn-sm" id="confirmProceed" type="button">Sim, alterar</button>
      </div>
    `);

    document.getElementById('confirmCancel')?.addEventListener('click', () => { closeAdminModal(); finish(false); });
    document.getElementById('confirmProceed')?.addEventListener('click', () => { closeAdminModal(); finish(true); });

    // Correção: se o modal for fechado por outro meio, resolve false
    const observer = new MutationObserver(() => {
      const modal = document.querySelector('.admin-modal-overlay');
      if (!modal || !modal.classList.contains('open')) {
        observer.disconnect();
        finish(false);
      }
    });
    const overlay = document.querySelector('.admin-modal-overlay');
    if (overlay) observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });
}

// ─────────────────────────────────────────────────────────────
// Aplicar alteração
// ─────────────────────────────────────────────────────────────
async function applyPlanChange(user, plan) {
  openAdminModal(`
    <h3>Alterando plano…</h3>
    <p style="color:var(--text-dim);">Aplicando <strong>${esc(plan)}</strong> para <strong>${esc(user.name || user.email)}</strong>.</p>
    <div style="margin-top:1rem;"><div class="admin-loading">Processando…</div></div>
  `);

  try {
    await apiFetch('users', { method: 'PATCH', body: { userId: user.id, plan } });
    closeAdminModal();
    toast(`Plano de ${user.name || user.email} alterado para "${plan}".`, '✓');
    await renderUsersTable({ force: true });
  } catch (err) {
    closeAdminModal();
    if (err && err.status === 401) { toast('Sessão expirada.', '⚠'); throw err; }
    if (err && err.status === 403) { toast('Sem permissão para alterar planos.', '⚠'); return; }
    toast(err?.message || 'Falha ao atualizar plano.', '⚠');
  }
}

// ─────────────────────────────────────────────────────────────
// Modal de anonimização
// ─────────────────────────────────────────────────────────────
function openDeleteModal(userId, userName) {
  openAdminModal(`
    <h3 style="color:var(--danger);">Anonimizar usuário</h3>
    <p style="color:var(--text-dim);margin-bottom:1.5rem;">
      Esta ação desativa o acesso e anonimiza os dados pessoais.
      O histórico financeiro será preservado para auditoria e obrigações legais.
      <strong>Esta ação não pode ser desfeita.</strong>
    </p>
    <div class="plan-change-header" style="border-left:3px solid var(--danger);">
      <strong>${esc(userName)}</strong>
      <span>ID: ${esc(userId)}</span>
    </div>
    <div class="form-group" style="margin-top:1.5rem;">
      <label for="deleteConfirmInput" style="color:var(--text-dim);">Digite <strong style="color:var(--danger);">ANONIMIZAR</strong> para confirmar:</label>
      <input type="text" id="deleteConfirmInput" autocomplete="off" placeholder="ANONIMIZAR">
    </div>
    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="deleteCancel" type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="deleteProceed" type="button" disabled style="background:var(--danger);color:#fff;">Anonimizar usuário</button>
    </div>
  `);

  const input = document.getElementById('deleteConfirmInput');
  const proceedBtn = document.getElementById('deleteProceed');
  const cancelBtn = document.getElementById('deleteCancel');

  input.addEventListener('input', () => {
    proceedBtn.disabled = input.value.trim().toUpperCase() !== 'ANONIMIZAR';
  });

  cancelBtn.addEventListener('click', closeAdminModal);

  proceedBtn.addEventListener('click', async () => {
    if (input.value.trim().toUpperCase() !== 'ANONIMIZAR') return;

    proceedBtn.disabled = true;
    proceedBtn.textContent = 'Anonimizando…';

    try {
      await apiFetch('users', { method: 'DELETE', query: { id: userId } });
      closeAdminModal();
      toast(`Usuário "${userName}" anonimizado.`, '🗑️');
      await renderUsersTable({ force: true });
    } catch (err) {
      closeAdminModal();
      if (err && err.status === 401) { toast('Sessão expirada.', '⚠'); throw err; }
      if (err && err.status === 403) { toast('Sem permissão para anonimizar.', '⚠'); return; }
      toast(err?.message || 'Falha ao anonimizar usuário.', '⚠');
    }
  });
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
  state.fetched = false;
}
