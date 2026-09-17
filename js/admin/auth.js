/* ============================================================
   admin/auth.js — Login, logout e sessão via API
   ------------------------------------------------------------
   - Sem import circular (usa state.js)
   - Endpoints consolidados: /api/admin?action=*
   - Feedback visual consistente (aria-busy)
   - Bind único (protegido contra dupla chamada)
   - Logout reseta o estado global
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';
import { AdminState, resetState } from './state.js';

// ─────────────────────────────────────────────────────────────
// Guard: bind único de listeners
// ─────────────────────────────────────────────────────────────
let shortcutsBound = false;
let loginBound = false;

// ─────────────────────────────────────────────────────────────
// Exibição
// ─────────────────────────────────────────────────────────────
export function showAdminLogin() {
  // Limpa estado do usuário ao voltar para login
  AdminState.user = null;

  setDisplay('adminLogin', 'flex');
  setDisplay('adminDashboard', 'none');
  showLoginForm();
}

export function showAdminDashboard() {
  setDisplay('adminLogin', 'none');
  setDisplay('adminDashboard', 'grid');
}

export function showLoginForm() {
  setDisplay('adminLoginForm', 'block');
  setDisplay('adminPasswordChangeForm', 'none');
  setDisplay('adminForgotPassword', 'block');
  clearError('adminLoginError');
}

export function showPasswordChangeForm() {
  setDisplay('adminLoginForm', 'none');
  setDisplay('adminPasswordChangeForm', 'block');
  setDisplay('adminForgotPassword', 'none');
  clearError('adminLoginError');
  const newPass = document.getElementById('adminNewPass');
  if (newPass) newPass.focus();
}

function showSessionLoading() {
  setDisplay('adminLogin', 'flex');
  setDisplay('adminDashboard', 'none');
  setDisplay('adminLoginForm', 'none');
  setDisplay('adminPasswordChangeForm', 'none');
  setDisplay('adminForgotPassword', 'none');
  setError('adminLoginError', 'Verificando sessão...');
}

// ─────────────────────────────────────────────────────────────
// Abrir / fechar painel
// ─────────────────────────────────────────────────────────────
export async function openAdminSite() {
  setDisplay('publicSite', 'none');
  setDisplay('adminSite', 'block');
  document.body.style.paddingBottom = '0';
  window.scrollTo(0, 0);

  showSessionLoading();

  try {
    const session = await apiFetch('session', { method: 'GET' });
    if (session && session.ok) {
      AdminState.user = session.user || { user: 'admin' };
      showAdminDashboard();
      return;
    }
    showAdminLogin();
  } catch (err) {
    if (err && err.status === 401) {
      // 401 é esperado quando não há sessão
      showAdminLogin();
      return;
    }
    // Erros de rede/5xx
    console.error('[admin-session]', err);
    setError('adminLoginError', 'Não foi possível verificar a sessão. Faça login novamente.');
    setDisplay('adminLoginForm', 'block');
    setDisplay('adminPasswordChangeForm', 'none');
    setDisplay('adminForgotPassword', 'block');
  }
}

export function openPublicSite() {
  setDisplay('adminSite', 'none');
  setDisplay('publicSite', 'block');
  document.body.style.paddingBottom = '';
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────────────────────────
// Bind de elementos (chamado uma vez no bootstrap)
// ─────────────────────────────────────────────────────────────
export function initAdminShortcuts() {
  if (shortcutsBound) return;
  shortcutsBound = true;

  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A — abre painel
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') {
      e.preventDefault();
      openAdminSite();
      return;
    }

    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    const pub = document.getElementById('publicSite');
    const publicVisible = pub && pub.style.display !== 'none';

    if (e.code === 'Space' && !inField && publicVisible && typeof window.togglePlay === 'function') {
      e.preventDefault();
      window.togglePlay();
    }

    if (e.code === 'Escape') {
      const hadOpenModal = document.querySelector('.modal-overlay.open') !== null;
      document.querySelectorAll('.modal-overlay.open').forEach((m) => m.classList.remove('open'));
      if (typeof window.closeAdminModal === 'function') window.closeAdminModal();
      if (hadOpenModal) document.body.style.overflow = '';
    }
  });

  bindLoginElements();
}

function bindLoginElements() {
  if (loginBound) return;
  loginBound = true;

  const loginForm = document.getElementById('adminLoginForm');
  if (loginForm) {
    loginForm.addEventListener('submit', onLoginSubmit);
  }

  const forgotBtn = document.getElementById('adminForgotPassword');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', () => {
      setError(
        'adminLoginError',
        'Para redefinir, gere um novo hash no servidor e atualize ADMIN_PASSWORD_HASH. Depois faça deploy.'
      );
    });
  }

  const logoutBtn = document.getElementById('adminLogout');
  if (logoutBtn) logoutBtn.addEventListener('click', onLogout);

  const backBtn = document.getElementById('backToSiteFromLogin');
  if (backBtn) backBtn.addEventListener('click', openPublicSite);

  const viewSiteBtn = document.getElementById('adminViewSite');
  if (viewSiteBtn) viewSiteBtn.addEventListener('click', openPublicSite);
}

// ─────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────
async function onLoginSubmit(e) {
  e.preventDefault();

  const userEl = document.getElementById('adminUser');
  const passEl = document.getElementById('adminPass');
  if (!userEl || !passEl) {
    setError('adminLoginError', 'Formulário inválido.');
    return;
  }

  const user = userEl.value.trim();
  const pass = passEl.value;

  if (!user || !pass) {
    setError('adminLoginError', 'Preencha usuário e senha.');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const form = e.target;

  setError('adminLoginError', 'Validando...');
  form.setAttribute('aria-busy', 'true');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const result = await apiFetch('login', {
      method: 'POST',
      body: { user, pass }
    });

    if (!result || !result.ok) {
      setError('adminLoginError', (result && result.error) || 'Usuário ou senha incorretos.');
      return;
    }

    AdminState.user = { user: result.user || user };
    clearError('adminLoginError');
    form.reset();
    showAdminDashboard();
    toast('Bem-vindo ao painel.', '⚙');
  } catch (err) {
    console.error('[admin-login]', err);

    const serverMsg = err?.data?.error;

    if (err?.status === 429) {
      setError('adminLoginError', serverMsg || 'Muitas tentativas. Aguarde alguns minutos.');
    } else if (err?.status === 401) {
      setError('adminLoginError', serverMsg || 'Usuário ou senha incorretos.');
    } else if (err?.status === 503) {
      setError('adminLoginError', serverMsg || 'Painel não configurado no servidor.');
    } else {
      setError('adminLoginError', serverMsg || 'Não foi possível conectar ao servidor.');
    }
  } finally {
    form.removeAttribute('aria-busy');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function onLogout() {
  const logoutBtn = document.getElementById('adminLogout');
  if (logoutBtn) logoutBtn.disabled = true;

  try {
    await apiFetch('logout', { method: 'POST' });
  } catch (err) {
    // Logout é idempotente; mesmo se falhar, seguimos
    console.warn('[admin-logout]', err);
  } finally {
    if (logoutBtn) logoutBtn.disabled = false;
  }

  // Reset completo do estado local
  resetState();

  showAdminLogin();
  openPublicSite();
  toast('Sessão de admin encerrada.', 'ℹ');
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function setDisplay(id, value) {
  const el = document.getElementById(id);
  if (el) el.style.display = value;
}

function setError(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg;
}

function clearError(id) {
  setError(id, '');
}