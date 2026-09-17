/* ============================================================
   admin/editors/playlists.js — Editor de playlists
   ============================================================ */

import { AdminState } from '../state.js';
import { esc } from '../ui/dom.js';

export function renderPlaylistsEditor(content = AdminState.content) {
  const wrap = document.getElementById('playlistsEditor');
  if (!wrap) return;

  if (!Array.isArray(content.playlists)) content.playlists = [];

  if (!content.playlists.length) {
    wrap.innerHTML = '<p class="hint" style="color:var(--text-dim);padding:1rem;">Nenhuma playlist ainda.</p>';
    return;
  }

  wrap.innerHTML = content.playlists.map((pl, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>${esc(pl.title || 'Playlist')}</strong>
        <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}">🗑</button>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Nome</label>
          <input value="${esc(pl.title || '')}" data-field="title" data-i="${i}">
        </div>
        <div class="form-group">
          <label>Capa (até 3 letras)</label>
          <input maxlength="3" value="${esc(pl.cover || '♪')}" data-field="cover" data-i="${i}">
        </div>
      </div>
      <div class="form-group">
        <label>Descrição</label>
        <input value="${esc(pl.description || '')}" data-field="description" data-i="${i}">
      </div>
      <div class="form-group">
        <label>Faixas (album-id:índice, separadas por vírgula)</label>
        <input value="${esc((pl.tracks || []).join(', '))}" data-field="tracks" data-i="${i}" placeholder="album-bbb:0, album-bbb:1">
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (!content.playlists[i]) content.playlists[i] = {};
      if (field === 'tracks') {
        content.playlists[i].tracks = el.value.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        content.playlists[i][field] = el.value;
      }
    });
  });

  wrap.querySelectorAll('[data-action="remove"]').forEach((b) =>
    b.addEventListener('click', () => {
      content.playlists.splice(Number(b.dataset.i), 1);
      renderPlaylistsEditor(content);
    }));
}

export function bindPlaylistsAddButton() {
  const btn = document.getElementById('addPlaylistBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    const content = AdminState.content;
    if (!Array.isArray(content.playlists)) content.playlists = [];
    content.playlists.push({
      id: 'playlist-' + Date.now().toString(36),
      title: 'Nova playlist',
      description: '',
      cover: '♪',
      tracks: []
    });
    renderPlaylistsEditor(content);
  });
}
