/* ============================================================
   js/admin/editors/albums.js — v5 (drag & drop)
   ------------------------------------------------------------
   - Listeners diretos em cada botão (sem delegação)
   - Drag & drop para reordenar faixas dentro de um álbum
   - Backend: PATCH /api/admin?action=track-order
   ============================================================ */

import { apiFetch } from '../api.js';
import { toast } from '../ui/toast.js';
import { esc, escAttr } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { uploadAudioPreview, uploadAudioFull } from '../uploads.js';

const State = {
  albums: [],
  tracks: new Map(),
  expandedAlbumIds: new Set(),
  loading: false,
  error: null
};

// ⚡ Estado do drag & drop
let _dragState = null;

// ─────────────────────────────────────────────────────────────
// parseLyricsInput
// ─────────────────────────────────────────────────────────────
function parseLyricsInput(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            time: Number(item.time) || 0,
            text: String(item.text || '').trim()
          }))
          .filter((item) => item.text);
      }
      return [];
    } catch {
      return null;
    }
  }

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  return lines.map((text, i) => ({ time: i * 4, text }));
}

// ─────────────────────────────────────────────────────────────
// Ponto de entrada
// ─────────────────────────────────────────────────────────────
export function renderAlbumsEditor(_content) {
  const container = document.getElementById('albumsEditor');
  if (!container) return;

  if (container.dataset.mounted === '1') {
    const body = container.querySelector('[data-albums-body]');
    if (body) paintBody(body);
    return;
  }

  container.dataset.mounted = '1';
  paintShell(container);
  loadAlbums();
}

function paintShell(container) {
  container.innerHTML = `
    <div class="albums-editor__header">
      <div>
        <p class="hint" style="margin:0;color:var(--text-dim);font-size:0.85rem;">
          Álbuns e faixas vivem no banco. Edite abaixo.
        </p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-outline btn-sm" data-albums-refresh type="button">
          ↻ Atualizar
        </button>
        <button class="btn btn-primary btn-sm" data-albums-new type="button">
          + Novo álbum
        </button>
      </div>
    </div>

    <div data-albums-body>
      <div class="admin-loading">Carregando álbuns…</div>
    </div>
  `;

  container.querySelector('[data-albums-refresh]')?.addEventListener('click', () => loadAlbums());
  container.querySelector('[data-albums-new]')?.addEventListener('click', () => openAlbumModal(null));
}

// ─────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────
async function loadAlbums() {
  const body = document.querySelector('[data-albums-body]');
  if (!body) return;

  State.loading = true;
  State.error = null;
  paintBody(body);

  try {
    const res = await apiFetch('albums', { method: 'GET' });
    State.albums = Array.isArray(res?.albums) ? res.albums : [];

    await Promise.all(
      Array.from(State.expandedAlbumIds).map((id) => loadTracksForAlbum(id))
    );
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) throw err;
    State.error = err?.message || 'Falha ao carregar álbuns.';
    State.albums = [];
  } finally {
    State.loading = false;
    paintBody(body);
  }
}

async function loadTracksForAlbum(albumId) {
  try {
    const res = await apiFetch('tracks', { method: 'GET', query: { albumId } });
    State.tracks.set(albumId, Array.isArray(res?.tracks) ? res.tracks : []);
  } catch (err) {
    console.warn(`[albums] falha faixas ${albumId}:`, err);
    State.tracks.set(albumId, []);
  }
}

// ─────────────────────────────────────────────────────────────
// Pintura
// ─────────────────────────────────────────────────────────────
function repaint() {
  const body = document.querySelector('[data-albums-body]');
  if (body) paintBody(body);
}

function paintBody(body) {
  if (State.loading) {
    body.innerHTML = '<div class="admin-loading">Carregando álbuns…</div>';
    return;
  }

  if (State.error) {
    body.innerHTML = `
      <div class="admin-error-box">
        <p>${esc(State.error)}</p>
        <button class="btn btn-outline btn-sm" data-albums-refresh type="button">
          Tentar novamente
        </button>
      </div>`;
    body.querySelector('[data-albums-refresh]')?.addEventListener('click', () => loadAlbums());
    return;
  }

  if (!State.albums.length) {
    body.innerHTML = `
      <div class="admin-empty">
        Nenhum álbum cadastrado ainda.
        <br>
        <button class="btn btn-primary btn-sm" data-albums-new type="button"
                style="margin-top:1rem;">
          + Criar primeiro álbum
        </button>
      </div>`;
    body.querySelector('[data-albums-new]')?.addEventListener('click', () => openAlbumModal(null));
    return;
  }

  body.innerHTML = State.albums.map((a) => renderAlbumBlock(a)).join('');

  bindAlbumButtons(body);
  bindTrackButtons(body);
}

// ─────────────────────────────────────────────────────────────
// Bind direto dos botões de álbum
// ─────────────────────────────────────────────────────────────
function bindAlbumButtons(scope) {
  scope.querySelectorAll('[data-album-toggle]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const albumId = btn.dataset.albumToggle;

      if (State.expandedAlbumIds.has(albumId)) {
        State.expandedAlbumIds.delete(albumId);
      } else {
        State.expandedAlbumIds.add(albumId);
        if (!State.tracks.has(albumId)) {
          await loadTracksForAlbum(albumId);
        }
      }
      repaint();
    });
  });

  scope.querySelectorAll('[data-album-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const albumId = btn.dataset.albumEdit;
      const album = State.albums.find((a) => a.id === albumId);
      if (album) openAlbumModal(album);
      else toast('Álbum não encontrado.', '⚠');
    });
  });

  scope.querySelectorAll('[data-album-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const albumId = btn.dataset.albumDelete;

      if (!confirm(`Excluir o álbum "${albumId}"? As faixas também serão removidas.`)) return;

      try {
        await apiFetch('album', {
          method: 'DELETE',
          query: { id: albumId, force: 'true' }
        });
        State.expandedAlbumIds.delete(albumId);
        State.tracks.delete(albumId);
        toast('Álbum excluído.', '🗑');
        await loadAlbums();
      } catch (err) {
        console.error('[albums] delete:', err);
        toast(err?.message || 'Falha ao excluir álbum.', '⚠');
      }
    });
  });

  scope.querySelectorAll('[data-track-new]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openTrackModal(btn.dataset.trackNew, null);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Bind direto dos botões de faixa
// ─────────────────────────────────────────────────────────────
function bindTrackButtons(scope) {
  scope.querySelectorAll('[data-track-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const trackId = Number(btn.dataset.trackEdit);
      const albumId = btn.dataset.trackAlbum;

      const list = State.tracks.get(albumId) || [];
      const track = list.find((t) => Number(t.id) === trackId);
      if (track) openTrackModal(albumId, track);
      else toast('Faixa não encontrada.', '⚠');
    });
  });

  scope.querySelectorAll('[data-track-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const trackId = Number(btn.dataset.trackDelete);
      const albumId = btn.dataset.trackAlbum;

      if (!confirm('Excluir esta faixa?')) return;

      try {
        await apiFetch('track', { method: 'DELETE', query: { id: trackId } });
        toast('Faixa excluída.', '🗑');
        await loadTracksForAlbum(albumId);
        repaint();
      } catch (err) {
        console.error('[albums] delete track:', err);
        toast(err?.message || 'Falha ao excluir faixa.', '⚠');
      }
    });
  });

  // ⚡ Drag & drop
  bindTrackDragDrop(scope);
}

// ─────────────────────────────────────────────────────────────
// Drag & Drop
// ─────────────────────────────────────────────────────────────
function bindTrackDragDrop(scope) {
  const bodies = scope.querySelectorAll('[data-tracks-body]');

  bodies.forEach((tbody) => {
    if (tbody.dataset.dragBound === '1') return;
    tbody.dataset.dragBound = '1';

    const albumId = tbody.dataset.tracksBody;

    tbody.addEventListener('dragstart', (e) => {
      const row = e.target.closest('tr[data-track-id]');
      if (!row) return;

      _dragState = { row, albumId };

      row.classList.add('dragging');

      try {
        e.dataTransfer.setData('text/plain', row.dataset.trackId);
        e.dataTransfer.effectAllowed = 'move';
      } catch {}
    });

    tbody.addEventListener('dragover', (e) => {
      if (!_dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || targetRow === _dragState.row) return;

      tbody.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom')
        .forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));

      const rect = targetRow.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      targetRow.classList.add(isAbove ? 'drag-over-top' : 'drag-over-bottom');
    });

    tbody.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!_dragState) return;

      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || targetRow === _dragState.row) {
        cleanupDrag(scope);
        return;
      }

      const rect = targetRow.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;

      const rows = Array.from(tbody.querySelectorAll('tr[data-track-id]'));
      const draggedIdx = rows.indexOf(_dragState.row);
      const targetIdx = rows.indexOf(targetRow);

      rows.splice(draggedIdx, 1);
      let insertAt = rows.indexOf(targetRow);
      if (!isAbove) insertAt += 1;
      rows.splice(insertAt, 0, _dragState.row);

      const order = rows.map((row, i) => ({
        id: Number(row.dataset.trackId),
        track_index: i
      }));

      const originalHtml = tbody.innerHTML;
      cleanupDrag(scope);

      await persistTrackOrder(albumId, order, tbody, originalHtml, scope);
    });

    tbody.addEventListener('dragend', () => cleanupDrag(scope));
  });
}

function cleanupDrag(scope) {
  if (_dragState?.row) _dragState.row.classList.remove('dragging');
  scope.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom')
    .forEach((r) => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  _dragState = null;
}

async function persistTrackOrder(albumId, order, tbody, originalHtml, scope) {
  try {
    reorderTableRows(tbody, order);

    const res = await apiFetch('track-order', {
      method: 'PATCH',
      body: { order }
    });

    if (!res?.ok) throw new Error(res?.error || 'Falha ao reordenar.');

    toast('Ordem atualizada.', '✓');

    await loadTracksForAlbum(albumId);
    repaint();
  } catch (err) {
    console.error('[drag] erro ao persistir ordem:', err);
    toast(err?.message || 'Falha ao reordenar faixas.', '⚠');
    tbody.innerHTML = originalHtml;
    bindTrackDragDrop(scope);
  }
}

function reorderTableRows(tbody, order) {
  const rowsById = new Map();
  tbody.querySelectorAll('tr[data-track-id]').forEach((row) => {
    rowsById.set(Number(row.dataset.trackId), row);
  });

  order.forEach((item, newIndex) => {
    const row = rowsById.get(item.id);
    if (!row) return;

    const idxCell = row.children[1];
    if (idxCell) idxCell.textContent = String(newIndex + 1);

    row.dataset.trackIndex = String(newIndex);
    tbody.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────────
// Render — álbum
// ─────────────────────────────────────────────────────────────
function renderAlbumBlock(album) {
  const isExpanded = State.expandedAlbumIds.has(album.id);
  const tracks = State.tracks.get(album.id) || [];
  const trackCount = tracks.length;
  const published = !!album.published;

  return `
    <div class="album-block ${isExpanded ? 'expanded' : ''}" data-album-id="${escAttr(album.id)}">
      <div class="album-header">
        <div class="album-cover" ${
          album.cover_image
            ? `style="background-image:url('${escAttr(album.cover_image)}')"`
            : ''
        }>
          ${album.cover_image ? '' : esc(album.cover_initials || '♪')}
        </div>
        <div class="album-info">
          <div class="album-title">
            ${esc(album.title)}
            <span class="album-badge ${published ? 'premium' : ''}">
              ${published ? 'Publicado' : 'Rascunho'}
            </span>
          </div>
          <div class="album-meta">
            <span class="gold">${esc((album.type || 'album').toUpperCase())}</span>
            · ${album.year || '—'}
            · ${trackCount} faixa${trackCount === 1 ? '' : 's'}
          </div>
          ${album.description ? `<div class="album-desc">${esc(album.description)}</div>` : ''}
        </div>
        <div class="album-actions" style="display:flex;gap:0.4rem;align-items:center;">
          <button class="btn btn-ghost btn-sm"
                  data-album-edit="${escAttr(album.id)}"
                  type="button" title="Editar álbum">✎</button>
          <button class="btn btn-ghost btn-sm"
                  data-album-delete="${escAttr(album.id)}"
                  type="button" title="Excluir álbum">🗑</button>
          <button class="album-toggle"
                  data-album-toggle="${escAttr(album.id)}"
                  type="button" aria-label="Expandir/recolher">▼</button>
        </div>
      </div>

      <div class="album-tracks">
        ${isExpanded ? renderTracksList(album.id, tracks) : ''}
      </div>
    </div>
  `;
}

function renderTracksList(albumId, tracks) {
  const addBtn = `
    <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm"
              data-track-new="${escAttr(albumId)}"
              type="button">
        + Nova faixa
      </button>
    </div>
  `;

  if (!tracks.length) {
    return `
      <p class="admin-empty">Nenhuma faixa cadastrada neste álbum.</p>
      ${addBtn}
    `;
  }

  return `
    <table class="admin-table" style="margin-top:0.5rem;">
      <thead>
        <tr>
          <th style="width:32px;"></th>
          <th style="width:40px;">#</th>
          <th>Título</th>
          <th style="width:100px;">Duração</th>
          <th style="width:100px;">Preço</th>
          <th style="width:120px;">Áudio</th>
          <th style="width:100px;">Status</th>
          <th style="width:180px;">Ações</th>
        </tr>
      </thead>
      <tbody data-tracks-body="${escAttr(albumId)}">
        ${tracks.map((track, idx) => renderTrackRow(albumId, track, idx)).join('')}
      </tbody>
    </table>
    ${addBtn}
  `;
}

function renderTrackRow(albumId, track, idx) {
  const hasPreview = !!track.preview_path;
  const hasFull = !!track.full_path;

  const audioChips = `
    <span class="audio-chip ${hasPreview ? '' : 'none'}" title="Preview">
      ${hasPreview ? 'P' : '—'}
    </span>
    <span class="audio-chip ${hasFull ? '' : 'none'}" title="Áudio completo">
      ${hasFull ? 'F' : '—'}
    </span>
  `;

  const statusBadge = track.published
    ? '<span class="badge-mini badge-premium">Pub</span>'
    : '<span class="badge-mini badge-free">Rasc</span>';

  const price = Number(track.price_cents) || 0;

  return `
    <tr data-track-id="${escAttr(String(track.id))}"
        data-track-index="${Number(track.track_index) || 0}"
        draggable="true"
        class="track-row">
      <td class="track-drag-cell">
        <span class="track-drag-handle" title="Arraste para reordenar" aria-label="Arraste para reordenar">⋮⋮</span>
      </td>
      <td>${idx + 1}</td>
      <td>${esc(track.title || '—')}</td>
      <td>${esc(track.duration || '—')}</td>
      <td>R$ ${(price / 100).toFixed(2).replace('.', ',')}</td>
      <td style="white-space:nowrap;">
        <span style="display:inline-flex;gap:4px;">${audioChips}</span>
      </td>
      <td>${statusBadge}</td>
      <td>
        <div class="actions">
          <button class="btn btn-ghost btn-sm"
                  data-track-edit="${escAttr(String(track.id))}"
                  data-track-album="${escAttr(albumId)}"
                  type="button">✎ Editar</button>
          <button class="btn btn-ghost btn-sm"
                  data-track-delete="${escAttr(String(track.id))}"
                  data-track-album="${escAttr(albumId)}"
                  type="button">🗑</button>
        </div>
      </td>
    </tr>
  `;
}

// ─────────────────────────────────────────────────────────────
// Modal — Álbum
// ─────────────────────────────────────────────────────────────
function openAlbumModal(album) {
  const isNew = !album;
  const a = album || {
    id: '', title: '', artist: 'Joseph Matthos',
    year: new Date().getFullYear(), type: 'album',
    cover_initials: '', cover_image: '', description: '',
    published: false, order_index: 0
  };

  openAdminModal(`
    <h3>${isNew ? 'Novo álbum' : 'Editar álbum'}</h3>

    <div class="form-row">
      <div class="form-group">
        <label for="albumId">ID (slug)</label>
        <input type="text" id="albumId" value="${escAttr(a.id)}"
               ${isNew ? '' : 'disabled'}
               placeholder="album-bbb" maxlength="64">
        <div class="form-hint">Letras, números e hífens.</div>
      </div>
      <div class="form-group">
        <label for="albumType">Tipo</label>
        <select id="albumType">
          <option value="album" ${a.type === 'album' ? 'selected' : ''}>Álbum</option>
          <option value="ep"    ${a.type === 'ep'    ? 'selected' : ''}>EP</option>
          <option value="single"${a.type === 'single'? 'selected' : ''}>Single</option>
        </select>
      </div>
    </div>

    <div class="form-group">
      <label for="albumTitle">Título *</label>
      <input type="text" id="albumTitle" value="${escAttr(a.title)}" required>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="albumArtist">Artista</label>
        <input type="text" id="albumArtist" value="${escAttr(a.artist || '')}">
      </div>
      <div class="form-group">
        <label for="albumYear">Ano</label>
        <input type="number" id="albumYear" value="${escAttr(String(a.year || ''))}">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="albumCoverInitials">Iniciais da capa</label>
        <input type="text" id="albumCoverInitials" value="${escAttr(a.cover_initials || '')}" maxlength="8" placeholder="JM">
      </div>
      <div class="form-group">
        <label for="albumOrderIndex">Ordem</label>
        <input type="number" id="albumOrderIndex" value="${escAttr(String(a.order_index || 0))}">
      </div>
    </div>

    <div class="form-group">
      <label for="albumCoverImage">URL da capa</label>
      <input type="text" id="albumCoverImage" value="${escAttr(a.cover_image || '')}" placeholder="https://...">
    </div>

    <div class="form-group">
      <label for="albumDescription">Descrição</label>
      <textarea id="albumDescription" rows="3">${esc(a.description || '')}</textarea>
    </div>

    <div class="form-group">
      <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
        <input type="checkbox" id="albumPublished" ${a.published ? 'checked' : ''}>
        Publicar álbum
      </label>
    </div>

    <div class="form-error" id="albumError"></div>

    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" data-close type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="albumSave" type="button">
        ${isNew ? 'Criar álbum' : 'Salvar alterações'}
      </button>
    </div>
  `);

  const saveBtn = document.getElementById('albumSave');
  if (!saveBtn) return;

  saveBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('albumError');
    if (errEl) errEl.textContent = '';

    const payload = {
      id: document.getElementById('albumId').value.trim(),
      title: document.getElementById('albumTitle').value.trim(),
      artist: document.getElementById('albumArtist').value.trim(),
      year: Number(document.getElementById('albumYear').value) || null,
      type: document.getElementById('albumType').value,
      cover_initials: document.getElementById('albumCoverInitials').value.trim(),
      cover_image: document.getElementById('albumCoverImage').value.trim(),
      description: document.getElementById('albumDescription').value.trim(),
      order_index: Number(document.getElementById('albumOrderIndex').value) || 0,
      published: document.getElementById('albumPublished').checked
    };

    if (!payload.id || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(payload.id)) {
      if (errEl) errEl.textContent = 'ID inválido.';
      return;
    }
    if (!payload.title) {
      if (errEl) errEl.textContent = 'Título obrigatório.';
      return;
    }

    try {
      if (isNew) {
        await apiFetch('albums', { method: 'POST', body: payload });
        toast('Álbum criado.', '💿');
      } else {
        const patch = { ...payload };
        delete patch.id;
        await apiFetch('album', {
          method: 'PATCH',
          query: { id: a.id },
          body: patch
        });
        toast('Álbum atualizado.', '💿');
      }
      closeAdminModal();
      await loadAlbums();
    } catch (err) {
      console.error('[albums] save:', err);
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar álbum.';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Modal — Faixa
// ─────────────────────────────────────────────────────────────
function openTrackModal(albumId, track) {
  const isNew = !track;
  const t = track || {
    id: null, album_id: albumId, track_index: 0,
    title: '', duration: '', preview_start: 0, preview_duration: 30,
    price_cents: 499, for_sale: true, published: false,
    preview_path: null, full_path: null, lyrics: []
  };

  // Mostra a letra como JSON (para permitir edição de timestamps)
const lyricsText = (() => {
  if (!Array.isArray(t.lyrics) || !t.lyrics.length) return '[]';
  return JSON.stringify(t.lyrics, null, 2);
})();

  openAdminModal(`
    <h3>${isNew ? 'Nova faixa' : 'Editar faixa'}</h3>

    <div class="form-group">
      <label for="trackTitle">Título *</label>
      <input type="text" id="trackTitle" value="${escAttr(t.title)}" required>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="trackDuration">Duração (mm:ss)</label>
        <input type="text" id="trackDuration" value="${escAttr(t.duration || '')}" placeholder="3:45">
      </div>
      <div class="form-group">
        <label for="trackPrice">Preço (centavos)</label>
        <input type="number" id="trackPrice" value="${escAttr(String(t.price_cents || 0))}" min="1">
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="trackPreviewStart">Início da prévia (s)</label>
        <input type="number" id="trackPreviewStart" value="${escAttr(String(t.preview_start || 0))}" min="0">
      </div>
      <div class="form-group">
        <label for="trackPreviewDuration">Duração da prévia (s)</label>
        <input type="number" id="trackPreviewDuration" value="${escAttr(String(t.preview_duration || 30))}" min="5" max="120">
      </div>
    </div>

    <div class="form-group">
      <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
        <input type="checkbox" id="trackPublished" ${t.published ? 'checked' : ''}>
        Publicar faixa
      </label>
      <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-top:0.5rem;">
        <input type="checkbox" id="trackForSale" ${t.for_sale !== false ? 'checked' : ''}>
        Disponível para aluguel
      </label>
    </div>

    <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
      <h4 style="margin:0 0 0.75rem;font-size:0.9rem;color:var(--accent);">🎧 Prévia (30s)</h4>
      <div data-preview-status style="font-size:0.85rem;margin-bottom:0.5rem;">
        ${t.preview_path
          ? `<span class="audio-chip">✓ ${esc(t.preview_path)}</span>`
          : '<span class="audio-chip none">Nenhum arquivo</span>'}
      </div>
      <button class="btn btn-outline btn-sm" data-upload-preview type="button">
        ${t.preview_path ? '↻ Substituir prévia' : '⬆ Enviar prévia'}
      </button>
      <input type="file" id="trackPreviewInput" accept="audio/*" hidden>
    </div>

    <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
      <h4 style="margin:0 0 0.75rem;font-size:0.9rem;color:var(--accent);">🎵 Áudio completo</h4>
      <div data-full-status style="font-size:0.85rem;margin-bottom:0.5rem;">
        ${t.full_path
          ? `<span class="audio-chip">✓ ${esc(t.full_path)}</span>`
          : '<span class="audio-chip none">Nenhum arquivo</span>'}
      </div>
      <button class="btn btn-outline btn-sm" data-upload-full type="button">
        ${t.full_path ? '↻ Substituir áudio completo' : '⬆ Enviar áudio completo'}
      </button>
      <input type="file" id="trackFullInput" accept="audio/*" hidden>
    </div>

    <div class="form-group">
  <label for="trackLyrics">Letra (JSON sincronizado)</label>
  <textarea id="trackLyrics" rows="10" style="font-family:monospace;font-size:0.85rem;line-height:1.5;tab-size:2;">${esc(lyricsText)}</textarea>
  <div class="form-hint">
    Formato: <code>[{ "time": 0, "text": "Primeira linha" }, ...]</code><br>
    <strong>time</strong> em segundos (ex: <code>0</code>, <code>4.5</code>, <code>12</code>).<br>
    <button type="button" class="btn btn-ghost btn-sm" id="trackLyricsHelpBtn" style="margin-top:0.5rem;padding:0.2rem 0.6rem;font-size:0.75rem;">📖 Ver exemplo completo</button>
  </div>
</div>

    <div class="form-error" id="trackError"></div>

    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" data-close type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="trackSave" type="button">
        ${isNew ? 'Criar faixa' : 'Salvar alterações'}
      </button>
    </div>
  `);

  bindTrackUpload({
    buttonSel: '[data-upload-preview]',
    inputId: 'trackPreviewInput',
    statusSel: '[data-preview-status]',
    kind: 'audio-preview',
    uploadFn: uploadAudioPreview,
    field: 'preview_path',
    albumId,
    track: t
  });

  bindTrackUpload({
    buttonSel: '[data-upload-full]',
    inputId: 'trackFullInput',
    statusSel: '[data-full-status]',
    kind: 'audio-full',
    uploadFn: uploadAudioFull,
    field: 'full_path',
    albumId,
    track: t
  });

  const saveBtn = document.getElementById('trackSave');
  if (!saveBtn) return;

  saveBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('trackError');
    if (errEl) errEl.textContent = '';

    const lyrics = parseLyricsInput(document.getElementById('trackLyrics').value);

    if (lyrics === null) {
      if (errEl) errEl.textContent = 'Letra inválida. Use texto puro ou JSON válido.';
      return;
    }

    const payload = {
      title: document.getElementById('trackTitle').value.trim(),
      duration: document.getElementById('trackDuration').value.trim(),
      preview_start: Number(document.getElementById('trackPreviewStart').value) || 0,
      preview_duration: Number(document.getElementById('trackPreviewDuration').value) || 30,
      price_cents: Number(document.getElementById('trackPrice').value) || 499,
      for_sale: document.getElementById('trackForSale').checked,
      published: document.getElementById('trackPublished').checked,
      lyrics
    };

    if (!payload.title) {
      if (errEl) errEl.textContent = 'Título obrigatório.';
      return;
    }

    try {
      if (isNew) {
        await apiFetch('tracks', {
          method: 'POST',
          body: { ...payload, album_id: albumId }
        });
        toast('Faixa criada.', '🎵');
      } else {
        await apiFetch('track', {
          method: 'PATCH',
          query: { id: t.id },
          body: payload
        });
        toast('Faixa atualizada.', '🎵');
      }
      closeAdminModal();
      await loadTracksForAlbum(albumId);
      repaint();
    } catch (err) {
      console.error('[albums] save track:', err);
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar faixa.';
    }
  });
}

// ── Botão de ajuda do formato JSON
const helpBtn = document.getElementById('trackLyricsHelpBtn');
if (helpBtn) {
  helpBtn.addEventListener('click', () => {
    openAdminModal(`
      <h3>Formato da letra sincronizada</h3>

      <p style="color:var(--text-dim);margin-bottom:1rem;">
        Cole um array JSON onde cada linha tem um <code>time</code> (em segundos) e um <code>text</code>.
      </p>

      <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-bottom:1rem;">
        <pre style="font-family:monospace;font-size:0.8rem;line-height:1.6;color:var(--text);overflow-x:auto;margin:0;">[
  { "time": 0,    "text": "Primeira linha" },
  { "time": 4.5,  "text": "Segunda linha" },
  { "time": 9,    "text": "Terceira linha" },
  { "time": 13.2, "text": "Quarta linha" }
]</pre>
      </div>

      <h4 style="font-size:0.9rem;margin-bottom:0.5rem;color:var(--accent);">
        Como calcular o <code>time</code>
      </h4>
      <ul style="color:var(--text-dim);font-size:0.85rem;line-height:1.7;margin-left:1.2rem;margin-bottom:1rem;">
        <li>Ouve a música e anota o segundo exato em que cada verso começa</li>
        <li>Pode usar decimais: <code>4.5</code> = 4 segundos e meio</li>
        <li>A letra acende no player quando o áudio chega nesse tempo</li>
      </ul>

      <h4 style="font-size:0.9rem;margin-bottom:0.5rem;color:var(--accent);">
        Dicas
      </h4>
      <ul style="color:var(--text-dim);font-size:0.85rem;line-height:1.7;margin-left:1.2rem;margin-bottom:1rem;">
        <li>Se colar texto puro, o sistema distribui 4s por linha automaticamente</li>
        <li>Linhas vazias são ignoradas</li>
        <li>Não pode ter vírgula depois do último item</li>
      </ul>

      <div style="display:flex;justify-content:flex-end;margin-top:1.5rem;">
        <button class="btn btn-primary btn-sm" data-close type="button">Entendi</button>
      </div>
    `);
  });
}

// ─────────────────────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────────────────────
function bindTrackUpload({
  buttonSel, inputId, statusSel, kind, uploadFn, field, albumId, track
}) {
  const button = document.querySelector(buttonSel);
  const input = document.getElementById(inputId);
  const statusEl = document.querySelector(statusSel);

  if (!button || !input) return;

  button.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    if (!track.id) {
      toast('Salve a faixa antes de enviar o áudio.', '⚠');
      input.value = '';
      return;
    }

    const original = button.textContent;

    try {
      button.disabled = true;
      button.textContent = 'Enviando…';
      if (statusEl) statusEl.innerHTML = '<span class="audio-chip">⬆ 0%</span>';

      const result = await uploadFn(file, (pct) => {
        if (statusEl) statusEl.innerHTML = `<span class="audio-chip">⬆ ${pct}%</span>`;
      });

      if (!result?.path) throw new Error('Upload não retornou path.');

      await apiFetch('track', {
        method: 'PATCH',
        query: { id: track.id },
        body: { [field]: result.path }
      });

      track[field] = result.path;

      if (statusEl) statusEl.innerHTML = `<span class="audio-chip">✓ ${esc(result.path)}</span>`;

      toast(kind === 'audio-full' ? 'Áudio completo associado.' : 'Prévia associada.', '✓');

      loadTracksForAlbum(albumId).then(() => repaint());
    } catch (err) {
      console.error('[albums] upload:', err);
      toast(err?.message || 'Falha no upload.', '⚠');
      if (statusEl) statusEl.innerHTML = '<span class="audio-chip none">Falha no upload</span>';
    } finally {
      button.disabled = false;
      button.textContent = original;
      input.value = '';
    }
  });
}
