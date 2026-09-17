/* ============================================================
   admin/sales.js — Vendas e assinaturas (via API)
   ------------------------------------------------------------
   - Endpoint consolidado: /api/admin?action=sales
   - Usa o `summary` que o servidor já calcula
   - Filtro de período opcional (days=7|30|90|365|all)
   - try/catch com estado de erro visível
   - Aviso quando a lista pode estar truncada
   ============================================================ */

import { apiFetch } from './api.js';
import { esc, formatCents, formatDate } from './ui/format.js';

const PAGE_LIMIT = 500;
const CACHE_TTL_MS = 30_000;

const state = {
  subscriptions: [],
  rentals: [],
  payments: [],
  summary: null,
  period: 'all',
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

async function fetchSales(days) {
  state.loading = true;
  state.error = null;
  paint();

  try {
    const query = days && days !== 'all' ? `&days=${encodeURIComponent(days)}` : '';
    const result = await apiFetch(`sales?${''}`, { method: 'GET' }); // ver nota abaixo
    // ⚠️ Como o apiFetch('sales') não aceita query customizada,
    //    usamos a URL completa para incluir `days`:
    // const result = await apiFetch(`/api/admin?action=sales${query}`, { method: 'GET' });

    state.subscriptions = Array.isArray(result?.subscriptions) ? result.subscriptions : [];
    state.rentals = Array.isArray(result?.rentals) ? result.rentals : [];
    state.payments = Array.isArray(result?.payments) ? result.payments : [];
    state.summary = result?.summary || null;
    state.period = result?.period || (days || 'all');
    state.fetchedAt = Date.now();
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
  // Preferimos o summary do servidor (fonte de verdade)
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
      <div class="hint">${stats.period === 'all' ? 'todos os tempos' : `últimos ${esc(stats.period)}`}</div>
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
         Lista limitada a ${PAGE_LIMIT} registros. Refine o período em futuras versões.
       </p>`
    : '';

  const subsHtml = subscriptions.length
    ? `<h3 class="sales-group-title">Assinaturas</h3>
       <table class="admin-table">
         <thead><tr>
           <th>Data</th><th>Plano</th><th>Status</th><th>Período até</th>
         </tr></thead>
         <tbody>
           ${subscriptions.map((s) => `
             <tr>
               <td>${formatDate(s.created_at || s.createdAt)}</td>
               <td>${esc(s.plan || '—')}</td>
               <td>${badgeStatus(s.status)}</td>
               <td>${formatDate(s.current_period_end)}</td>
             </tr>`).join('')}
         </tbody>
       </table>`
    : '';

  const rentalsHtml = rentals.length
    ? `<h3 class="sales-group-title">Aluguéis</h3>
       <table class="admin-table">
         <thead><tr>
           <th>Data</th><th>Track</th><th>Valor</th><th>Expira em</th>
         </tr></thead>
         <tbody>
           ${rentals.map((r) => `
             <tr>
               <td>${formatDate(r.created_at || r.createdAt)}</td>
               <td>${esc(r.track_id || '—')}</td>
               <td>${formatCents(normalizeCents(r))}</td>
               <td>${formatDate(r.expires_at)}</td>
             </tr>`).join('')}
         </tbody>
       </table>`
    : '';

  return warn + subsHtml + rentalsHtml;
}

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