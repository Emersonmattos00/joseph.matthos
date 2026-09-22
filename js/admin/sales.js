/* ============================================================
   admin/sales.js — Vendas e assinaturas (via API)
   ------------------------------------------------------------
   - Endpoint consolidado: /api/admin?action=sales
   - Usa o `summary` que o servidor já calcula
   - Filtro de período (days=7|30|90|365|all)
   - Paginação de eventos (pageSize configurável)
   - Filtro de status (todas | ativas | pendentes | canceladas)
   - try/catch com estado de erro visível
   - Aviso quando a lista pode estar truncada
   ============================================================ */

import { apiFetch } from './api.js';
import { esc, formatCents, formatDate } from './ui/format.js';

const PAGE_LIMIT = 500;
const CACHE_TTL_MS = 30_000;
const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [10, 20, 50];

const state = {
  subscriptions: [],
  rentals: [],
  payments: [],
  summary: null,
  period: 'all',
  statusFilter: 'all',       // all | authorized | pending | canceled
  pageSubs: 1,
  pageRentals: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  loading: false,
  error: null,
  fetchedAt: 0
};

// ─────────────────────────────────────────────────────────────
// Entrada
// ─────────────────────────────────────────────────────────────
export async function renderSales({ force = false, days = null } = {}) {
  const statsEl = document.getElementById('salesStats');
  const wrap = document.getElementById('salesTable');
  if (!statsEl && !wrap) return;

  const stale = Date.now() - state.fetchedAt > CACHE_TTL_MS;
  const periodChanged = days && days !== state.period;

  if (force || periodChanged || !state.fetchedAt || stale) {
    await fetchSales(days);
  }
  paint();
}

// ─────────────────────────────────────────────────────────────
// Fetch — agora com query param correto
// ─────────────────────────────────────────────────────────────
async function fetchSales(days) {
  state.loading = true;
  state.error = null;
  paint();

  try {
    const query = {};
    if (days && days !== 'all') query.days = days;

    const result = await apiFetch('sales', {
      method: 'GET',
      query
    });

    state.subscriptions = Array.isArray(result?.subscriptions) ? result.subscriptions : [];
    state.rentals = Array.isArray(result?.rentals) ? result.rentals : [];
    state.payments = Array.isArray(result?.payments) ? result.payments : [];
    state.summary = result?.summary || null;
    state.period = result?.period || (days || 'all');
    state.fetchedAt = Date.now();

    // Reseta paginação ao trocar período
    state.pageSubs = 1;
    state.pageRentals = 1;
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      throw err;
    }
    state.error = err?.message || 'Falha ao carregar vendas.';
    state.subscriptions = [];
    state.rentals = [];
    state.payments = [];
    state.summary = null;
  } finally {
    state.loading = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
function paint() {
  if (state.loading) {
    renderStats(null);
    renderTable('<p class="loading">Carregando vendas…</p>');
    return;
  }

  if (state.error) {
    renderStats(null);
    renderTable(`
      <div class="error-box">
        <p>${esc(state.error)}</p>
        <button class="btn btn-outline btn-sm" id="salesRetry">Tentar novamente</button>
      </div>`);
    const retry = document.getElementById('salesRetry');
    if (retry) retry.addEventListener('click', () => renderSales({ force: true }));
    return;
  }

  renderStats(computeStats());
  renderTable(buildTablesHtml());
}

function computeStats() {
  const s = state.summary;

  const totalSubs = s?.subscriptions?.total ?? state.subscriptions.length;
  const activeSubs =
    s?.subscriptions?.active ??
    state.subscriptions.filter((x) => x.status === 'authorized').length;

  const totalRentals = s?.rentals?.total ?? state.rentals.length;
  const rentalRevenueCents =
    s?.rentals?.revenueCents ??
    state.rentals.reduce((sum, r) => sum + normalizeCents(r), 0);

  const totalEvents = s?.payments?.total ?? state.payments.length;
  const failedEvents = s?.payments?.failed ?? 0;
  const pendingEvents = s?.payments?.pending ?? 0;

  return {
    totalSubs,
    activeSubs,
    totalRentals,
    rentalRevenueCents,
    totalEvents,
    failedEvents,
    pendingEvents
  };
}

function normalizeCents(r) {
  if (Number.isFinite(r?.amount_cents)) return r.amount_cents;
  if (Number.isFinite(r?.amount)) return Math.round(r.amount * 100);
  return 0;
}

function renderStats(stats) {
  const el = document.getElementById('salesStats');
  if (!el) return;

  if (!stats) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <div class="stat-card">
      <div class="label">Assinaturas</div>
      <div class="value">${stats.totalSubs}</div>
      <div class="hint">${stats.activeSubs} ativas</div>
    </div>
    <div class="stat-card">
      <div class="label">Aluguéis</div>
      <div class="value">${stats.totalRentals}</div>
      <div class="hint">${state.period === 'all' ? 'todos os tempos' : `últimos ${esc(state.period)}`}</div>
    </div>
    <div class="stat-card">
      <div class="label">Receita aluguéis</div>
      <div class="value">${formatCents(stats.rentalRevenueCents)}</div>
      <div class="hint">estimativa</div>
    </div>
    <div class="stat-card">
      <div class="label">Eventos de pagamento</div>
      <div class="value">${stats.totalEvents}</div>
      <div class="hint">${stats.failedEvents} falhas · ${stats.pendingEvents} pendentes</div>
    </div>
  `;
}

function renderTable(html) {
  const wrap = document.getElementById('salesTable');
  if (wrap) wrap.innerHTML = html;

  const countEl = document.getElementById('salesCount');
  if (countEl) {
    countEl.textContent = `${state.rentals.length} aluguéis`;
  }
}

// ─────────────────────────────────────────────────────────────
// Construção das tabelas com filtros + paginação
// ─────────────────────────────────────────────────────────────
function buildTablesHtml() {
  const { subscriptions, rentals } = state;
  const truncated =
    subscriptions.length >= PAGE_LIMIT ||
    rentals.length >= PAGE_LIMIT;

  if (!subscriptions.length && !rentals.length) {
    return '<p style="color:var(--text-dim);text-align:center;padding:2rem;">Nenhuma venda registrada ainda.</p>';
  }

  const warn = truncated
    ? `<p class="hint" style="color:var(--warning,#f0a100);">
         Lista limitada a ${PAGE_LIMIT} registros. Refine o período para ver mais.
       </p>`
    : '';

  // Filtro de status aplicado em assinaturas
  const filteredSubs = filterByStatus(subscriptions);
  const filteredRentals = rentals; // aluguéis não têm status, mantemos todos

  return `
    ${warn}
    ${renderSalesToolbar(filteredSubs.length, filteredRentals.length)}
    ${renderSubsSection(filteredSubs)}
    ${renderRentalsSection(filteredRentals)}
  `;
}

function filterByStatus(arr) {
  if (state.statusFilter === 'all') return arr;
  return arr.filter((x) => String(x.status || '').toLowerCase() === state.statusFilter);
}

// ─────────────────────────────────────────────────────────────
// Toolbar de vendas
// ─────────────────────────────────────────────────────────────
function renderSalesToolbar(subsCount, rentalsCount) {
  const sf = state.statusFilter;
  return `
    <div class="sales-toolbar">
      <div class="sales-toolbar__row">
        <span class="sales-toolbar__label">Período:</span>
        <select id="salesPeriod" aria-label="Período">
          <option value="all"  ${state.period === 'all'  ? 'selected' : ''}>Todos</option>
          <option value="7"    ${state.period === '7'    ? 'selected' : ''}>7 dias</option>
          <option value="30"   ${state.period === '30'   ? 'selected' : ''}>30 dias</option>
          <option value="90"   ${state.period === '90'   ? 'selected' : ''}>90 dias</option>
          <option value="365"  ${state.period === '365'  ? 'selected' : ''}>1 ano</option>
        </select>

        <span class="sales-toolbar__label">Status (assinaturas):</span>
        <select id="salesStatus" aria-label="Status">
          <option value="all"        ${sf === 'all'        ? 'selected' : ''}>Todas</option>
          <option value="authorized" ${sf === 'authorized' ? 'selected' : ''}>Ativas</option>
          <option value="pending"    ${sf === 'pending'    ? 'selected' : ''}>Pendentes</option>
          <option value="paused"     ${sf === 'paused'     ? 'selected' : ''}>Pausadas</option>
          <option value="canceled"   ${sf === 'canceled'   ? 'selected' : ''}>Canceladas</option>
        </select>

        <select id="salesPageSize" aria-label="Itens por página">
          ${PAGE_SIZE_OPTIONS.map((n) =>
            `<option value="${n}" ${state.pageSize === n ? 'selected' : ''}>${n} por página</option>`
          ).join('')}
        </select>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Seção: Assinaturas
// ─────────────────────────────────────────────────────────────
function renderSubsSection(subs) {
  if (!subs.length) return '';

  const { items, totalPages, currentPage, total } = paginate(subs, state.pageSubs, state.pageSize);
  state.pageSubs = currentPage;

  return `
    <h3 class="sales-group-title">
      Assinaturas
      <span class="hint">${total} ${total === 1 ? 'assinatura' : 'assinaturas'}</span>
    </h3>
    <table class="admin-table">
      <thead><tr>
        <th>Data</th><th>Plano</th><th>Status</th><th>Período até</th>
      </tr></thead>
      <tbody>
        ${items.map((s) => `
          <tr>
            <td>${formatDate(s.created_at || s.createdAt)}</td>
            <td>${esc(s.plan || '—')}</td>
            <td>${badgeStatus(s.status)}</td>
            <td>${formatDate(s.current_period_end)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${paginationHtml(totalPages, currentPage, total, 'subs')}
  `;
}

// ─────────────────────────────────────────────────────────────
// Seção: Aluguéis
// ─────────────────────────────────────────────────────────────
function renderRentalsSection(rentals) {
  if (!rentals.length) return '';

  const { items, totalPages, currentPage, total } = paginate(rentals, state.pageRentals, state.pageSize);
  state.pageRentals = currentPage;

  return `
    <h3 class="sales-group-title">
      Aluguéis
      <span class="hint">${total} ${total === 1 ? 'aluguel' : 'aluguéis'}</span>
    </h3>
    <table class="admin-table">
      <thead><tr>
        <th>Data</th><th>Track</th><th>Valor</th><th>Expira em</th>
      </tr></thead>
      <tbody>
        ${items.map((r) => `
          <tr>
            <td>${formatDate(r.created_at || r.createdAt)}</td>
            <td>${esc(r.track_id || '—')}</td>
            <td>${formatCents(normalizeCents(r))}</td>
            <td>${formatDate(r.expires_at)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    ${paginationHtml(totalPages, currentPage, total, 'rentals')}
  `;
}

// ─────────────────────────────────────────────────────────────
// Paginação interna
// ─────────────────────────────────────────────────────────────
function paginate(arr, page, size) {
  const total = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const start = (currentPage - 1) * size;
  const end = start + size;
  return {
    items: arr.slice(start, end),
    totalPages,
    currentPage,
    total
  };
}

function paginationHtml(totalPages, currentPage, total, kind) {
  if (totalPages <= 1) {
    return `<div class="sales-pagination sales-pagination--info">
      ${total} ${total === 1 ? 'registro' : 'registros'}
    </div>`;
  }

  const prev = currentPage <= 1 ? 'disabled' : '';
  const next = currentPage >= totalPages ? 'disabled' : '';

  // Janela de 5 páginas
  const windowSize = 5;
  let start = Math.max(1, currentPage - Math.floor(windowSize / 2));
  let end = Math.min(totalPages, start + windowSize - 1);
  if (end - start + 1 < windowSize) start = Math.max(1, end - windowSize + 1);

  const btns = [];
  for (let p = start; p <= end; p++) {
    btns.push(`
      <button type="button"
              class="sales-pagination__btn ${p === currentPage ? 'is-active' : ''}"
              data-sales-page="${p}"
              data-sales-kind="${kind}">${p}</button>
    `);
  }

  return `
    <div class="sales-pagination">
      <button type="button" class="sales-pagination__btn" data-sales-page="prev" data-sales-kind="${kind}" ${prev}>‹</button>
      ${btns.join('')}
      <button type="button" class="sales-pagination__btn" data-sales-page="next" data-sales-kind="${kind}" ${next}>›</button>
      <span class="sales-pagination__info">${total} ${total === 1 ? 'registro' : 'registros'}</span>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Binds pós-render
// ─────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const pageBtn = e.target.closest('[data-sales-page]');
  if (pageBtn) {
    const kind = pageBtn.dataset.salesKind;
    const val = pageBtn.dataset.salesPage;
    const current = kind === 'subs' ? state.pageSubs : state.pageRentals;
    const subsTotalPages = Math.max(1, Math.ceil(state.subscriptions.length / state.pageSize));
    const rentalsTotalPages = Math.max(1, Math.ceil(state.rentals.length / state.pageSize));
    const maxPages = kind === 'subs' ? subsTotalPages : rentalsTotalPages;

    let next = current;
    if (val === 'prev') next = Math.max(1, current - 1);
    else if (val === 'next') next = Math.min(maxPages, current + 1);
    else next = Number(val) || 1;

    if (kind === 'subs') state.pageSubs = next;
    else state.pageRentals = next;

    paint();
    return;
  }

  const periodEl = e.target.closest('#salesPeriod');
  // change handler (ver bindSalesToolbar abaixo)
});

// Binds dos selects (toolbar)
document.addEventListener('change', (e) => {
  if (e.target.id === 'salesPeriod') {
    const v = e.target.value;
    renderSales({ force: true, days: v === 'all' ? null : v });
    return;
  }
  if (e.target.id === 'salesStatus') {
    state.statusFilter = e.target.value || 'all';
    state.pageSubs = 1;
    paint();
    return;
  }
  if (e.target.id === 'salesPageSize') {
    state.pageSize = Number(e.target.value) || DEFAULT_PAGE_SIZE;
    state.pageSubs = 1;
    state.pageRentals = 1;
    paint();
    return;
  }
});

// ─────────────────────────────────────────────────────────────
// Badge de status
// ─────────────────────────────────────────────────────────────
function badgeStatus(status) {
  const s = String(status || '').toLowerCase();

  if (s === 'authorized' || s === 'active' || s === 'trialing') {
    return `<span class="badge-mini badge-premium">${esc(status)}</span>`;
  }
  if (s === 'pending') {
    return `<span class="badge-mini badge-pending">${esc(status)}</span>`;
  }
  if (s === 'paused') {
    return `<span class="badge-mini badge-paused">${esc(status)}</span>`;
  }
  if (s === 'canceled' || s === 'cancelled') {
    return `<span class="badge-mini badge-canceled">${esc(status)}</span>`;
  }
  return `<span class="badge-mini">${esc(status || '—')}</span>`;
}

// ─────────────────────────────────────────────────────────────
// Invalidação
// ─────────────────────────────────────────────────────────────
export function invalidateSalesCache() {
  state.fetchedAt = 0;
}
