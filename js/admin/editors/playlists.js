/* ============================================================
   admin/editors/playlists.js — Editor de playlists (v3 auditada)
   ------------------------------------------------------------
   Correções aplicadas (auditoria):
   - getCatalog() usa normalizeCatalog(albums, tracks)
   - IDs são UUID (string), nunca Number()
   - byId usa String(trackId) como chave
   - needsMigration só considera strings com ":" (formato legado)
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import {
  normalizeCatalog,
  migrateAllPlaylists,
  migratePlaylistTracks,
  resolvePlaylistTracks,
  searchTracks
} from '../playlists-api.js';

// ─────────────────────────────────────────────────────────────
// Catálogo (carregado uma vez)
// ─────────────────────────────────────────────────────────────
let _catalog = null;

/**
 * Carrega o catálogo de álbuns/faixas via /api/public.
 * Normaliza usando normalizeCatalog(albums, tracks).
 */
async function getCatalog() {
  if (_catalog) return _catalog;

  try {
    const response = await fetch('/api/public', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`Falha ao carregar catálogo: HTTP ${response.status}`);
    }

    const json = await response.json();

    if (json?.ok !== true) {
      throw new Error(json?.error || 'Resposta inválida do catálogo.');
    }

    _catalog = normalizeCatalog(
      json.albums || [],
      json.tracks || []
    );

    return _catalog;
  } catch (err) {
    console.error('[playlists] catálogo indisponível:', err);
    _catalog = null;
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Render — lista
// ─────────────────────────────────────────────────────────────
export async function renderPlaylistsEditor(content = AdminState.content) {
  const wrap = document.getElementById('playlistsEditor');
  if (!wrap) return;

  if (!Array.isArray(content.playlists)) content.playlists = [];

  let albums = [];
  try {
    albums = await getCatalog();
  } catch (err) {
    console.warn('[playlists] catálogo indisponível; edição sem resolver faixas:', err);
  }

  // ★ Migração apenas de refs legadas (albumId:index)
  const needsMigration = content.playlists.some(pl =>
    Array.isArray(pl.tracks) &&
    pl.tracks.some(track =>
      typeof track === 'string' && track.includes(':')
    )
  );

  if (needsMigration && albums.length) {
    content.playlists = migrateAllPlaylists(content.playlists, albums);
    markDirty();
    toast('Playlists migradas para IDs de faixa. Salve para confirmar.', '🔄');
  }

  const playlists = content.playlists;

  const header = `
    <div class="playlists-editor__header">
      <span class="playlists-editor__count">
        ${playlists.length} playlist${playlists.length === 1 ? '' : 's'}
      </span>
      <button type="button" class="btn btn-outline btn-sm" id="playlistAddTop">
        + Nova playlist
      </button>
    </div>
  `;

  if (!playlists.length) {
    wrap.innerHTML = `
      ${header}
      <p class="admin-empty">
        Nenhuma playlist ainda. Clique em "Nova playlist" para começar.
      </p>`;
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
  const missing = (pl.tracks || []).length - trackCount;

  const preview = resolved.slice(0, 3).map((r) =>
    `<span class="playlist-preview__track">${esc(r.track.title)}</span>`
  ).join('');

  const moreCount = resolved.length > 3 ? resolved.length - 3 : 0;

  return `
    <div class="track-editor playlist-editor" data-i="${i}">
      <div class="track-head">
        <div class="playlist-editor__order">
          <button type="button" class="playlist-order-btn" data-action="move-up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
          <button type="button" class="playlist-order-btn" data-action="move-down" data-i="${i}" ${i === total - 1 ? 'disabled' : ''} title="Descer">↓</button>
          <strong>${esc(pl.title || 'Playlist')}</strong>
          <span class="playlist-editor__badge">${esc(pl.cover || '♪')}</span>
        </div>
        <div class="playlist-editor__actions">
          <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" style="color:var(--danger);">🗑</button>
        </div>
      </div>

      ${pl.description ? `<div class="playlist-editor__desc">${esc(pl.description)}</div>` : ''}

      <div class="playlist-editor__stats">
        <span><strong>${trackCount}</strong> faixa${trackCount === 1 ? '' : 's'}</span>
        ${missing > 0 ? `<span style="color:var(--warning,#f0a100);">· ${missing} referência${missing === 1 ? '' : 's'} inválida${missing === 1 ? '' : 's'}</span>` : ''}
      </div>

      ${trackCount > 0 ? `
        <div class="playlist-preview">
          ${preview}
          ${moreCount > 0 ? `<span class="playlist-preview__more">+${moreCount}</span>` : ''}
        </div>
      ` : ''}
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// Binds
// ─────────────────────────────────────────────────────────────
function bindHeader(content, albums) {
  const addTop = document.getElementById('playlistAddTop');
  if (addTop && addTop.dataset.bound !== '1') {
    addTop.dataset.bound = '1';
    addTop.addEventListener('click', () => addPlaylist(content, albums));
  }
}

function bindCards(content, albums) {
  document.querySelectorAll('[data-action="edit"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      openPlaylistModal(content, Number(btn.dataset.i), albums);
    });
  });

  document.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => removePlaylist(content, Number(btn.dataset.i)));
  });

  document.querySelectorAll('[data-action="move-up"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => movePlaylist(content, Number(btn.dataset.i), -1));
  });

  document.querySelectorAll('[data-action="move-down"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => movePlaylist(content, Number(btn.dataset.i), +1));
  });
}

// ─────────────────────────────────────────────────────────────
// Ações
// ─────────────────────────────────────────────────────────────
function addPlaylist(content, albums) {
  content.playlists.push({
    id: 'playlist-' + Date.now().toString(36),
    title: 'Nova playlist',
    description: '',
    cover: '♪',
    tracks: []
  });
  markDirty();
  renderPlaylistsEditor(content);
  toast('Playlist adicionada. Lembre de salvar.', '🎵');
}

function removePlaylist(content, i) {
  const pl = content.playlists[i];
  if (!pl) return;

  const msg = pl.title
    ? `Excluir a playlist "${pl.title}"?`
    : 'Excluir esta playlist?';
  if (!window.confirm(msg)) return;

  content.playlists.splice(i, 1);
  markDirty();
  renderPlaylistsEditor(content);
  toast('Playlist removida. Lembre de salvar.', '🗑');
}

function movePlaylist(content, i, delta) {
  const arr = content.playlists;
  const target = i + delta;
  if (target < 0 || target >= arr.length) return;
  [arr[i], arr[target]] = [arr[target], arr[i]];
  markDirty();
  renderPlaylistsEditor(content);
}

// ─────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────
function openPlaylistModal(content, i, albums) {
  const pl = content.playlists[i];
  if (!pl) return;

  const draft = {
    title: pl.title || '',
    description: pl.description || '',
    cover: pl.cover || '♪',
    tracks: Array.isArray(pl.tracks) ? pl.tracks.map(t => String(t)) : []
  };

  openAdminModal(`
    <h3>Editar playlist</h3>

    <div class="form-row">
      <div class="form-group">
        <label for="plTitle">Nome *</label>
        <input type="text" id="plTitle" value="${esc(draft.title)}" required>
      </div>
      <div class="form-group">
        <label for="plCover">Capa (até 3 caracteres)</label>
        <input type="text" id="plCover" maxlength="3" value="${esc(draft.cover)}">
      </div>
    </div>

    <div class="form-group">
      <label for="plDescription">Descrição</label>
      <input type="text" id="plDescription" value="${esc(draft.description)}">
    </div>

    <div class="form-group">
      <label>Faixas</label>
      <input type="search"
             id="plTrackSearch"
             class="shop-search"
             placeholder="Buscar faixa por título ou álbum..."
             autocomplete="off">
      <div id="plSearchResults" class="playlist-search-results" hidden></div>
    </div>

    <div id="plTracksList" class="playlist-tracks-list"></div>

    <p class="hint" style="color:var(--text-dim);font-size:0.78rem;margin-top:0.8rem;">
      As faixas são referenciadas por ID (imutável). Mesmo se o álbum for
      reordenado, a playlist continua correta.
    </p>

    <div class="form-error" id="plError" role="alert"></div>

    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" id="plCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="plSave">Salvar</button>
    </div>
  `);

  renderTrackList();

  const searchInput = document.getElementById('plTrackSearch');
  const resultsWrap = document.getElementById('plSearchResults');
  let searchDebounce;

  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      const q = searchInput.value.trim();
      if (!q) {
        resultsWrap.hidden = true;
        resultsWrap.innerHTML = '';
        return;
      }
      const results = searchTracks(q, albums, 15);
      renderSearchResults(results);
    }, 200);
  });

  document.addEventListener('click', (e) => {
    if (!resultsWrap.contains(e.target) && e.target !== searchInput) {
      resultsWrap.hidden = true;
    }
  });

  function renderSearchResults(results) {
    if (!results.length) {
      resultsWrap.innerHTML = '<p class="hint" style="padding:0.6rem;color:var(--text-dim);">Nenhuma faixa encontrada.</p>';
      resultsWrap.hidden = false;
      return;
    }

    resultsWrap.innerHTML = results.map((r) => {
      const already = draft.tracks.includes(String(r.trackId));
      return `
        <button type="button"
                class="playlist-search-result"
                data-track-id="${esc(r.trackId)}"
                ${already ? 'disabled' : ''}>
          <span class="playlist-search-result__title">${esc(r.title)}</span>
          <span class="playlist-search-result__album">${esc(r.albumTitle)} · ${esc(r.duration)}</span>
          ${already ? '<span class="playlist-search-result__added">já adicionada</span>' : '<span class="playlist-search-result__add">+ Adicionar</span>'}
        </button>`;
    }).join('');
    resultsWrap.hidden = false;

    resultsWrap.querySelectorAll('[data-track-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;

        // ★ String, nunca Number
        const id = String(btn.dataset.trackId || '').trim();
        if (!id) return;

        if (!draft.tracks.includes(id)) {
          draft.tracks.push(id);
          renderTrackList();

          const q = searchInput.value.trim();
          if (q) renderSearchResults(searchTracks(q, albums, 15));
        }
      });
    });
  }

  function renderTrackList() {
    const list = document.getElementById('plTracksList');
    if (!list) return;

    if (!draft.tracks.length) {
      list.innerHTML = '<p class="hint" style="color:var(--text-dim);text-align:center;padding:1rem;">Nenhuma faixa adicionada ainda. Use a busca acima.</p>';
      return;
    }

    const resolved = resolvePlaylistTracks({ tracks: draft.tracks }, albums);
    const byId = new Map(resolved.map((r) => [String(r.trackId), r]));

    list.innerHTML = draft.tracks.map((trackId, idx) => {
      const entry = byId.get(String(trackId));
      const title = entry ? entry.track.title : '(faixa não encontrada)';
      const album = entry ? entry.album.title : '—';
      const duration = entry ? (entry.track.duration || '—') : '—';
      const missing = !entry;

      return `
        <div class="playlist-track-item ${missing ? 'is-missing' : ''}">
          <div class="playlist-track-item__order">
            <button type="button" class="playlist-order-btn" data-action="track-up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
            <button type="button" class="playlist-order-btn" data-action="track-down" data-idx="${idx}" ${idx === draft.tracks.length - 1 ? 'disabled' : ''}>↓</button>
          </div>
          <div class="playlist-track-item__info">
            <div class="playlist-track-item__title">${esc(title)}</div>
            <div class="playlist-track-item__meta">${esc(album)} · ${esc(duration)}</div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="track-remove" data-idx="${idx}" style="color:var(--danger);">Remover</button>
        </div>`;
    }).join('');

    list.querySelectorAll('[data-action="track-up"]').forEach((b) => {
      b.addEventListener('click', () => moveTrack(Number(b.dataset.idx), -1));
    });
    list.querySelectorAll('[data-action="track-down"]').forEach((b) => {
      b.addEventListener('click', () => moveTrack(Number(b.dataset.idx), +1));
    });
    list.querySelectorAll('[data-action="track-remove"]').forEach((b) => {
      b.addEventListener('click', () => removeTrack(Number(b.dataset.idx)));
    });
  }

  function moveTrack(idx, delta) {
    const target = idx + delta;
    if (target < 0 || target >= draft.tracks.length) return;
    [draft.tracks[idx], draft.tracks[target]] = [draft.tracks[target], draft.tracks[idx]];
    renderTrackList();
  }

  function removeTrack(idx) {
    draft.tracks.splice(idx, 1);
    renderTrackList();
  }

  document.getElementById('plCancel').addEventListener('click', closeAdminModal);

  document.getElementById('plSave').addEventListener('click', () => {
    const errEl = document.getElementById('plError');
    const title = document.getElementById('plTitle').value.trim();
    if (!title) {
      errEl.textContent = 'Nome obrigatório.';
      return;
    }

    content.playlists[i] = {
      ...content.playlists[i],
      title,
      cover: document.getElementById('plCover').value.trim() || '♪',
      description: document.getElementById('plDescription').value.trim(),
      tracks: [...draft.tracks]
    };

    markDirty();
    renderPlaylistsEditor(content);
    closeAdminModal();
    toast('Playlist atualizada. Lembre de salvar.', '💾');
  });
}

// ─────────────────────────────────────────────────────────────
// Compat
// ─────────────────────────────────────────────────────────────
export function bindPlaylistsAddButton() {
  const btn = document.getElementById('addPlaylistBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => addPlaylist(AdminState.content, _catalog || []));
}