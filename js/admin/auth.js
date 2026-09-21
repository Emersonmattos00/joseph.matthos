/* ============================================================
   js/admin/auth.js — Autenticação do painel administrativo
   ------------------------------------------------------------
   - Login / logout / sessão do admin
   - Atalho global Ctrl+Shift+A
   - Abre o painel quando ?admin está na URL
   - FLUXO CORRIGIDO: sessão → bootContent → dashboard
   - Propaga erros 401/403/429/503 para o caller
   ============================================================ */

import { AdminState, resetState } from './state.js';
import { toast } from './ui/toast.js';
import { apiFetch } from './api.js';

let shortcutsBound = false;
let loginBound = false;

// ─────────────────────────────────────────────────────────────
// Exibição
// ─────────────────────────────────────────────────────────────
export function showAdminLogin() {
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
  const user = document.getElementById('adminUser');
  if (user) setTimeout(() => user.focus(), 0);
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
// Abrir painel — orquestrador único
// ------------------------------------------------------------
// Fluxo:
//   showAdminRoot → /session
//      ├─ 401/403 → showAdminLogin (sem tentar carregar conteúdo)
//      ├─ erro de rede/5xx → showAdminLogin (fail-safe)
//      └─ OK → showAdminDashboard → __admin.bootContent()
//                        (loadContent → applyContent → dashboard)
// ─────────────────────────────────────────────────────────────
export async function openAdminSite() {
  setDisplay('publicSite', 'none');
  setDisplay('adminSite', 'block');
  document.body.style.paddingBottom = '0';
  window.scrollTo(0, 0);
  showSessionLoading();

  let session = null;
  try {
    session = await apiFetch('session', { method: 'GET' });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
      // Sem sessão válida → login, sem carregar conteúdo
      showAdminLogin();
      return;
    }
    console.error('[admin-session]', err);

    if (err?.status === 503) {
      setError('adminLoginError', 'Painel não configurado no servidor.');
    } else if (err?.status >= 500) {
      setError('adminLoginError', 'Servidor indisponível. Tente novamente.');
    } else {
      setError('adminLoginError', 'Não foi possível verificar a sessão.');
    }

    setDisplay('adminLoginForm', 'block');
    setDisplay('adminPasswordChangeForm', 'none');
    setDisplay('adminForgotPassword', 'block');
    return;
  }

  if (!session || !session.ok) {
    showAdminLogin();
    return;
  }

  // Sessão OK → agora sim carrega conteúdo e renderiza dashboard
  AdminState.user = session.user || { user: 'admin' };
  showAdminDashboard();

  if (window.__admin && typeof window.__admin.bootContent === 'function') {
    try {
      await window.__admin.bootContent();
    } catch (err) {
      // bootContent já lida com 401/403 internamente (mostrando login).
      // Aqui só registramos erros inesperados sem derrubar a UI.
      console.error('[admin] bootContent falhou:', err);
    }
  } else {
    console.warn('[admin] __admin.bootContent indisponível — conteúdo não carregado.');
  }
}

// ─────────────────────────────────────────────────────────────
// Voltar para site (LIMPA A URL)
// ─────────────────────────────────────────────────────────────
export function openPublicSite() {
  setDisplay('adminSite', 'none');
  setDisplay('publicSite', 'block');
  document.body.style.paddingBottom = '';
  window.scrollTo(0, 0);

  if (window.location.search.includes('admin')) {
    window.history.pushState({}, '', window.location.pathname);
  }
}

// ─────────────────────────────────────────────────────────────
// Atalhos
// ─────────────────────────────────────────────────────────────
export function initAdminShortcuts() {
  if (shortcutsBound) return;
  shortcutsBound = true;

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') {
      e.preventDefault();
      window.history.pushState({}, '', '/?admin');
      openAdminSite();
      return;
    }

    const target = e.target;
    const inField = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const pub = document.getElementById('publicSite');
    const publicVisible = pub && pub.style.display !== 'none';

    if (e.code === 'Space' && !inField && publicVisible && typeof window.togglePlay === 'function') {
      e.preventDefault();
      window.togglePlay();
    }

    if (e.code === 'Escape') {
      const hadOpenModal = document.querySelector('.modal-overlay.open') !== null;
      document.querySelectorAll('.modal-overlay.open').forEach((modal) => {
        modal.classList.remove('open');
      });
      if (typeof window.closeAdminModal === 'function') {
        window.closeAdminModal();
      }
      if (hadOpenModal) {
        document.body.style.overflow = '';
      }
    }
  });

  bindLoginElements();
}

// ─────────────────────────────────────────────────────────────
// Elementos do login
// ─────────────────────────────────────────────────────────────
function bindLoginElements() {
  if (loginBound) return;
  loginBound = true;

  const loginForm = document.getElementById('adminLoginForm');
  if (loginForm) loginForm.addEventListener('submit', onLoginSubmit);

  const forgotBtn = document.getElementById('adminForgotPassword');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', () => {
      setError('adminLoginError', 'Para redefinir a senha, gere um novo hash com o script hash-admin-password.js e atualize ADMIN_PASSWORD_HASH no servidor.');
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
// Login
// ------------------------------------------------------------
// Após POST /login bem-sucedido, delega o fluxo completo
// para openAdminSite() — sessão → bootContent → dashboard.
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

  const form = e.currentTarget;
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalText = submitBtn ? submitBtn.textContent : '';

  setError('adminLoginError', 'Validando...');
  form.setAttribute('aria-busy', 'true');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Entrando...';
  }

  try {
    const result = await apiFetch('login', {
      method: 'POST',
      body: { user, pass }
    });

    if (!result?.ok) {
      setError('adminLoginError', result?.error || 'Usuário ou senha incorretos.');
      return;
    }

    AdminState.user = { user: result.user || user };
    clearError('adminLoginError');
    form.reset();

    // Fluxo único e confiável: sessão → conteúdo → dashboard
    await openAdminSite();
    toast('Bem-vindo ao painel.', '⚙');

  } catch (err) {
    console.error('[admin-login]', err);
    const serverMsg = err?.data?.error;

    if (err?.status === 429) setError('adminLoginError', serverMsg || 'Muitas tentativas. Aguarde alguns minutos.');
    else if (err?.status === 401) setError('adminLoginError', serverMsg || 'Usuário ou senha incorretos.');
    else if (err?.status === 403) setError('adminLoginError', serverMsg || 'Origem não permitida.');
    else if (err?.status === 503) setError('adminLoginError', serverMsg || 'Painel não configurado no servidor.');
    else setError('adminLoginError', serverMsg || 'Não foi possível conectar ao servidor.');

  } finally {
    form.removeAttribute('aria-busy');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Logout
// ─────────────────────────────────────────────────────────────
async function onLogout() {
  const logoutBtn = document.getElementById('adminLogout');
  const originalText = logoutBtn ? logoutBtn.textContent : '';

  if (logoutBtn) {
    logoutBtn.disabled = true;
    logoutBtn.textContent = 'Saindo...';
  }

  try {
    await apiFetch('logout', { method: 'POST' });
  } catch (err) {
    console.warn('[admin-logout]', err);
  } finally {
    if (logoutBtn) {
      logoutBtn.disabled = false;
      logoutBtn.textContent = originalText;
    }
  }

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

function setError(id, message) {
  const el = document.getElementById(id);
  if (el) el.textContent = message || '';
}

function clearError(id) {
  setError(id, '');
}
