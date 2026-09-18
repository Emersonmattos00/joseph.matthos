/* ============================================================
   js/admin/index.js — Entrypoint do painel administrativo
   ------------------------------------------------------------
   - Registra atalho Ctrl+Shift+A antes de qualquer API
   - Detecta URL /?admin e abre o painel automaticamente
   - Binds resilientes (try/catch por editor)
   - Nav tabs com bind único (MutationObserver só no <nav>)
   ============================================================ */

import { AdminState, markDirty, markClean } from './state.js';
import {
  initAdminShortcuts,
  openAdminSite,
  openPublicSite,
  showAdminLogin
} from './auth.js';
import { loadContent, saveContent } from './content.js';
import { renderDashboard } from './dashboard.js';
import { renderUsersTable, invalidateUsersCache } from './users.js';
import { renderSales, invalidateSalesCache } from './sales.js';
import { bindUpload } from './uploads.js';
import { renderFrasesEditor } from './editors/frases.js';
import { renderAlbumsEditor, bindAlbumsAddButton } from './editors/albums.js';
import { renderPlaylistsEditor, bindPlaylistsAddButton } from './editors/playlists.js';
import { renderPlansEditor } from './editors/plans.js';
import { renderSocialEditor, bindSocialsAddButton } from './editors/socials.js';
import { getByPath, setByPath } from './ui/dom.js';
import { toast } from './ui/toast.js';
import { renderBackupInfo } from './backup.js';
import { DEFAULT_CONTENT } from '../config.js';
import { safeMediaUrl } from '../utils.js';

export { AdminState };

const TAB_TITLES = {
  dashboard: 'Dashboard',
  geral: 'Geral',
  hero: 'Hero',
  sobre: 'Sobre',
  filosofia: 'Filosofia',
  discografia: 'Discografia',
  vendas: 'Vendas',
  planos: 'Planos',
  contato: 'Contato',
  usuarios: 'Usuários',
  aparencia: 'Aparência',
  backup: 'Backup'
};

// ─────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────
async function bootstrap() {
  console.log('[admin] bootstrap iniciado');

  // 1) Atalho SEMPRE primeiro
  initAdminShortcuts();

  // ==========================================================
  // >>> NOVO: Verifica se a URL contém ?admin e abre o painel
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('admin')) {
    // setTimeout garante que os binds iniciais da UI já foram registrados
    setTimeout(() => {
      openAdminSite();
    }, 0);
  }
  // ==========================================================

  // 2) Binds de navegação e ações ANTES de carregar conteúdo
  bindNavTabs();
  bindContentInputs();
  bindGlobalActions();
  bindEditorButtons();
  bindUploadZones();
  bindRefreshButtons();

  // 3) Carrega conteúdo
  try {
    const loaded = await loadContent();
    AdminState.content = loaded.data;
    AdminState.contentVersion = loaded.version;
    AdminState.contentUpdatedAt = loaded.updatedAt || null;
    console.log('[admin] conteúdo carregado, versão', loaded.version);
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      console.warn('[admin] sessão inválida — Ctrl+Shift+A disponível');
      return;
    }
    console.error('[admin] loadContent falhou:', err);
    AdminState.content = JSON.parse(JSON.stringify(DEFAULT_CONTENT));
    AdminState.contentVersion = 0;
  }

  // 4) Aplica no site público
  safeCall('applyContentToSite', AdminState.content);
  safeCall('refreshFlatPlaylist');
  safeCall('refreshPlanConfig');
  safeCall('updateCartFab');

  // 5) Preenche campos (resiliente)
  loadAllAdminFields();

  // 6) Dashboard assíncrono
  renderDashboard().catch((err) => {
    if (err && (err.status === 401 || err.status === 403)) return;
    console.warn('[admin] dashboard:', err);
  });

  console.log('[admin] bootstrap completo');
}

// ─────────────────────────────────────────────────────────────
// Nav tabs
// ------------------------------------------------------------
// Estratégia:
//  - attach() roda imediatamente (caso os botões já existam)
//  - MutationObserver observa APENAS o <nav class="admin-nav">
//    para re-bindar quando os botões aparecerem depois do login
//  - Guard dataset.bound evita bind duplicado
// ─────────────────────────────────────────────────────────────
function bindNavTabs() {
  const attach = () => {
    const buttons = document.querySelectorAll('.admin-nav button');
    let newlyBound = 0;

    buttons.forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', onClickNavButton);
      newlyBound++;
    });

    if (newlyBound > 0) {
      console.log(`[admin] bindNavTabs: ${newlyBound} novos botões (total ${buttons.length})`);
    }
  };

  // 1) Tenta bindar agora
  attach();

  // 2) Se o <nav> já existe, observa apenas ele
  const nav = document.querySelector('.admin-nav');
  if (nav && !nav.dataset.observed) {
    nav.dataset.observed = '1';
    const observer = new MutationObserver(attach);
    observer.observe(nav, { childList: true, subtree: true });
    console.log('[admin] MutationObserver ativo no .admin-nav');
  } else if (!nav) {
    // Se o nav ainda não existe (improvável), observa o body com escopo reduzido
    const observer = new MutationObserver(() => {
      const navNow = document.querySelector('.admin-nav');
      if (navNow && !navNow.dataset.observed) {
        navNow.dataset.observed = '1';
        attach();
        observer.disconnect();
        const obs2 = new MutationObserver(attach);
        obs2.observe(navNow, { childList: true, subtree: true });
        console.log('[admin] nav detectado e observado');
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

async function onClickNavButton(event) {
  const btn = event.currentTarget;
  const tab = btn.dataset.tab;
  if (!tab) return;

  document.querySelectorAll('.admin-nav button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.admin-section').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');

  const section = document.getElementById('tab-' + tab);
  if (section) section.classList.add('active');

  const titleEl = document.getElementById('adminTabTitle');
  if (titleEl) titleEl.textContent = TAB_TITLES[tab] || tab;

  try {
    if (tab === 'usuarios') {
      invalidateUsersCache();
      await renderUsersTable({ force: true });
    } else if (tab === 'vendas') {
      invalidateSalesCache();
      await renderSales({ force: true });
    } else if (tab === 'backup') {
      renderBackupInfo(AdminState);
    } else if (tab === 'aparencia') {
      loadAllAdminFields();
    } else if (tab === 'contato') {
      renderSocialEditor(AdminState.content);
    }
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      toast('Sessão expirada.', '⚠');
      showAdminLogin();
      return;
    }
    console.error(`[admin] tab ${tab}:`, err);
    toast(err?.message || `Erro em "${TAB_TITLES[tab] || tab}".`, '⚠');
  }
}

// ─────────────────────────────────────────────────────────────
// Aplica conteúdo nos campos data-content — RESILIENTE
// ─────────────────────────────────────────────────────────────
function loadAllAdminFields() {
  const content = AdminState.content;
  if (!content) return;

  ensureContentStructure(content);

  try {
    document.querySelectorAll('[data-content]').forEach((el) => {
      const val = getByPath(content, el.dataset.content);
      if (el.type === 'color') el.value = val || '#000000';
      else if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val == null ? '' : val;
    });
  } catch (err) {
    console.error('[admin] campos genéricos:', err);
  }

  safeRender('frases', () => renderFrasesEditor(content));
  safeRender('albums', () => renderAlbumsEditor(content));
  safeRender('playlists', () => renderPlaylistsEditor(content));
  safeRender('plans', () => renderPlansEditor(content));
  safeRender('socials', () => renderSocialEditor(content));

  try { updateBgPreview(content); } catch (e) { console.warn('preview bg', e); }
  try { updateVinylPreview(content); } catch (e) { console.warn('preview vinyl', e); }
  try { updateSobrePreview(content); } catch (e) { console.warn('preview sobre', e); }
}

function safeRender(name, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[admin] erro em render${name}:`, err);
  }
}

function ensureContentStructure(content) {
  if (!content.filosofia) content.filosofia = {};
  if (!Array.isArray(content.filosofia.frases)) content.filosofia.frases = [];

  if (!content.discografia) content.discografia = {};
  if (!Array.isArray(content.discografia.albums)) content.discografia.albums = [];

  if (!Array.isArray(content.playlists)) content.playlists = [];

  if (!content.planos) content.planos = {};
  if (!Array.isArray(content.planos.plans)) content.planos.plans = [];

  if (!content.contato) content.contato = {};
  if (!Array.isArray(content.contato.socials)) content.contato.socials = [];

  if (!content.branding) content.branding = {};
  if (!content.hero) content.hero = {};
  if (!content.sobre) content.sobre = {};
  if (!content.aparencia) content.aparencia = {};
}

// ─────────────────────────────────────────────────────────────
// Bind dos inputs genéricos data-content
// ─────────────────────────────────────────────────────────────
function bindContentInputs() {
  document.querySelectorAll('[data-content]').forEach((el) => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';

    el.addEventListener('input', () => {
      let val = el.value;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') val = parseFloat(val) || 0;

      setByPath(AdminState.content, el.dataset.content, val);
      markDirty();

      const key = el.dataset.content;
      if (key === 'branding.bgImage') updateBgPreview(AdminState.content);
      if (key === 'hero.vinyl.image') updateVinylPreview(AdminState.content);
      if (key === 'sobre.image') updateSobrePreview(AdminState.content);

      safeCall('applyContentToSite', AdminState.content);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Botões dos editores
// ─────────────────────────────────────────────────────────────
function bindEditorButtons() {
  try { bindAlbumsAddButton(); } catch (e) { console.warn(e); }
  try { bindPlaylistsAddButton(); } catch (e) { console.warn(e); }
  try { bindSocialsAddButton(); } catch (e) { console.warn(e); }

  const addFraseBtn = document.getElementById('addFraseBtn');
  if (addFraseBtn && addFraseBtn.dataset.bound !== '1') {
    addFraseBtn.dataset.bound = '1';
    addFraseBtn.addEventListener('click', () => {
      if (!AdminState.content.filosofia) AdminState.content.filosofia = {};
      if (!Array.isArray(AdminState.content.filosofia.frases)) AdminState.content.filosofia.frases = [];
      AdminState.content.filosofia.frases.push({
        text: 'Nova frase',
        author: 'Joseph Matthos'
      });
      renderFrasesEditor(AdminState.content);
      markDirty();
      safeCall('applyContentToSite', AdminState.content);
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Upload zones
// ─────────────────────────────────────────────────────────────
function bindUploadZones() {
  document.querySelectorAll('[data-upload-target]').forEach((zone) => {
    if (zone.dataset.uploadBound === '1') return;
    zone.dataset.uploadBound = '1';

    zone.setAttribute('role', 'button');
    zone.setAttribute('tabindex', '0');

    const openInput = () => {
      const inputId = zone.dataset.uploadTarget;
      if (inputId) {
        const el = document.getElementById(inputId);
        if (el) el.click();
      }
    };

    zone.addEventListener('click', openInput);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openInput();
      }
    });
  });

  try {
    bindUpload('bgUpload', (url) => {
      if (!AdminState.content.branding) AdminState.content.branding = {};
      AdminState.content.branding.bgImage = url;
      markDirty();
      updateBgPreview(AdminState.content);
      safeCall('applyContentToSite', AdminState.content);
      toast('Imagem de fundo atualizada.', '🖼');
    });
  } catch (e) { console.warn(e); }

  try {
    bindUpload('vinylUpload', (url) => {
      if (!AdminState.content.hero) AdminState.content.hero = {};
      if (!AdminState.content.hero.vinyl) AdminState.content.hero.vinyl = {};
      AdminState.content.hero.vinyl.image = url;
      markDirty();
      updateVinylPreview(AdminState.content);
      safeCall('applyContentToSite', AdminState.content);
      toast('Imagem do vinil atualizada.', '🖼');
    });
  } catch (e) { console.warn(e); }

  try {
    bindUpload('sobreUpload', (url) => {
      if (!AdminState.content.sobre) AdminState.content.sobre = {};
      AdminState.content.sobre.image = url;
      markDirty();
      updateSobrePreview(AdminState.content);
      safeCall('applyContentToSite', AdminState.content);
      toast('Imagem da seção Sobre atualizada.', '🖼');
    });
  } catch (e) { console.warn(e); }
}

// ─────────────────────────────────────────────────────────────
// Botões de refresh
// ─────────────────────────────────────────────────────────────
function bindRefreshButtons() {
  const salesRefresh = document.getElementById('salesRefresh');
  if (salesRefresh && salesRefresh.dataset.bound !== '1') {
    salesRefresh.dataset.bound = '1';
    salesRefresh.addEventListener('click', async () => {
      invalidateSalesCache();
      try {
        await renderSales({ force: true });
        toast('Vendas atualizadas.', '↻');
      } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) {
          toast('Sessão expirada.', '⚠');
          showAdminLogin();
          return;
        }
        toast(err?.message || 'Falha ao atualizar.', '⚠');
      }
    });
  }

  const usersRefresh = document.getElementById('usersRefresh');
  if (usersRefresh && usersRefresh.dataset.bound !== '1') {
    usersRefresh.dataset.bound = '1';
    usersRefresh.addEventListener('click', async () => {
      invalidateUsersCache();
      try {
        await renderUsersTable({ force: true });
        toast('Usuários atualizados.', '↻');
      } catch (err) {
        if (err && (err.status === 401 || err.status === 403)) {
          toast('Sessão expirada.', '⚠');
          showAdminLogin();
          return;
        }
        toast(err?.message || 'Falha ao atualizar.', '⚠');
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Ações globais
// ─────────────────────────────────────────────────────────────
function bindGlobalActions() {
  const saveBtn = document.getElementById('adminSaveBtn');
  if (saveBtn && saveBtn.dataset.bound !== '1') {
    saveBtn.dataset.bound = '1';
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;
      saveBtn.textContent = '💾 Salvando...';

      try {
        const saved = await saveContent(AdminState.content, {
          baseVersion: AdminState.contentVersion
        });
        AdminState.contentVersion = saved.version;
        markClean();
        toast('Alterações salvas.', '💾');
      } catch (err) {
        console.error('[admin] save:', err);
        if (err?.code === 'VERSION_CONFLICT' || err?.status === 409) {
          toast('Alterado por outro admin. Recarregue.', '⚠');
        } else if (err?.status === 401 || err?.status === 403) {
          toast('Sessão expirada.', '⚠');
          showAdminLogin();
        } else {
          toast(err?.message || 'Não foi possível salvar.', '⚠');
        }
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = AdminState.dirty
          ? '💾 Salvar alterações *'
          : '💾 Salvar alterações';
      }
    });
  }

  const resetBtn = document.getElementById('adminResetBtn');
  if (resetBtn && resetBtn.dataset.bound !== '1') {
    resetBtn.dataset.bound = '1';
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Restaurar todo o conteúdo para o padrão?')) return;
      try {
        AdminState.content = JSON.parse(JSON.stringify(DEFAULT_CONTENT));
        await saveContent(AdminState.content, { baseVersion: AdminState.contentVersion });
        loadAllAdminFields();
        markClean();
        safeCall('applyContentToSite', AdminState.content);
        safeCall('refreshFlatPlaylist');
        safeCall('refreshPlanConfig');
        toast('Conteúdo restaurado.', '↺');
      } catch (err) {
        console.error('[admin] reset:', err);
        toast(err?.message || 'Falha ao restaurar.', '⚠');
      }
    });
  }

  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn && exportBtn.dataset.bound !== '1') {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', () => {
      const pack = {
        _version: AdminState.contentVersion,
        _exportedAt: new Date().toISOString(),
        content: AdminState.content
      };
      const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `joseph-matthos-content-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Exportado.', '⬇');
    });
  }

  const importFile = document.getElementById('importFile');
  if (importFile && importFile.dataset.bound !== '1') {
    importFile.dataset.bound = '1';
    importFile.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const text = await f.text();
        const parsed = JSON.parse(text);
        const data = parsed.content || parsed;
        AdminState.content = deepMerge(JSON.parse(JSON.stringify(DEFAULT_CONTENT)), data);
        await saveContent(AdminState.content, { baseVersion: AdminState.contentVersion });
        loadAllAdminFields();
        markClean();
        safeCall('applyContentToSite', AdminState.content);
        toast('Conteúdo importado.', '⬆');
      } catch (err) {
        console.error('[admin] import:', err);
        toast('Arquivo inválido.', '⚠');
      } finally {
        e.target.value = '';
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Previews
// ─────────────────────────────────────────────────────────────
function updateBgPreview(content = AdminState.content) {
  const el = document.getElementById('bgPreview');
  if (!el) return;
  const safe = safeMediaUrl(content?.branding?.bgImage);
  if (safe) {
    el.style.backgroundImage = `url('${safe}')`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = 'Sem imagem';
  }
}

function updateVinylPreview(content = AdminState.content) {
  const el = document.getElementById('vinylPreview');
  if (!el) return;
  const safe = safeMediaUrl(content?.hero?.vinyl?.image);
  if (safe) {
    el.style.backgroundImage = `url('${safe}')`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = 'Sem imagem';
  }
}

function updateSobrePreview(content = AdminState.content) {
  const el = document.getElementById('sobrePreview');
  if (!el) return;
  const safe = safeMediaUrl(content?.sobre?.image);
  if (safe) {
    el.style.backgroundImage = `url('${safe}')`;
    el.textContent = '';
  } else {
    el.style.backgroundImage = '';
    el.textContent = 'Sem imagem';
  }
}

// ─────────────────────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  if (Array.isArray(source)) return JSON.parse(JSON.stringify(source));
  if (!source || typeof source !== 'object') return source === undefined ? target : source;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

function safeCall(name, ...args) {
  const fn = window[name];
  if (typeof fn === 'function') {
    try { fn(...args); }
    catch (err) { console.warn(`[admin] ${name} falhou:`, err); }
  }
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// Expor rebind manual (útil para debug)
window.__adminRebind = () => {
  document.querySelectorAll('.admin-nav button').forEach((b) => delete b.dataset.bound);
  bindNavTabs();
  console.log('[admin] rebind manual executado');
};

Object.defineProperty(window, '__admin', {
  value: Object.freeze({
    get state() {
      try {
        return JSON.parse(JSON.stringify({
          version: AdminState.contentVersion,
          user: AdminState.user,
          dirty: AdminState.dirty,
          content: AdminState.content
        }));
      } catch {
        return { error: 'snapshot failed' };
      }
    },
    rebind: () => window.__adminRebind(),
    async reload() {
      const loaded = await loadContent();
      AdminState.content = loaded.data;
      AdminState.contentVersion = loaded.version;
      loadAllAdminFields();
      markClean();
    }
  }),
  writable: false,
  configurable: false
});
