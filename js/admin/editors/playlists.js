/* ============================================================
   js/admin/editors/playlists.js — v4 (Versão Final Absoluta)
   ------------------------------------------------------------
   - IDs de faixas tratados estritamente como String (UUID)
   - Integração com /api/public (albums com tracks aninhadas)
   - Bloqueio de salvamento se o catálogo (siteContent) falhar
   - Migração de referências antigas NÃO destrutiva
   - Uso de AbortController para limpar listeners do modal
   - Validação completa de campos (limites, duplicatas)
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import {
  migrateAllPlaylists,
  reportMigration,
  resolvePlaylistTracks,
  searchTracks
} from '../playlists-api.js';

// ─────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────
const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 500;
const MAX_COVER_LEN = 3;
const MAX_TRACKS = 300;

// ─────────────────────────────────────────────────────────────
// Catálogo (Cache e Tratamento de Erros)
// ─────────────────────────────────────────────────────────────
let _catalog = null;
let _catalogPromise = null;
let _contentError = false; // Flag para bloquear salvamento se o siteContent falhar

async function getCatalog({ force = false } = {}) {
  if (_catalog && !force) return _catalog;
  if (_catalogPromise && !force) return _catalogPromise;

  _catalogPromise = (async () => {
    try {
      const r = await fetch('/api/public', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);

      const json = await r.json();
      if (!Array.isArray(json?.albums)) throw new Error('Resposta de catálogo inválida.');

      // O novo /api/public sinaliza se houve erro ao ler o banco
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

// ─────────────────────────────────────────────────────────────
// Render — Lista principal
// ─────────────────────────────────────────────────────────────
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
        <p style="font-size:0.8rem;color:var(--text-dim);">${esc(err?.message || '')}</p>
        <button type="button" class="btn btn-outline btn-sm" id="playlistRetryCatalog">Tentar novamente</button>
      </div>`;
    document.getElementById('playlistRetryCatalog')?.addEventListener('click', () => {
      invalidatePlaylistCatalog();
      renderPlaylistsEditor(content);
    });
    return;
  }

  // Relatório de migração (NÃO aplica sozinho)
  const migration = reportMigration(content.playlists, albums);
  if (migration.pending > 0) {
    renderMigrationBanner(wrap, content, albums, migration);
    return;
  }

  paintList(wrap, content, albums);
}

function renderMigrationBanner(wrap, content, albums, report) {
  wrap.innerHTML = `
    <div class="admin-warning-box" style="padding:1rem;border:1px solid var(--warning,#f0a100);border-radius:8px;margin-bottom:1rem;background:rgba(240,161,0,0.05);">
      <strong>Migração de playlists pendente.</strong>
      <p style="margin:0.5rem 0;font-size:0.9rem;">
        ${report.pending} referência(s) de faixa precisam ser atualizadas para UUIDs.
        Referências antigas serão preservadas como <code>legacy:*</code> — nada será apagado sem confirmação.
      </p>
      <details style="font-size:0.85rem;margin-bottom:0.5rem;">
        <summary>Ver detalhes por playlist</summary>
        <ul style="margin:0.5rem 0 0 1rem;">
          ${report.playlists.map(p => `
            <li><strong>${esc(p.title || '(sem título)')}</strong> — ${p.resolvable} resolvível(eis), ${p.pending} pendente(s)</li>
          `).join('')}
        </ul>
      </details>
      <div style="display:flex;gap:0.5rem;">
        <button type="button" class="btn btn-primary btn-sm" id="playlistApplyMigration">Aplicar migração (segura)</button>
        <button type="button" class="btn btn-outline btn-sm" id="playlistSkipMigration">Ignorar por enquanto</button>
      </div>
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
    <div class="playlists-editor__header">
      <span class="playlists-editor__count">
        ${playlists.length} playlist${playlists.length === 1 ? '' : 's'}
      </span>
      <button type="button" class="btn btn-outline btn-sm" id="playlistAddTop">+ Nova playlist</button>
    </div>
  `;

  if (!playlists.length) {
    wrap.innerHTML = `${header}<p class="admin-empty">Nenhuma playlist ainda. Clique em "Nova playlist" para começar.</p>`;
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
        ${missing > 0 ? `<span style="color:var(--warning,#f0a100);">· ${missing} referência${missing === 1 ? '' : 's'} pendente${missing === 1 ? '' : 's'}</span>` : ''}
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
// Binds e Ações da Lista
// ─────────────────────────────────────────────────────────────
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
  document.querySelectorAll('[data-action="move-up"]').forEach((btn) => {
    btn.addEventListener('click', () => movePlaylist(content, Number(btn.dataset.i), -1, albums));
  });
  document.querySelectorAll('[data-action="move-down"]').forEach((btn) => {
    btn.addEventListener('click', () => movePlaylist(content, Number(btn.dataset.i), +1, albums));
  });
}

function makePlaylistId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `pl_${crypto.randomUUID()}`;
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function addPlaylist(content, albums) {
  if (!Array.isArray(content.playlists)) content.playlists = [];
  content.playlists.push({
    id: makePlaylistId(),
    title: 'Nova playlist',
    description: '',
    cover: '♪',
    tracks: []
  });
  markDirty();
  paintList(document.getElementById('playlistsEditor'), content, albums);
  toast('Playlist adicionada. Lembre de salvar.', '🎵');
}

function removePlaylist(content, i, albums) {
  const pl = content.playlists[i];
  if (!pl) return;

  const msg = pl.title ? `Excluir a playlist "${pl.title}"?` : 'Excluir esta playlist?';
  if (!window.confirm(msg)) return;

  content.playlists.splice(i, 1);
  markDirty();
  paintList(document.getElementById('playlistsEditor'), content, albums);
  toast('Playlist removida. Lembre de salvar.', '🗑');
}

function movePlaylist(content, i, delta, albums) {
  const arr = content.playlists;
  const target = i + delta;
  if (!Number.isInteger(i) || target < 0 || target >= arr.length) return;
  [arr[i], arr[target]] = [arr[target], arr[i]];
  markDirty();
  paintList(document.getElementById('playlistsEditor'), content, albums);
}

// ─────────────────────────────────────────────────────────────
// Modal de Edição
// ─────────────────────────────────────────────────────────────
function openPlaylistModal(content, i, albums) {
  const pl = content.playlists[i];
  if (!pl) return;

  // Normaliza faixas existentes para string
  const initialTracks = (Array.isArray(pl.tracks) ? pl.tracks : [])
    .map((ref) => String(ref ?? '').trim())
    .filter(Boolean);

  const draft = {
    title: pl.title || '',
    description: pl.description || '',
    cover: pl.cover || '♪',
    tracks: initialTracks
  };

  openAdminModal(`
    <h3>Editar playlist</h3>

    <div class="form-row">
      <div class="form-group">
        <label for="plTitle">Nome *</label>
        <input type="text" id="plTitle" maxlength="${MAX_TITLE_LEN}" value="${esc(draft.title)}" required>
      </div>
      <div class="form-group">
        <label for="plCover">Capa (até ${MAX_COVER_LEN})</label>
        <input type="text" id="plCover" maxlength="${MAX_COVER_LEN}" value="${esc(draft.cover)}">
      </div>
    </div>

    <div class="form-group">
      <label for="plDescription">Descrição</label>
      <input type="text" id="plDescription" maxlength="${MAX_DESC_LEN}" value="${esc(draft.description)}">
    </div>

    <div class="form-group">
      <label>Faixas (máx ${MAX_TRACKS})</label>
      <input type="search" id="plTrackSearch" class="shop-search" placeholder="Buscar faixa por título ou álbum..." autocomplete="off">
      <div id="plSearchResults" class="playlist-search-results" hidden></div>
    </div>

    <div id="plTracksList" class="playlist-tracks-list"></div>

    <div class="form-error" id="plError" role="alert"></div>

    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" id="plCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="plSave">Salvar</button>
    </div>
  `);

  // AbortController para limpar listeners ao fechar o modal
  const ac = new AbortController();
  const { signal } = ac;

  document.addEventListener('click', (e) => {
    if (!resultsWrap.contains(e.target) && e.target !== searchInput) {
      resultsWrap.hidden = true;
    }
  }, { signal });

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
  }, { signal });

  function renderSearchResults(results) {
    if (!results.length) {
      resultsWrap.innerHTML = '<p class="hint" style="padding:0.6rem;color:var(--text-dim);">Nenhuma faixa encontrada.</p>';
      resultsWrap.hidden = false;
      return;
    }

    resultsWrap.innerHTML = results.map((r) => {
      const already = draft.tracks.includes(r.trackId);
      return `
        <button type="button" class="playlist-search-result" data-track-id="${esc(r.trackId)}" ${already ? 'disabled' : ''}>
          <span class="playlist-search-result__title">${esc(r.title)}</span>
          <span class="playlist-search-result__album">${esc(r.albumTitle)} · ${esc(r.duration)}</span>
          ${already ? '<span class="playlist-search-result__added">já adicionada</span>' : '<span class="playlist-search-result__add">+ Adicionar</span>'}
        </button>`;
    }).join('');
    resultsWrap.hidden = false;

    resultsWrap.querySelectorAll('[data-track-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        const id = String(btn.dataset.trackId || '').trim();
        if (!id) return;

        if (draft.tracks.length >= MAX_TRACKS) {
          toast(`Máximo de ${MAX_TRACKS} faixas por playlist.`, '⚠');
          return;
        }
        if (draft.tracks.some((t) => String(t) === id)) return;

        draft.tracks.push(id);
        renderTrackList();

        const q = searchInput.value.trim();
        if (q) renderSearchResults(searchTracks(q, albums, 15));
      }, { signal });
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
    const byId = new Map(resolved.map((r) => [r.trackId, r]));

    list.innerHTML = draft.tracks.map((trackId, idx) => {
      const entry = byId.get(trackId);
      const missing = !entry;
      const title = entry ? entry.track.title : '(referência pendente)';
      const album = entry ? entry.album.title : '—';
      const duration = entry ? (entry.track.duration || '—') : '—';

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
      b.addEventListener('click', () => moveTrack(Number(b.dataset.idx), -1), { signal });
    });
    list.querySelectorAll('[data-action="track-down"]').forEach((b) => {
      b.addEventListener('click', () => moveTrack(Number(b.dataset.idx), +1), { signal });
    });
    list.querySelectorAll('[data-action="track-remove"]').forEach((b) => {
      b.addEventListener('click', () => removeTrack(Number(b.dataset.idx)), { signal });
    });
  }

  function moveTrack(idx, delta) {
    const target = idx + delta;
    if (!Number.isInteger(idx) || target < 0 || target >= draft.tracks.length) return;
    [draft.tracks[idx], draft.tracks[target]] = [draft.tracks[target], draft.tracks[idx]];
    renderTrackList();
  }

  function removeTrack(idx) {
    if (!Number.isInteger(idx)) return;
    draft.tracks.splice(idx, 1);
    renderTrackList();
  }

  renderTrackList();

  document.getElementById('plCancel').addEventListener('click', () => {
    ac.abort();
    closeAdminModal();
  }, { signal });

  document.getElementById('plSave').addEventListener('click', () => {
    const errEl = document.getElementById('plError');
    errEl.textContent = '';

    // Proteção contra perda de dados se a API pública falhou ao ler o siteContent
    if (_contentError) {
      errEl.textContent = 'Conteúdo do site indisponível no servidor. Recarregue a página antes de salvar para não sobrescrever playlists.';
      return;
    }

    const title = document.getElementById('plTitle').value.trim();
    if (!title) return (errEl.textContent = 'Nome obrigatório.');
    if (title.length > MAX_TITLE_LEN) return (errEl.textContent = 'Nome muito longo.');

    const description = document.getElementById('plDescription').value.trim();
    if (description.length > MAX_DESC_LEN) return (errEl.textContent = 'Descrição muito longa.');

    const cover = (document.getElementById('plCover').value.trim() || '♪').slice(0, MAX_COVER_LEN);

    // Normaliza faixas (sem duplicatas, sem vazias)
    const seen = new Set();
    const finalTracks = [];
    for (const t of draft.tracks) {
      const id = String(t ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      finalTracks.push(id);
    }

    if (finalTracks.length > MAX_TRACKS) return (errEl.textContent = `Máximo de ${MAX_TRACKS} faixas.`);

    content.playlists[i] = {
      ...content.playlists[i],
      title,
      cover,
      description,
      tracks: finalTracks
    };

    markDirty();
    ac.abort();
    closeAdminModal();
    paintList(document.getElementById('playlistsEditor'), content, albums);
    toast('Playlist atualizada. Lembre de salvar.', '💾');
  }, { signal });
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