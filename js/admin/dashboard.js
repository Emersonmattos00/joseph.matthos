/* ============================================================
   admin/dashboard.js — Cards de estatísticas do painel
   ------------------------------------------------------------
   - Endpoints consolidados: /api/admin?action=users|sales
   - Usa `summary` do endpoint de sales quando disponível
   - ✅ Loading, erro e retry INDIVIDUAIS por painel:
       - users  → card de usuários + recentes
       - sales  → cards de assinaturas/aluguéis/receita
   - Se ambos falharem com 401/403, propaga para o index.js
     redirecionar para login
   - Falha de rede/5xx em um painel NÃO bloqueia o outro
   ============================================================ */

import { apiFetch } from './api.js';
import { esc, formatCents, formatDate } from './ui/format.js';

// ─────────────────────────────────────────────────────────────
// Estado interno do dashboard
// ------------------------------------------------------------
// Cada painel tem seu próprio estado para permitir
// loading/erro/retry individual.
// ─────────────────────────────────────────────────────────────
const DashState = {
  users: {
    status: 'idle', // idle | loading | ready | error
    data: [],
    error: null
  },
  sales: {
    status: 'idle',
    data: { subscriptions: [], rentals: [], summary: null },
    error: null
  }
};

// ─────────────────────────────────────────────────────────────
// Entrada pública
// ─────────────────────────────────────────────────────────────
export async function renderDashboard() {
  // 1) Skeleton inicial (ambos os painéis)
  paintUsersLoading();
  paintSalesLoading();

  // 2) Dispara em paralelo (não bloqueia um pelo outro)
  await Promise.allSettled([
    fetchUsers(),
    fetchSales()
  ]);

  // 3) Se AMBOS falharam com 401/403, propaga (login expirou)
  const usersAuthFail =
    DashState.users.status === 'error' &&
    (DashState.users.error?.status === 401 || DashState.users.error?.status === 403);

  const salesAuthFail =
    DashState.sales.status === 'error' &&
    (DashState.sales.error?.status === 401 || DashState.sales.error?.status === 403);

  if (usersAuthFail && salesAuthFail) {
    throw DashState.users.error || DashState.sales.error;
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch individual — USERS
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

    if (err?.status === 401 || err?.status === 403) {
      DashState.users.status = 'error';
      DashState.users.error = err;
      throw err; // propaga para o renderDashboard decidir
    }

    DashState.users.status = 'error';
    DashState.users.error = err;
    paintUsersError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch individual — SALES
// ─────────────────────────────────────────────────────────────
async function fetchSales() {
  DashState.sales.status = 'loading';
  DashState.sales.error = null;

  try {
    const res = await apiFetch('sales', { method: 'GET' });

    const data = {
      subscriptions: Array.isArray(res?.subscriptions) ? res.subscriptions : [],
      rentals: Array.isArray(res?.rentals) ? res.rentals : [],
      summary: res?.summary || null
    };

    DashState.sales.data = data;
    DashState.sales.status = 'ready';

    paintSalesReady();
  } catch (err) {
    console.error('[dashboard] sales:', err);

    if (err?.status === 401 || err?.status === 403) {
      DashState.sales.status = 'error';
      DashState.sales.error = err;
      throw err;
    }

    DashState.sales.status = 'error';
    DashState.sales.error = err;
    paintSalesError(err);
  }
}

// ─────────────────────────────────────────────────────────────
// Retry individual — expostos no window para os botões
// ─────────────────────────────────────────────────────────────
export async function retryUsers() {
  try {
    await fetchUsers();
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      throw err; // index.js trata redirecionando para login
    }
  }
}

export async function retrySales() {
  try {
    await fetchSales();
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      throw err;
    }
  }
}

// Expõe no window para os botões onclick inline
if (typeof window !== 'undefined') {
  window.__dashboardRetryUsers = () => {
    retryUsers().catch((e) => console.warn('[dashboard] retryUsers:', e));
  };
  window.__dashboardRetrySales = () => {
    retrySales().catch((e) => console.warn('[dashboard] retrySales:', e));
  };
}

// ─────────────────────────────────────────────────────────────
// PINTURA — USERS
// ─────────────────────────────────────────────────────────────
function paintUsersLoading() {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  // Não apaga os cards já pintados de sales — só adiciona placeholder
  // Se ainda não temos nada, mostra skeleton geral
  if (!el.querySelector('.stat-card[data-panel="sales"]')) {
    el.innerHTML = `
      <div class="stat-card" data-panel="users">
        <div class="label">Usuários</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
      <div class="stat-card" data-panel="sales">
        <div class="label">Assinaturas ativas</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
      <div class="stat-card" data-panel="sales">
        <div class="label">Receita aluguéis</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
      <div class="stat-card" data-panel="sales">
        <div class="label">Aluguéis</div>
        <div class="value">—</div>
        <div class="hint loading-hint">Carregando…</div>
      </div>
    `;
  } else {
    // Só atualiza o card de users
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
  const premium = users.filter(
    (u) => u.plan === 'premium' || u.plan === 'anual'
  ).length;
  const free = users.length - premium;

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
// PINTURA — SALES
// ─────────────────────────────────────────────────────────────
function paintSalesLoading() {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  // Os 3 cards de sales já foram criados no paintUsersLoading
  // Aqui só garante que estão no estado loading
  el.querySelectorAll('.stat-card[data-panel="sales"]').forEach((card) => {
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

  const sales = DashState.sales.data;
  const users = DashState.users.data;

  const summary = sales.summary;
  const activeSubs =
    summary?.subscriptions?.active ??
    sales.subscriptions.filter((s) => s.status === 'authorized').length;
  const totalRentals = summary?.rentals?.total ?? sales.rentals.length;
  const rentalRevenueCents =
    summary?.rentals?.revenueCents ??
    sales.rentals.reduce((sum, r) => sum + normalizeCents(r), 0);

  // Atualiza cada card de sales
  const cards = el.querySelectorAll('.stat-card[data-panel="sales"]');
  if (cards.length >= 3) {
    // Card 1: Assinaturas ativas
    cards[0].classList.remove('is-error');
    cards[0].innerHTML = `
      <div class="label">Assinaturas ativas</div>
      <div class="value">${activeSubs}</div>
      <div class="hint">${users.length ? Math.round((activeSubs / users.length) * 100) : 0}% do total</div>
    `;

    // Card 2: Receita aluguéis
    cards[1].classList.remove('is-error');
    cards[1].innerHTML = `
      <div class="label">Receita aluguéis</div>
      <div class="value">${formatCents(rentalRevenueCents)}</div>
      <div class="hint">todos os tempos</div>
    `;

    // Card 3: Aluguéis
    cards[2].classList.remove('is-error');
    cards[2].innerHTML = `
      <div class="label">Aluguéis</div>
      <div class="value">${totalRentals}</div>
      <div class="hint">total</div>
    `;
  }
}

function paintSalesError(err) {
  const el = document.getElementById('statsGrid');
  if (!el) return;

  const msg = friendlyError(err, 'vendas');

  el.querySelectorAll('.stat-card[data-panel="sales"]').forEach((card) => {
    card.classList.add('is-error');
    card.innerHTML = `
      <div class="label">${esc(card.querySelector('.label')?.textContent || 'Vendas')}</div>
      <div class="value" style="color:var(--danger);font-size:1rem;">⚠</div>
      <div class="hint" style="color:var(--danger);">
        ${esc(msg)}
      </div>
    `;
  });

  // Adiciona botão de retry apenas no último card para não poluir
  const last = el.querySelector('.stat-card[data-panel="sales"]:last-of-type .hint');
  if (last && !last.querySelector('.btn-retry')) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-retry';
    btn.textContent = 'Tentar novamente';
    btn.onclick = () => window.__dashboardRetrySales?.();
    last.appendChild(document.createElement('br'));
    last.appendChild(btn);
  }
}

// ─────────────────────────────────────────────────────────────
// PINTURA — RECENTES (dependente de users)
// ─────────────────────────────────────────────────────────────
function paintRecent(users) {
  const recentEl = document.getElementById('recentUsersTable');
  if (!recentEl) return;

  const recent = users.slice(0, 5);
  if (!recent.length) {
    recentEl.innerHTML =
      '<p style="color:var(--text-dim);">Nenhum usuário cadastrado ainda.</p>';
    return;
  }

  recentEl.innerHTML = `
    <table class="admin-table">
      <thead><tr>
        <th>Nome</th><th>E-mail</th><th>Plano</th><th>Cadastro</th>
      </tr></thead>
      <tbody>
        ${recent
          .map(
            (u) => `
          <tr>
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td>${badgePlan(u.plan)}</td>
            <td>${formatDate(u.createdAt)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>`;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function badgePlan(plan) {
  if (plan === 'free') return '<span class="badge-mini badge-free">Free</span>';
  if (plan === 'premium') return '<span class="badge-mini badge-premium">Premium</span>';
  if (plan === 'anual') return '<span class="badge-mini badge-anual">Anual</span>';
  return `<span class="badge-mini">${esc(plan || '—')}</span>`;
}

function normalizeCents(r) {
  if (Number.isFinite(r?.amount_cents)) return r.amount_cents;
  if (Number.isFinite(r?.amount)) return Math.round(r.amount * 100);
  return 0;
}

function friendlyError(err, label) {
  if (err?.status === 401 || err?.status === 403) return 'Sessão expirada.';
  if (err?.status === 429) return 'Muitas tentativas. Aguarde.';
  if (err?.status >= 500) return `Servidor indisponível (${label}).`;
  if (err?.message?.toLowerCase().includes('network')) return 'Sem conexão.';
  return err?.message || `Erro ao carregar ${label}.`;
}
