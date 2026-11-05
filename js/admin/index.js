/* ============================================================
   js/admin/index.js — Entrypoint do painel administrativo
   ------------------------------------------------------------
   Correções aplicadas (auditoria final):
   - loadAdminContentAndRender retorna false em erro (sem throw)
   - saveBtn usa beginBusy + getDirtyRevision + markClean(revision)
   - resetBtn salva antes de alterar o estado e usa markClean(revision)
   - importFile valida tamanho/JSON/schema e usa markClean(revision)
   - setByPath tem retorno verificado em bindContentInputs
   - ensureContentStructure loga mutações em memória
   - exportFile protege JSON.stringify e revoga URL com setTimeout
   - rebindAdminUI() centraliza o rebind
   - __adminRebind protegido via Object.defineProperty
   ============================================================ */

import {
  AdminState,
  markDirty,
  markClean,
  getDirtyRevision,
  beginBusy
} from './state.js';

import {
  initAdminShortcuts,
  openAdminSite,
  openPublicSite,
  showAdminLogin
} from './auth.js';

import {
  loadContent,
  saveContent,
  validateContentSchema,
  normalizeContent
} from './content.js';

import { renderDashboard } from './dashboard.js';
import { renderUsersTable, invalidateUsersCache } from './users.js';
import { renderSales, invalidateSalesCache } from './sales.js';
import { bindUpload } from './uploads.js';
import { renderFrasesEditor } from './editors/frases.js';
import { renderAlbumsEditor } from './editors/albums.js';
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

  initAdminShortcuts();
  rebindAdminUI();

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('admin')) {
    setTimeout(() => { openAdminSite(); }, 0);
  }

  console.log('[admin] bootstrap completo');
}

function rebindAdminUI() {
  bindNavTabs();
  bindContentInputs();
  bindGlobalActions();
  bindEditorButtons();
  bindUploadZones();
  bindRefreshButtons();
}

// ─────────────────────────────────────────────────────────────
// Carregamento pós-login
// ------------------------------------------------------------
// Retorna true em sucesso, false em erro (não lança).
// ─────────────────────────────────────────────────────────────
export async function loadAdminContentAndRender() {
  console.log('[admin] carregando conteúdo pós-login...');

  try {
    const loaded = await loadContent();
    AdminState.content = loaded.data;
    AdminState.contentVersion = loaded.version;
    AdminState.contentUpdatedAt = loaded.updatedAt || null;
    console.log('[admin] conteúdo carregado, versão', loaded.version);
  } catch (err) {
    console.error('[admin] loadContent falhou:', err);

    if (err?.status === 401 || err?.status === 403) {
      showAdminLogin();
      return false;
    }

    toast(
      'Não foi possível carregar o conteúdo do servidor. ' +
      'O painel não será inicializado para evitar perda de dados.',
      '⚠'
    );

    return false;
  }

  safeCall('applyContentToSite', AdminState.content);
  safeCall('refreshFlatPlaylist');
  safeCall('refreshPlanConfig');
  safeCall('updateCartFab');

  loadAllAdminFields();

  renderDashboard().catch((err) => {
    if (err && (err.status === 401 || err.status === 403)) return;
    console.warn('[admin] dashboard:', err);
  });

  console.log('[admin] conteúdo aplicado e dashboard renderizado');

  return true;
}

// ─────────────────────────────────────────────────────────────
// Nav tabs
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

  attach();

  const nav = document.querySelector('.admin-nav');
  if (nav && !nav.dataset.observed) {
    nav.dataset.observed = '1';
    const observer = new MutationObserver(attach);
    observer.observe(nav, { childList: true, subtree: true });
  }
}

async function onClickNavButton(event) {
  const btn = event.currentTarget;
  const tab = btn.dataset.tab;
  if (!tab) return;

  const section = document.getElementById('tab-' + tab);
  if (!section) {
    console.warn(`[admin] tab ${tab} sem seção correspondente.`);
    return;
  }

  document.querySelectorAll('.admin-nav button').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.admin-section').forEach((s) => s.classList.remove('active'));
  btn.classList.add('active');
  section.classList.add('active');

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
    } else if (tab === 'discografia') {
      renderAlbumsEditor(AdminState.content);
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
// Campos
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
  try { fn(); }
  catch (err) { console.error(`[admin] erro em render${name}:`, err); }
}

function ensureContentStructure(content) {
  let mutated = false;

  if (!content.filosofia) { content.filosofia = {}; mutated = true; }
  if (!Array.isArray(content.filosofia.frases)) { content.filosofia.frases = []; mutated = true; }

  if (!content.discografia) { content.discografia = {}; mutated = true; }
  if (!Array.isArray(content.discografia.albums)) { content.discografia.albums = []; mutated = true; }

  if (!Array.isArray(content.playlists)) { content.playlists = []; mutated = true; }

  if (!content.planos) { content.planos = {}; mutated = true; }
  if (!Array.isArray(content.planos.plans)) { content.planos.plans = []; mutated = true; }

  if (!content.contato) { content.contato = {}; mutated = true; }
  if (!Array.isArray(content.contato.socials)) { content.contato.socials = []; mutated = true; }

  if (!content.branding) { content.branding = {}; mutated = true; }
  if (!content.hero) { content.hero = {}; mutated = true; }
  if (!content.sobre) { content.sobre = {}; mutated = true; }
  if (!content.aparencia) { content.aparencia = {}; mutated = true; }

  if (mutated) {
    console.warn('[admin] estrutura de conteúdo corrigida em memória.');
  }
}

function bindContentInputs() {
  document.querySelectorAll('[data-content]').forEach((el) => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';

    el.addEventListener('input', () => {
      let val = el.value;
      if (el.type === 'checkbox') val = el.checked;
      else if (el.type === 'number') {
        if (val === '') val = null;
        else val = parseFloat(val);
      }

      const updated = setByPath(AdminState.content, el.dataset.content, val);

      if (!updated) {
        console.error('[admin] caminho de conteúdo inválido:', el.dataset.content);
        return;
      }

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
// Editores
// ─────────────────────────────────────────────────────────────
function bindEditorButtons() {
  try { bindPlaylistsAddButton(); } catch (e) { console.warn(e); }
  try { bindSocialsAddButton(); } catch (e) { console.warn(e); }

  const addFraseBtn = document.getElementById('addFraseBtn');
  if (addFraseBtn && addFraseBtn.dataset.bound !== '1') {
    addFraseBtn.dataset.bound = '1';
    addFraseBtn.addEventListener('click', () => {
      if (!AdminState.content) return;
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
// Uploads (imagens)
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
    bindUpload('bgUpload', ({ url }) => {
      if (!url) return;
      if (!AdminState.content.branding) AdminState.content.branding = {};
      AdminState.content.branding.bgImage = url;
      markDirty();
      updateBgPreview(AdminState.content);
      safeCall('applyContentToSite', AdminState.content);
      toast('Imagem de fundo atualizada.', '🖼');
    }, 'image');
  } catch (e) { console.warn(e); }

  try {
    bindUpload('vinylUpload', ({ url }) => {
      if (!url) return;
      if (!AdminState.content.hero) AdminState.content.hero = {};
      if (!AdminState.content.hero.vinyl) AdminState.content.hero.vinyl = {};
      AdminState.content.hero.vinyl.image = url;
      markDirty();
      updateVinylPreview(AdminState.content);
      safeCall('applyContentToSite', AdminState.content);
      toast('Imagem do vinil atualizada.', '🖼');
    }, 'image');
  } catch (e) { console.warn(e); }

  try {
    bindUpload('sobreUpload', ({ url }) => {
      if (!url) return;
      if (!AdminState.content.sobre) AdminState.content.sobre = {};
      AdminState.content.sobre.image = url;
      markDirty();
      updateSobrePreview(AdminState.content);
      safeCall('applyContentToSite', AdminState.content);
      toast('Imagem da seção Sobre atualizada.', '🖼');
    }, 'image');
  } catch (e) { console.warn(e); }
}

// ─────────────────────────────────────────────────────────────
// Refresh
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
  // ── Save
  const saveBtn = document.getElementById('adminSaveBtn');
  if (saveBtn && saveBtn.dataset.bound !== '1') {
    saveBtn.dataset.bound = '1';
    saveBtn.addEventListener('click', async () => {
      if (saveBtn.disabled) return;

      const revisionAtStart = getDirtyRevision();
      const releaseBusy = beginBusy('salvando');

      try {
        const saved = await saveContent(AdminState.content, {
          baseVersion: AdminState.contentVersion
        });
        AdminState.contentVersion = saved.version;
        AdminState.contentUpdatedAt = saved.updatedAt || new Date().toISOString();

        const cleaned = markClean(revisionAtStart);

        if (cleaned) {
          toast('Alterações salvas.', '💾');
        } else {
          toast('Alterações salvas, mas você modificou o conteúdo durante o salvamento.', '⚠');
        }
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
        releaseBusy();
      }
    });
  }

  // ── Reset
  const resetBtn = document.getElementById('adminResetBtn');
  if (resetBtn && resetBtn.dataset.bound !== '1') {
    resetBtn.dataset.bound = '1';
    resetBtn.addEventListener('click', async () => {
      const confirmed = confirm(
        'Restaurar todo o conteúdo editorial para o padrão?\n\n' +
        'Essa operação substituirá as alterações atuais.'
      );
      if (!confirmed) return;

      resetBtn.disabled = true;
      const revisionAtStart = getDirtyRevision();
      const releaseBusy = beginBusy('restaurando');

      try {
        const defaults = JSON.parse(JSON.stringify(DEFAULT_CONTENT));
        const saved = await saveContent(defaults, {
          baseVersion: AdminState.contentVersion
        });

        AdminState.content = defaults;
        AdminState.contentVersion = saved.version;
        AdminState.contentUpdatedAt = saved.updatedAt || new Date().toISOString();

        loadAllAdminFields();

        const cleaned = markClean(revisionAtStart);
        if (!cleaned) {
          toast('Conteúdo restaurado, mas você modificou durante o processo.', '⚠');
        } else {
          toast('Conteúdo padrão restaurado.', '↺');
        }

        safeCall('applyContentToSite', AdminState.content);
        safeCall('refreshFlatPlaylist');
        safeCall('refreshPlanConfig');
      } catch (err) {
        console.error('[admin] reset:', err);
        toast(
          err?.status === 409
            ? 'O conteúdo foi alterado por outro administrador. Recarregue.'
            : err?.message || 'Falha ao restaurar o conteúdo.',
          '⚠'
        );
      } finally {
        releaseBusy();
        resetBtn.disabled = false;
      }
    });
  }

  // ── Export
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn && exportBtn.dataset.bound !== '1') {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', () => {
      if (!AdminState.content || AdminState.dirty) {
        toast('Salve as alterações antes de exportar o backup.', '⚠');
        return;
      }

      const pack = {
        schemaVersion: 1,
        application: 'Joseph Matthos',
        _version: AdminState.contentVersion,
        _exportedAt: new Date().toISOString(),
        content: AdminState.content
      };

      let json;
      try {
        json = JSON.stringify(pack, null, 2);
      } catch (e) {
        console.error('[admin] export falhou:', e);
        toast('Conteúdo não serializável. Contate o suporte.', '⚠');
        return;
      }

      const blob = new Blob(
        [json],
        { type: 'application/json;charset=utf-8' }
      );

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');

      a.href = url;
      a.download = `joseph-matthos-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast('Backup editorial exportado.', '⬇');
    });
  }

  // ── Import
  const importFile = document.getElementById('importFile');
  if (importFile && importFile.dataset.bound !== '1') {
    importFile.dataset.bound = '1';
    importFile.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const releaseBusy = beginBusy('importando');

      try {
        if (file.size > 2_000_000) {
          throw new Error('O arquivo ultrapassa o limite de 2 MB.');
        }

        if (!file.name.toLowerCase().endsWith('.json')) {
          throw new Error('Selecione um arquivo JSON.');
        }

        const text = await file.text();
        const parsed = JSON.parse(text);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Estrutura de backup inválida.');
        }

        const data = parsed.content || parsed;
        const validation = validateContentSchema(data);

        if (!validation.valid) {
          throw new Error('Backup inválido: ' + validation.errors.join(' '));
        }

        const normalized = normalizeContent(validation.data);
        const bytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;

        if (bytes > 2_000_000) {
          throw new Error('O conteúdo importado ultrapassa 2 MB.');
        }

        const confirmed = confirm(
          'Deseja importar este backup?\n\n' +
          'O conteúdo editorial atual será substituído. ' +
          'Recomenda-se exportar um backup antes de continuar.'
        );

        if (!confirmed) return;

        const revisionAtStart = getDirtyRevision();

        const saved = await saveContent(normalized, {
          baseVersion: AdminState.contentVersion
        });

        AdminState.content = normalized;
        AdminState.contentVersion = saved.version;
        AdminState.contentUpdatedAt = saved.updatedAt || new Date().toISOString();

        loadAllAdminFields();

        const cleaned = markClean(revisionAtStart);
        if (!cleaned) {
          toast('Backup importado, mas você modificou durante o processo.', '⚠');
        } else {
          toast('Backup importado e salvo com sucesso.', '⬆');
        }

        safeCall('applyContentToSite', AdminState.content);
        safeCall('refreshFlatPlaylist');
        safeCall('refreshPlanConfig');
      } catch (err) {
        console.error('[admin] import:', err);
        if (err?.status === 409) {
          toast('O conteúdo foi alterado por outro administrador. Recarregue antes de importar.', '⚠');
        } else if (err?.status === 401 || err?.status === 403) {
          toast('Sessão expirada.', '⚠');
          showAdminLogin();
        } else {
          toast(err?.message || 'Não foi possível importar o backup.', '⚠');
        }
      } finally {
        releaseBusy();
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

Object.defineProperty(window, '__adminRebind', {
  value: () => {
    rebindAdminUI();
    console.log('[admin] rebind executado');
  },
  writable: false,
  configurable: false
});

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
      return await loadAdminContentAndRender();
    },
    bootContent: () => loadAdminContentAndRender()
  }),
  writable: false,
  configurable: false
});