/* ============================================================
   admin/editors/playlists.js — Editor de playlists
   ============================================================ */

import { AdminState } from '../index.js';
import { esc } from '../ui/dom.js';

export function renderPlaylistsEditor(content = AdminState.content) {
  const wrap = document.getElementById('playlistsEditor');
  if (!wrap) return;

  content.playlists = Array.isArray(content.playlists) ? content.playlists : [];

  wrap.innerHTML = content.playlists.map((pl, i) => {
    const rows = (pl.tracks || []).map((ref, ti) => {
      const [albumId, trackIdx] = String(ref).split(':');
      const album = content.discografia.albums.find((a) => a.id === albumId);
      const track = album && album.tracks[Number(trackIdx)];
      const label = track ? `${album.title} — ${track.title}` : ref;
      return `
        <div class="playlist-track-row">
          <span>${ti + 1}. ${esc(label)}</span>
          <span>
            <button class="btn btn-ghost btn-sm" data-action="up" data-i="${i}" data-ti="${ti}" aria-label="Subir">↑</button>
            <button class="btn btn-ghost btn-sm" data-action="down" data-i="${i}" data-ti="${ti}" aria-label="Descer">↓</button>
            <button class="btn btn-ghost btn-sm" data-action="remove-track" data-i="${i}" data-ti="${ti}" aria-label="Remover">🗑</button>
          </span>
        </div>`;
    }).join('');

    return `
      <div class="track-editor playlist-editor">
        <div class="track-head">
          <strong>${esc(pl.title || 'Playlist')}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove-playlist" data-i="${i}">🗑</button>
        </div>

        <div class="form-row">
          <div class="form-group"><label>Nome</label>
            <input value="${esc(pl.title || '')}" data-field="title" data-i="${i}"></div>
          <div class="form-group"><label>Capa/fallback</label>
            <input maxlength="3" value="${esc(pl.cover || '♪')}" data-field="cover" data-i="${i}"></div>
        </div>

        <div class="form-group"><label>Descrição</label>
          <input value="${esc(pl.description || '')}" data-field="description" data-i="${i}"></div>

        <div class="form-group">
          <label>Faixas na ordem</label>
          ${rows || '<p class="hint">Nenhuma faixa adicionada.</p>'}
        </div>

        <div class="form-group"><label>Referências (album-id:índice)</label>
          <input value="${esc((pl.tracks || []).join(', '))}"
                 data-field="tracks" data-i="${i}"
                 placeholder="album-bbb:0, album-bbb:1"></div>
      </div>`;
  }).join('') || '<p class="hint">Nenhuma playlist criada.</p>';

  // Bind de campos
  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (field === 'tracks') {
        content.playlists[i].tracks = el.value.split(',')
          .map((s) => s.trim()).filter(Boolean);
      } else {
        content.playlists[i][field] = el.value;
      }
    });
  });

  // Ações
  wrap.querySelectorAll('[data-action="remove-playlist"]').forEach((b) =>
    b.addEventListener('click', () => {
      content.playlists.splice(Number(b.dataset.i), 1);
      renderPlaylistsEditor(content);
    }));

  wrap.querySelectorAll('[data-action="remove-track"]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      const ti = Number(b.dataset.ti);
      content.playlists[i].tracks.splice(ti, 1);
      renderPlaylistsEditor(content);
    }));

  wrap.querySelectorAll('[data-action="up"]').forEach((b) =>
    b.addEventListener('click', () => {
      move(content, Number(b.dataset.i), Number(b.dataset.ti), -1);
    }));
  wrap.querySelectorAll('[data-action="down"]').forEach((b) =>
    b.addEventListener('click', () => {
      move(content, Number(b.dataset.i), Number(b.dataset.ti), 1);
    }));
}

function move(content, playlistIdx, trackIdx, dir) {
  const arr = content.playlists[playlistIdx].tracks;
  const target = trackIdx + dir;
  if (target < 0 || target >= arr.length) return;
  const [item] = arr.splice(trackIdx, 1);
  arr.splice(target, 0, item);
  renderPlaylistsEditor(content);
}

// Botão "+ Adicionar"
export function bindPlaylistsAddButton() {
  const btn = document.getElementById('addPlaylistBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    AdminState.content.playlists.push({
      id: `playlist-${Date.now().toString(36)}`,
      title: 'Nova playlist',
      description: '',
      cover: '♪',
      tracks: []
    });
    renderPlaylistsEditor(AdminState.content);
  });
}