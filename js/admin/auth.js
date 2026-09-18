/* ============================================================
   js/admin/auth.js — Login, logout e sessão do painel
   ------------------------------------------------------------
   - Endpoints: /api/admin?action=*
   - Sessão através de cookie HttpOnly
   - Atalho Ctrl+Shift+A com atualização de URL (/?admin)
   - Bind único dos elementos
   - Tratamento explícito dos erros HTTP
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';
import { AdminState, resetState } from './state.js';

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
// Abrir painel
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
    if (err?.status === 401) {
      showAdminLogin();
      return;
    }
    console.error('[admin-session]', err);
    
    if (err?.status === 403) setError('adminLoginError', 'Acesso rejeitado pelo servidor.');
    else if (err?.status === 503) setError('adminLoginError', 'Painel não configurado no servidor.');
    else if (err?.status >= 500) setError('adminLoginError', 'Servidor indisponível. Tente novamente.');
    else setError('adminLoginError', 'Não foi possível verificar a sessão.');

    setDisplay('adminLoginForm', 'block');
    setDisplay('adminPasswordChangeForm', 'none');
    setDisplay('adminForgotPassword', 'block');
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

  // Remove o ?admin da URL ao voltar para o site público
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
    // Ctrl + Shift + A
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') {
      e.preventDefault();
      
      // 1. Atualiza a URL para /?admin sem recarregar a página
      window.history.pushState({}, '', '/?admin');
      
      // 2. Abre o painel
      openAdminSite();
      return;
    }

    const target = e.target;
    const inField = target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    const pub = document.getElementById('publicSite');
    const publicVisible = pub && pub.style.display !== 'none';

    // Espaço = play
    if (e.code === 'Space' && !inField && publicVisible && typeof window.togglePlay === 'function') {
      e.preventDefault();
      window.togglePlay();
    }

    // ESC
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

    // >>> NOVO: Recarrega o conteúdo do painel agora que estamos autenticados
    if (window.__admin && typeof window.__admin.reload === 'function') {
      await window.__admin.reload();
    }

    showAdminDashboard();
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
