/* ============================================================
   admin/index.js — Entrypoint do painel administrativo
   ------------------------------------------------------------
   - Atalho: Ctrl + Shift + A
   - Login via /api/admin?action=login (cookie __Host- assinado)
   - Nenhum dado de negócio em localStorage/IndexedDB
   - Conteúdo, usuários, vendas e uploads vêm do servidor
   - Sem onclick inline; tudo via addEventListener + data-*
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

// Re-export para compatibilidade
export { AdminState };

// ─────────────────────────────────────────────────────────────
// Títulos das abas
// ─────────────────────────────────────────────────────────────
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
  // ⚠️ Registra o atalho ANTES de qualquer API.
  // Assim, mesmo que /api/admin?action=content retorne 401 (usuário não logado),
  // o atalho Ctrl+Shift+A já está ativo e abre a tela de login.
  initAdminShortcuts();

  try {
    // Carrega conteúdo
    let loaded;
    try {
      loaded = await loadContent();
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        // Sessão inválida. O atalho já está registrado.
        // Não faz nada — o usuário aperta Ctrl+Shift+A quando quiser logar.
        console.warn('[admin] sessão inválida — Ctrl+Shift+A disponível');
        return;
      }
      throw err;
    }

    AdminState.content = loaded.data;
    AdminState.contentVersion = loaded.version;
    AdminState.contentUpdatedAt = loaded.updatedAt || null;

    // Aplica no site público
    safeCall('applyContentToSite', AdminState.content);
    safeCall('refreshFlatPlaylist');
    safeCall('refreshPlanConfig');
    safeCall('updateCartFab');

    // Preenche campos do admin
    loadAllAdminFields();

    // Binds (o atalho já foi registrado no começo)
    bindNavTabs();
    bindContentInputs();
    bindGlobalActions();
    bindEditorButtons();
    bindUploadZones();
    bindRefreshButtons();

    // Dashboard assíncrono
    renderDashboard().catch((err) => {
      if (err && (err.status === 401 || err.status === 403)) {
        console.warn('[admin] dashboard: sessão expirada');
        return;
      }
      console.warn('[admin] dashboard:', err);
    });
  } catch (err) {
    console.error('[admin] bootstrap falhou:', err);
    renderFatalError();
  }
}

// ─────────────────────────────────────────────────────────────
// Aplica conteúdo nos campos data-content
// ─────────────────────────────────────────────────────────────
function loadAllAdminFields() {
  const content = AdminState.content;
  if (!content) return;

  // Campos genéricos
  document.querySelectorAll('[data-content]').forEach((el) => {
    const val = getByPath(content, el.dataset.content);
    if (el.type === 'color') el.value = val || '#000000';
    else if (el.type === 'checkbox') el.checked = !!val;
    else el.value = val == null ? '' : val;
  });

  // Editores específicos
  renderFrasesEditor(content);
  renderAlbumsEditor(content);
  renderPlaylistsEditor(content);
  renderPlansEditor(content);
  renderSocialEditor(content);

  // Previews
  updateBgPreview(content);
  updateVinylPreview(content);
  updateSobrePreview(content);
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
// Navegação por abas
// ─────────────────────────────────────────────────────────────
function bindNavTabs() {
  document.querySelectorAll('.admin-nav button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.admin-nav button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.admin-section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');

      const tab = btn.dataset.tab;
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
          toast('Sessão expirada. Faça login novamente.', '⚠');
          showAdminLogin();
          return;
        }
        console.error(`[admin] tab ${tab}:`, err);
        toast(err?.message || `Erro ao carregar "${TAB_TITLES[tab] || tab}".`, '⚠');
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Botões dos editores específicos (+ Adicionar …)
// ─────────────────────────────────────────────────────────────
function bindEditorButtons() {
  bindAlbumsAddButton();
  bindPlaylistsAddButton();
  bindSocialsAddButton();

  const addFraseBtn = document.getElementById('addFraseBtn');
  if (addFraseBtn && addFraseBtn.dataset.bound !== '1') {
    addFraseBtn.dataset.bound = '1';
    addFraseBtn.addEventListener('click', () => {
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
// Upload zones (data-upload-target)
// ─────────────────────────────────────────────────────────────
function bindUploadZones() {
  // Faz as zonas clicáveis abrirem o file input correspondente
  document.querySelectorAll('[data-upload-target]').forEach((zone) => {
    if (zone.dataset.uploadBound === '1') return;
    zone.dataset.uploadBound = '1';

    zone.setAttribute('role', 'button');
    zone.setAttribute('tabindex', '0');

    const openInput = () => {
      const inputId = zone.dataset.uploadTarget;
      if (inputId) document.getElementById(inputId)?.click();
    };

    zone.addEventListener('click', openInput);
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openInput();
      }
    });
  });

  // Binds específicos — chamam uploadImage() e aplicam no content
  bindUpload('bgUpload', (url) => {
    AdminState.content.branding.bgImage = url;
    markDirty();
    updateBgPreview(AdminState.content);
    safeCall('applyContentToSite', AdminState.content);
    toast('Imagem de fundo atualizada.', '🖼');
  });

  bindUpload('vinylUpload', (url) => {
    if (!AdminState.content.hero.vinyl) AdminState.content.hero.vinyl = {};
    AdminState.content.hero.vinyl.image = url;
    markDirty();
    updateVinylPreview(AdminState.content);
    safeCall('applyContentToSite', AdminState.content);
    toast('Imagem do vinil atualizada.', '🖼');
  });

  bindUpload('sobreUpload', (url) => {
    AdminState.content.sobre.image = url;
    markDirty();
    updateSobrePreview(AdminState.content);
    safeCall('applyContentToSite', AdminState.content);
    toast('Imagem da seção Sobre atualizada.', '🖼');
  });

  // Upload de capa de álbum e áudios de faixa são feitos dentro do modal
  // de edição (admin/editors/albums.js), não aqui.
}

// ─────────────────────────────────────────────────────────────
// Botões de refresh (Vendas, Usuários)
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
// Ações globais (salvar, resetar, exportar, importar)
// ─────────────────────────────────────────────────────────────
function bindGlobalActions() {
  // ── Salvar
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
        // content.js já chama markClean() no sucesso.
        toast('Alterações salvas no servidor.', '💾');
      } catch (err) {
        console.error('[admin] save:', err);

        if (err?.code === 'VERSION_CONFLICT' || err?.status === 409) {
          toast('O conteúdo foi alterado por outro admin. Recarregue a página.', '⚠');
        } else if (err?.code === 'PAYLOAD_TOO_LARGE' || err?.status === 413) {
          toast('Conteúdo muito grande. Reduza imagens ou itens.', '⚠');
        } else if (err?.status === 401 || err?.status === 403) {
          toast('Sessão expirada. Faça login novamente.', '⚠');
          showAdminLogin();
        } else {
          toast(err?.message || 'Não foi possível salvar.', '⚠');
        }
      } finally {
        saveBtn.disabled = false;
        // Coerência visual do botão com o estado real
        saveBtn.textContent = AdminState.dirty
          ? '💾 Salvar alterações *'
          : '💾 Salvar alterações';
      }
    });
  }

  // ── Reset
  const resetBtn = document.getElementById('adminResetBtn');
  if (resetBtn && resetBtn.dataset.bound !== '1') {
    resetBtn.dataset.bound = '1';
    resetBtn.addEventListener('click', async () => {
      if (!confirm('Restaurar todo o conteúdo para o padrão do config.js?')) return;
      try {
        AdminState.content = JSON.parse(JSON.stringify(DEFAULT_CONTENT));
        await saveContent(AdminState.content, {
          baseVersion: AdminState.contentVersion
        });
        loadAllAdminFields();
        safeCall('applyContentToSite', AdminState.content);
        safeCall('refreshFlatPlaylist');
        safeCall('refreshPlanConfig');
        toast('Conteúdo restaurado.', '↺');
      } catch (err) {
        console.error('[admin] reset:', err);
        if (err?.status === 401 || err?.status === 403) {
          toast('Sessão expirada.', '⚠');
          showAdminLogin();
          return;
        }
        toast(err?.message || 'Falha ao restaurar.', '⚠');
      }
    });
  }

  // ── Export
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn && exportBtn.dataset.bound !== '1') {
    exportBtn.dataset.bound = '1';
    exportBtn.addEventListener('click', () => {
      const pack = {
        _version: AdminState.contentVersion,
        _exportedAt: new Date().toISOString(),
        content: AdminState.content
      };
      const blob = new Blob([JSON.stringify(pack, null, 2)], {
        type: 'application/json'
      });
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

  // ── Import
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
        AdminState.content = deepMerge(
          JSON.parse(JSON.stringify(DEFAULT_CONTENT)),
          data
        );
        await saveContent(AdminState.content, {
          baseVersion: AdminState.contentVersion
        });
        loadAllAdminFields();
        safeCall('applyContentToSite', AdminState.content);
        safeCall('refreshFlatPlaylist');
        safeCall('refreshPlanConfig');
        toast('Conteúdo importado.', '⬆');
      } catch (err) {
        console.error('[admin] import:', err);
        if (err?.status === 401 || err?.status === 403) {
          toast('Sessão expirada.', '⚠');
          showAdminLogin();
          return;
        }
        toast('Arquivo inválido.', '⚠');
      } finally {
        e.target.value = '';
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Previews (sanitizados via safeMediaUrl)
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
// Utilitários
// ─────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  if (Array.isArray(source)) return JSON.parse(JSON.stringify(source));
  if (!source || typeof source !== 'object') {
    return source === undefined ? target : source;
  }
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
    try {
      fn(...args);
    } catch (err) {
      console.warn(`[admin] ${name} falhou:`, err);
    }
  }
}

function renderFatalError() {
  document.body.innerHTML =
    '<div style="padding:2rem;text-align:center;color:#eee9e0;background:#0b0a0c;' +
    'font-family:sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;">' +
    '<div><h1 style="color:#d4af37;margin-bottom:1rem;">Erro ao carregar</h1>' +
    '<p>Abra o console (F12) para detalhes.</p>' +
    '<button id="fatalReload" style="margin-top:1rem;padding:0.5rem 1rem;' +
    'background:#d4af37;color:#0b0a0c;border:none;border-radius:6px;cursor:pointer;">' +
    'Recarregar</button></div></div>';

  const btn = document.getElementById('fatalReload');
  if (btn) btn.addEventListener('click', () => location.reload());
}

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

// ─────────────────────────────────────────────────────────────
// Debug (somente leitura)
// ─────────────────────────────────────────────────────────────
Object.defineProperty(window, '__admin', {
  value: Object.freeze({
    get state() {
      try {
        return JSON.parse(
          JSON.stringify({
            version: AdminState.contentVersion,
            user: AdminState.user,
            dirty: AdminState.dirty,
            content: AdminState.content
          })
        );
      } catch {
        return { error: 'snapshot failed' };
      }
    },
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
