/* ============================================================
   js/admin/editors/playlists.js — v4 (Versão Final)
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { migrateAllPlaylists, reportMigration, resolvePlaylistTracks, searchTracks } from '../playlists-api.js';

const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 500;
const MAX_COVER_LEN = 3;
const MAX_TRACKS = 300;

let _catalog = null;
let _catalogPromise = null;
let _contentError = false;

async function getCatalog({ force = false } = {}) {
  if (_catalog && !force) return _catalog;
  if (_catalogPromise && !force) return _catalogPromise;

  _catalogPromise = (async () => {
    try {
      const r = await fetch('/api/public', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      if (!Array.isArray(json?.albums)) throw new Error('Resposta inválida.');
      _contentError = !!json.contentError;
      _catalog = json.albums;
      return _catalog;
    } catch (err) {
      console.error('[playlists] catálogo indisponível:', err);
      throw err;
    } finally {
      _catalogPromise = null;
    }
  })();

  return _catalogPromise;
}

export function invalidatePlaylistCatalog() {
  _catalog = null;
  _contentError = false;
}

export async function renderPlaylistsEditor(content = AdminState.content) {
  const wrap = document.getElementById('playlistsEditor');
  if (!wrap) return;

  if (!Array.isArray(content.playlists)) content.playlists = [];

  let albums;
  try {
    albums = await getCatalog();
  } catch (err) {
    wrap.innerHTML = `
      <div class="admin-error-box">
        <p>Não foi possível carregar o catálogo de faixas.</p>
        <button type="button" class="btn btn-outline btn-sm" id="playlistRetryCatalog">Tentar novamente</button>
      </div>`;
    document.getElementById('playlistRetryCatalog')?.addEventListener('click', () => {
      invalidatePlaylistCatalog();
      renderPlaylistsEditor(content);
    });
    return;
  }

  const migration = reportMigration(content.playlists, albums);
  if (migration.pending > 0) {
    renderMigrationBanner(wrap, content, albums, migration);
    return;
  }

  paintList(wrap, content, albums);
}

function renderMigrationBanner(wrap, content, albums, report) {
  wrap.innerHTML = `
    <div class="admin-warning-box" style="padding:1rem;border:1px solid #f0a100;border-radius:8px;margin-bottom:1rem;background:rgba(240,161,0,0.05);">
      <strong>Migração pendente.</strong>
      <p style="margin:0.5rem 0;font-size:0.9rem;">${report.pending} referência(s) precisam ser atualizadas.</p>
      <button type="button" class="btn btn-primary btn-sm" id="playlistApplyMigration">Aplicar migração</button>
      <button type="button" class="btn btn-outline btn-sm" id="playlistSkipMigration">Ignorar</button>
    </div>
  `;
  document.getElementById('playlistApplyMigration')?.addEventListener('click', () => {
    content.playlists = migrateAllPlaylists(content.playlists, albums);
    markDirty();
    toast('Playlists migradas. Salve para confirmar.', '🔄');
    paintList(wrap, content, albums);
  });
  document.getElementById('playlistSkipMigration')?.addEventListener('click', () => {
    paintList(wrap, content, albums);
  });
}

function paintList(wrap, content, albums) {
  const playlists = content.playlists;
  const header = `
    <div class="playlists-editor__header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <span>${playlists.length} playlist(s)</span>
      <button type="button" class="btn btn-outline btn-sm" id="playlistAddTop">+ Nova playlist</button>
    </div>
  `;

  if (!playlists.length) {
    wrap.innerHTML = `${header}<p class="admin-empty">Nenhuma playlist ainda.</p>`;
    bindHeader(content, albums);
    return;
  }

  wrap.innerHTML = `
    ${header}
    <div class="playlists-editor__list">
      ${playlists.map((pl, i) => renderPlaylistCard(pl, i, playlists.length, albums)).join('')}
    </div>`;
  bindHeader(content, albums);
  bindCards(content, albums);
}

function renderPlaylistCard(pl, i, total, albums) {
  const resolved = resolvePlaylistTracks(pl, albums);
  const trackCount = resolved.length;
  const totalRefs = Array.isArray(pl.tracks) ? pl.tracks.length : 0;
  const missing = totalRefs - trackCount;

  return `
    <div class="track-editor playlist-editor" style="border:1px solid #333;padding:1rem;margin-bottom:1rem;border-radius:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>${esc(pl.title || 'Playlist')}</strong>
        <div>
          <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" style="color:#ff4d4d;">🗑</button>
        </div>
      </div>
      <div style="font-size:0.85rem;color:#888;margin-top:0.5rem;">
        ${trackCount} faixa(s) ${missing > 0 ? `· ${missing} pendente(s)` : ''}
      </div>
    </div>`;
}

function bindHeader(content, albums) {
  const addTop = document.getElementById('playlistAddTop');
  if (!addTop || addTop.dataset.bound === '1') return;
  addTop.dataset.bound = '1';
  addTop.addEventListener('click', () => addPlaylist(content, albums));
}

function bindCards(content, albums) {
  document.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    btn.addEventListener('click', () => openPlaylistModal(content, Number(btn.dataset.i), albums));
  });
  document.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => removePlaylist(content, Number(btn.dataset.i), albums));
  });
}

function makePlaylistId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `pl_${crypto.randomUUID()}`;
  return `pl_${Date.now().toString(36)}`;
}

function addPlaylist(content, albums) {
  content.playlists.push({ id: makePlaylistId(), title: 'Nova playlist', description: '', cover: '♪', tracks: [] });
  markDirty();
  paintList(document.getElementById('playlistsEditor'), content, albums);
  toast('Playlist adicionada. Lembre de salvar.', '🎵');
}

function removePlaylist(content, i, albums) {
  if (!window.confirm('Excluir esta playlist?')) return;
  content.playlists.splice(i, 1);
  markDirty();
  paintList(document.getElementById('playlistsEditor'), content, albums);
}

function openPlaylistModal(content, i, albums) {
  const pl = content.playlists[i];
  if (!pl) return;

  const draft = {
    title: pl.title || '',
    description: pl.description || '',
    cover: pl.cover || '♪',
    tracks: (Array.isArray(pl.tracks) ? pl.tracks : []).map(String)
  };

  openAdminModal(`
    <h3>Editar playlist</h3>
    <div class="form-group"><label>Nome *</label><input type="text" id="plTitle" value="${esc(draft.title)}"></div>
    <div class="form-group">
      <label>Faixas</label>
      <input type="search" id="plTrackSearch" placeholder="Buscar música..." style="width:100%;padding:0.8rem;background:#222;border:1px solid #444;color:#fff;border-radius:6px;">
      <div id="plSearchResults" class="playlist-search-results" hidden></div>
    </div>
    <div id="plTracksList" style="margin-top:1rem;max-height:300px;overflow-y:auto;"></div>
    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" id="plCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="plSave">Salvar</button>
    </div>
  `);

  const searchInput = document.getElementById('plTrackSearch');
  const resultsWrap = document.getElementById('plSearchResults');
  let searchDebounce;

  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      const q = searchInput.value.trim();
      if (!q) { resultsWrap.hidden = true; return; }
      const results = searchTracks(q, albums, 15);
      renderSearchResults(results);
    }, 200);
  });

  function renderSearchResults(results) {
    if (!results.length) {
      resultsWrap.innerHTML = '<p style="padding:0.6rem;color:#888;">Nenhuma faixa encontrada.</p>';
      resultsWrap.hidden = false;
      return;
    }
    resultsWrap.innerHTML = results.map((r) => `
      <button type="button" class="playlist-search-result" data-track-id="${esc(r.trackId)}" style="display:block;width:100%;text-align:left;padding:8px;background:#2a2a2a;border-bottom:1px solid #333;color:#fff;cursor:pointer;">
        <strong>${esc(r.title)}</strong><br>
        <small style="color:#888;">${esc(r.albumTitle)}</small>
      </button>
    `).join('');
    resultsWrap.hidden = false;

    resultsWrap.querySelectorAll('[data-track-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = String(btn.dataset.trackId);
        if (!draft.tracks.includes(id)) {
          draft.tracks.push(id);
          renderTrackList();
          resultsWrap.hidden = true;
        }
      });
    });
  }

  function renderTrackList() {
    const list = document.getElementById('plTracksList');
    const resolved = resolvePlaylistTracks({ tracks: draft.tracks }, albums);
    const byId = new Map(resolved.map((r) => [r.trackId, r]));

    list.innerHTML = draft.tracks.map((trackId, idx) => {
      const entry = byId.get(trackId);
      const title = entry ? entry.track.title : '(Pendente)';
      return `
        <div style="display:flex;justify-content:space-between;padding:8px;background:#1a1a1a;border:1px solid #333;margin-bottom:4px;border-radius:4px;">
          <span>${idx + 1}. ${esc(title)}</span>
          <button type="button" data-remove="${idx}" style="color:#ff4d4d;background:none;border:none;cursor:pointer;">X</button>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', () => {
        draft.tracks.splice(Number(b.dataset.remove), 1);
        renderTrackList();
      });
    });
  }

  renderTrackList();

  document.getElementById('plCancel').addEventListener('click', closeAdminModal);
  document.getElementById('plSave').addEventListener('click', () => {
    content.playlists[i] = { ...content.playlists[i], title: document.getElementById('plTitle').value.trim() || 'Sem título', tracks: draft.tracks };
    markDirty();
    closeAdminModal();
    paintList(document.getElementById('playlistsEditor'), content, albums);
    toast('Playlist atualizada.', '💾');
  });
}