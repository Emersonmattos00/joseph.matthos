/* ============================================================
   admin/dashboard.js — Cards de estatísticas do painel
   ------------------------------------------------------------
   - Endpoints consolidados: /api/admin?action=users|sales
   - Usa `summary` do endpoint de sales quando disponível
   - Estados: carregando / erro / pronto
   - Propaga 401 para o caller (index.js redireciona)
   ============================================================ */

import { apiFetch } from './api.js';
import { esc, formatCents, formatDate } from './ui/format.js';

// ─────────────────────────────────────────────────────────────
// Entrada
// ─────────────────────────────────────────────────────────────
export async function renderDashboard() {
  showLoading();

  const [usersRes, salesRes] = await Promise.allSettled([
    apiFetch('users', { method: 'GET' }),
    apiFetch('sales', { method: 'GET' })
  ]);

  const usersOk = usersRes.status === 'fulfilled';
  const salesOk = salesRes.status === 'fulfilled';

  // Se ambos falharem por 401/403, propaga para o index.js redirecionar
  const usersStatus = usersRes.status === 'rejected' ? usersRes.reason?.status : null;
  const salesStatus = salesRes.status === 'rejected' ? salesRes.reason?.status : null;

  if (
    (!usersOk && (usersStatus === 401 || usersStatus === 403)) &&
    (!salesOk && (salesStatus === 401 || salesStatus === 403))
  ) {
    throw usersRes.reason;
  }

  const users = usersOk && Array.isArray(usersRes.value.users)
    ? usersRes.value.users
    : [];

  const sales = salesOk
    ? {
        subscriptions: Array.isArray(salesRes.value.subscriptions) ? salesRes.value.subscriptions : [],
        rentals: Array.isArray(salesRes.value.rentals) ? salesRes.value.rentals : [],
        summary: salesRes.value.summary || null
      }
    : { subscriptions: [], rentals: [], summary: null };

  renderStats(users, sales);
  renderRecent(users);

  // Se um dos dois falhou (mas não 401), mostra aviso sutil
  if (!usersOk || !salesOk) {
    const el = document.getElementById('statsGrid');
    if (el) {
      const warn = document.createElement('p');
      warn.className = 'hint';
      warn.style.color = 'var(--warning, #f0a100)';
      warn.style.gridColumn = '1 / -1';
      warn.textContent = 'Alguns dados não puderam ser carregados. Atualize a página.';
      el.appendChild(warn);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Render — stats
// ─────────────────────────────────────────────────────────────
function showLoading() {
  const statsEl = document.getElementById('statsGrid');
  if (statsEl) {
    statsEl.innerHTML = '<p class="loading">Carregando…</p>';
  }
  const recentEl = document.getElementById('recentUsersTable');
  if (recentEl) {
    recentEl.innerHTML = '<p class="loading">Carregando…</p>';
  }
}

function renderStats(users, sales) {
  const statsEl = document.getElementById('statsGrid');
  if (!statsEl) return;

  const premium = users.filter(
    (u) => u.plan === 'premium' || u.plan === 'anual'
  ).length;
  const free = users.length - premium;

  // Preferimos o summary do servidor (fonte de verdade)
  const summary = sales.summary;
  const activeSubs = summary?.subscriptions?.active
    ?? sales.subscriptions.filter((s) => s.status === 'authorized').length;
  const totalRentals = summary?.rentals?.total ?? sales.rentals.length;
  const rentalRevenueCents = summary?.rentals?.revenueCents
    ?? sales.rentals.reduce((sum, r) => sum + normalizeCents(r), 0);

  statsEl.innerHTML = `
    <div class="stat-card">
      <div class="label">Usuários</div>
      <div class="value">${users.length}</div>
      <div class="hint">${free} free · ${premium} premium</div>
    </div>
    <div class="stat-card">
      <div class="label">Assinaturas ativas</div>
      <div class="value">${activeSubs}</div>
      <div class="hint">${users.length ? Math.round((activeSubs / users.length) * 100) : 0}% do total</div>
    </div>
    <div class="stat-card">
      <div class="label">Receita aluguéis</div>
      <div class="value">${formatCents(rentalRevenueCents)}</div>
      <div class="hint">todos os tempos</div>
    </div>
    <div class="stat-card">
      <div class="label">Aluguéis</div>
      <div class="value">${totalRentals}</div>
      <div class="hint">total</div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Render — recentes
// ─────────────────────────────────────────────────────────────
function renderRecent(users) {
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