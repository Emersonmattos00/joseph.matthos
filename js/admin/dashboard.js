/* ============================================================
   admin/dashboard.js — Cards de estatísticas do painel
   ------------------------------------------------------------
   Correções aplicadas (auditoria):
   - Aceita o contrato real da API (sales: [...])
   - Não inventa indicadores de assinaturas/aluguéis
   - Retry sem depender de :last-of-type
   - Sessão expirada detectada com 1 painel (não os 2)
   - Normalização de plano (lowercase/trim)
   ============================================================ */

import { apiFetch } from './api.js';
import { esc, formatCents, formatDate } from './ui/format.js';

const DashState = {
  users: {
    status: 'idle',
    data: [],
    error: null
  },
  sales: {
    status: 'idle',
    data: { orders: [] },
    error: null
  }
};

// ─────────────────────────────────────────────────────────────
// Entrada pública
// ─────────────────────────────────────────────────────────────
export async function renderDashboard() {
  paintUsersLoading();
  paintSalesLoading();

  await Promise.allSettled([fetchUsers(), fetchSales()]);

  // Se qualquer painel falhou com 401/403, propaga
  const authError =
    [DashState.users.error, DashState.sales.error]
      .find(err => err?.status === 401 || err?.status === 403);

  if (authError) throw authError;
}

// ─────────────────────────────────────────────────────────────
// Fetch — USERS
// ─────────────────────────────────────────────────────────────
async function fetchUsers() {
  DashState.users.status = 'loading';
  DashState.users.error = null;

  try {
    const res = await apiFetch('users', { method: 'GET' });
    const users = Array.isArray(res?.users) ? res.users : [];

    DashState.users.data = users;
    DashState.users.status = 'ready';

    paintUsersReady();
    paintRecent(users);
  } catch (err) {
    console.error('[dashboard] users:', err);
    DashState.users.status = 'error';
    DashState.users.error = err;

    if (err?.status === 401 || err?.status === 403) throw err;
    paintUsersError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch — SALES (contrato real: sales: [...])
// ─────────────────────────────────────────────────────────────
async function fetchSales() {
  DashState.sales.status = 'loading';
  DashState.sales.error = null;

  try {
    const res = await apiFetch('sales', { method: 'GET' });

    if (res?.ok !== true || !Array.isArray(res.sales)) {
      throw new Error('O servidor retornou uma lista de vendas inválida.');
    }

    DashState.sales.data = { orders: res.sales };
    DashState.sales.status = 'ready';

    paintSalesReady();
  } catch (err) {
    console.error('[dashboard] sales:', err);
    DashState.sales.status = 'error';
    DashState.sales.error = err;

    if (err?.status === 401 || err?.status === 403) throw err;
    paintSalesError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Retry
// ─────────────────────────────────────────────────────────────
export async function retryUsers() {
  try { await fetchUsers(); }
  catch (err) {
    if (err?.status === 401 || err?.status === 403) throw err;
  }
}

export async function retrySales() {
  try { await fetchSales(); }
  catch (err) {
    if (err?.status === 401 || err?.status === 403) throw err;
  }
}

if (typeof window !== 'undefined') {
  window.__dashboardRetryUsers = () => {
    retryUsers().catch(e => console.warn('[dashboard] retryUsers:', e));
  };
  window.__dashboardRetrySales = () => {
    retrySales().catch(e => console.warn('[dashboard] retrySales:', e));
  };
}

// ─────────────────────────────────────────────────────────────
// Pintura — USERS
// ─────────────────────────────────────────────────────────────
function paintUsersLoading() {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  if (!el.querySelector('.stat-card[data-panel="sales"]')) {
    el.innerHTML = `
      <div class="stat-card" data-panel="users">
        <div class="label">Usuários</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
      <div class="stat-card" data-panel="sales">
        <div class="label">Pedidos consultados</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
      <div class="stat-card" data-panel="sales">
        <div class="label">Pedidos pagos</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
      <div class="stat-card" data-panel="sales">
        <div class="label">Receita dos pedidos pagos</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
    `;
  } else {
    const card = el.querySelector('.stat-card[data-panel="users"]');
    if (card) {
      card.innerHTML = `
        <div class="label">Usuários</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      `;
    }
  }
}

function paintUsersReady() {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  const users = DashState.users.data;

  // ★ Normalização de plano (case-insensitive + trim)
  const premium = users.filter(user => {
    const plan = String(user.plan || '').trim().toLowerCase();
    return ['premium', 'anual'].includes(plan);
  }).length;

  const free = Math.max(0, users.length - premium);

  const card = el.querySelector('.stat-card[data-panel="users"]');
  if (card) {
    card.innerHTML = `
      <div class="label">Usuários</div>
      <div class="value">${users.length}</div>
      <div class="hint">${free} free · ${premium} premium</div>
    `;
  }
}

function paintUsersError(err) {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  const msg = friendlyError(err, 'usuários');
  const card = el.querySelector('.stat-card[data-panel="users"]');
  if (card) {
    card.classList.add('is-error');
    card.innerHTML = `
      <div class="label">Usuários</div>
      <div class="value" style="color:var(--danger);font-size:1rem;">⚠</div>
      <div class="hint" style="color:var(--danger);">
        ${esc(msg)}
        <button type="button" class="btn-retry" onclick="window.__dashboardRetryUsers()">
          Tentar novamente
        </button>
      </div>
    `;
  }
}

// ─────────────────────────────────────────────────────────────
// Pintura — SALES (baseado em `orders`)
// ─────────────────────────────────────────────────────────────
function paintSalesLoading() {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  el.querySelectorAll('.stat-card[data-panel="sales"]').forEach(card => {
    card.classList.remove('is-error');
    const hint = card.querySelector('.hint');
    if (hint && !hint.classList.contains('loading-hint')) {
      hint.textContent = 'Carregando…';
      hint.classList.add('loading-hint');
      hint.style.color = '';
    }
  });
}

function paintSalesReady() {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  const orders = DashState.sales.data.orders || [];
  const paidOrders = orders.filter(o => o.status === 'PAID');

  const paidRevenueCents = paidOrders.reduce((total, order) => {
    const amount = Number(order.totalCents);
    return Number.isSafeInteger(amount) && amount >= 0 ? total + amount : total;
  }, 0);

  const cards = el.querySelectorAll('.stat-card[data-panel="sales"]');
  if (cards.length < 3) {
    console.error('[dashboard] Cards de vendas não encontrados.');
    return;
  }

  const cardData = [
    { label: 'Pedidos consultados', value: orders.length, hint: 'amostra de até 50 pedidos' },
    { label: 'Pedidos pagos', value: paidOrders.length, hint: 'dentro dos pedidos consultados' },
    { label: 'Receita dos pedidos pagos', value: formatCents(paidRevenueCents), hint: 'amostra de até 50 pedidos' }
  ];

  cards.forEach((card, index) => {
    const item = cardData[index];
    card.classList.remove('is-error');
    card.innerHTML = `
      <div class="label">${esc(item.label)}</div>
      <div class="value">${esc(item.value)}</div>
      <div class="hint">${esc(item.hint)}</div>
    `;
  });
}

function paintSalesError(err) {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  const msg = friendlyError(err, 'vendas');
  const cards = el.querySelectorAll('.stat-card[data-panel="sales"]');

  cards.forEach(card => {
    const label = card.querySelector('.label')?.textContent || 'Vendas';
    card.classList.add('is-error');
    card.innerHTML = `
      <div class="label">${esc(label)}</div>
      <div class="value" style="color:var(--danger);font-size:1rem;">⚠</div>
      <div class="hint" style="color:var(--danger);">${esc(msg)}</div>
    `;
  });

  const lastCard = cards[cards.length - 1];
  if (lastCard) {
    const hint = lastCard.querySelector('.hint');
    if (hint && !hint.querySelector('.btn-retry')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-retry';
      button.textContent = 'Tentar novamente';
      button.addEventListener('click', () => {
        retrySales().catch(err => console.warn('[dashboard] retrySales:', err));
      });
      hint.appendChild(document.createElement('br'));
      hint.appendChild(button);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Recentes
// ─────────────────────────────────────────────────────────────
function paintRecent(users) {
  const recentEl = document.getElementById('recentUsersTable');
  if (!recentEl) return;

  const recent = users.slice(0, 5);
  if (!recent.length) {
    recentEl.innerHTML = '<p style="color:var(--text-dim);">Nenhum usuário cadastrado ainda.</p>';
    return;
  }

  recentEl.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Nome</th><th>E-mail</th><th>Plano</th><th>Cadastro</th>
      </tr></thead>
      <tbody>
        ${recent.map(u => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td>${badgePlan(u.plan)}</td>
            <td>${formatDate(u.createdAt)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function badgePlan(plan) {
  const normalized = String(plan || '').trim().toLowerCase();
  if (normalized === 'free') return '<span class="badge-mini badge-free">Free</span>';
  if (normalized === 'premium') return '<span class="badge-mini badge-premium">Premium</span>';
  if (normalized === 'anual') return '<span class="badge-mini badge-anual">Anual</span>';
  return `<span class="badge-mini">${esc(plan || '—')}</span>`;
}

function friendlyError(err, label) {
  if (err?.status === 401 || err?.status === 403) return 'Sessão expirada.';
  if (err?.status === 429) return 'Muitas tentativas. Aguarde.';
  if (err?.status >= 500) return `Servidor indisponível (${label}).`;
  if (err?.message?.toLowerCase().includes('network')) return 'Sem conexão.';
  return err?.message || `Erro ao carregar ${label}.`;
}