/* ============================================================
   js/admin/auth.js — Autenticação do painel administrativo
   ------------------------------------------------------------
   Correções aplicadas (auditoria):
   - Login confirma sessão via /session antes de abrir dashboard
   - Logout só declara sucesso após confirmação do servidor
   - bindLoginElements só marca loginBound após encontrar o form
   - Mensagem de recuperação genérica (sem citar Vercel)
   - enterAdminDashboard trata erros 401/403 com logout forçado
   - Atalho Ctrl+Shift+A não dispara com cursor em campo
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

function showSessionLoading() {
  setDisplay('adminLogin', 'flex');
  setDisplay('adminDashboard', 'none');
  setDisplay('adminLoginForm', 'none');
  setDisplay('adminPasswordChangeForm', 'none');
  setDisplay('adminForgotPassword', 'none');
  setError('adminLoginError', 'Verificando sessão...');
}

// ─────────────────────────────────────────────────────────────
// Entrar no dashboard
// ─────────────────────────────────────────────────────────────
async function enterAdminDashboard(user) {
  setDisplay('publicSite', 'none');
  setDisplay('adminSite', 'block');
  document.body.style.paddingBottom = '0';
  window.scrollTo(0, 0);

  AdminState.user = user || { user: 'admin' };
  showAdminDashboard();

  if (typeof window.__admin?.bootContent !== 'function') {
    console.error('[admin] __admin.bootContent indisponível.');
    toast('Não foi possível inicializar o painel.', '⚠');
    return;
  }

  try {
    await window.__admin.bootContent();
  } catch (err) {
    console.error('[admin] bootContent falhou:', err);

    // ★ Sessão expirada durante o carregamento → força novo login
    if (err?.status === 401 || err?.status === 403) {
      resetState();
      showAdminLogin();
      setError('adminLoginError', 'Sua sessão expirou. Entre novamente.');
      return;
    }

    toast('Falha ao carregar os dados administrativos.', '⚠');
  }
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

  let session = null;
  try {
    session = await apiFetch('session', { method: 'GET' });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) {
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

  await enterAdminDashboard(session.user);
}

// ─────────────────────────────────────────────────────────────
// Voltar para site
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
    const target = e.target;
    const inField = target && (
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
      target.isContentEditable
    );

    // ★ Atalho só funciona fora de campos de formulário
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyA') {
      if (inField) return;
      e.preventDefault();
      window.history.pushState({}, '', '/?admin');
      openAdminSite();
      return;
    }

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

  const loginForm = document.getElementById('adminLoginForm');
  if (!loginForm) {
    console.warn('[admin] Formulário de login ainda não encontrado.');
    return;
  }

  loginForm.addEventListener('submit', onLoginSubmit);

  const forgotBtn = document.getElementById('adminForgotPassword');
  if (forgotBtn) {
    forgotBtn.addEventListener('click', () => {
      setError(
        'adminLoginError',
        'A senha do painel é definida pelo administrador do servidor. ' +
        'Gere um novo hash com o script hash-admin-password.js e atualize ' +
        'a variável ADMIN_PASSWORD_HASH nas variáveis de ambiente.'
      );
    });
  }

  const logoutBtn = document.getElementById('adminLogout');
  if (logoutBtn) logoutBtn.addEventListener('click', onLogout);

  const backBtn = document.getElementById('backToSiteFromLogin');
  if (backBtn) backBtn.addEventListener('click', openPublicSite);

  const viewSiteBtn = document.getElementById('adminViewSite');
  if (viewSiteBtn) viewSiteBtn.addEventListener('click', openPublicSite);

  loginBound = true;
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

    // ★ CORREÇÃO: confirma a sessão antes de abrir o dashboard
    let session;
    try {
      session = await apiFetch('session', { method: 'GET' });
    } catch (err) {
      console.error('[admin-login] sessão não confirmada:', err);
      setError('adminLoginError', 'Login aceito, mas a sessão não foi confirmada. Tente novamente.');
      return;
    }

    if (!session?.ok || !session.user) {
      setError('adminLoginError', 'Login aceito, mas a sessão não foi confirmada.');
      return;
    }

    clearError('adminLoginError');
    form.reset();

    await enterAdminDashboard(session.user);
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
    const result = await apiFetch('logout', { method: 'POST' });
    if (!result?.ok) {
      throw new Error('O servidor não confirmou o encerramento da sessão.');
    }

    resetState();
    showAdminLogin();
    openPublicSite();
    toast('Sessão de admin encerrada.', 'ℹ');

  } catch (err) {
    console.error('[admin-logout]', err);
    setError('adminLoginError', 'Não foi possível confirmar o encerramento da sessão. Tente novamente.');
    toast('Falha ao encerrar a sessão no servidor.', '⚠');

  } finally {
    if (logoutBtn) {
      logoutBtn.disabled = false;
      logoutBtn.textContent = originalText;
    }
  }
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