/* ============================================================
   js/admin/editors/albums.js — Editor de álbuns e faixas
   ------------------------------------------------------------
   - CRUD completo via /api/admin?action=albums|album|tracks|track
   - Upload integrado de preview e áudio full
   - Delegação de eventos no document (imune a re-render)
   - Letra aceita texto puro OU JSON (converte automaticamente)

   🔧 CORREÇÕES APLICADAS
   ------------------------------------------------------------
   1. Event delegation no document
   2. data-action explícito em CADA botão
   3. Guard contra binds duplicados
   4. parseLyricsInput() — aceita texto puro ou JSON
   5. Guards nos addEventListener (não crasha se modal vazio)
   6. Logs de diagnóstico
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

// ─────────────────────────────────────────────────────────────
// parseLyricsInput — aceita JSON ou texto puro
// ------------------------------------------------------------
// Se o usuário colar texto puro (uma linha por verso),
// converte para o formato [{ time, text }] automaticamente.
// Distribui 4 segundos por linha.
//
// Retorna:
//   - Array de { time, text } se conseguir parsear
//   - null se for inválido
// ─────────────────────────────────────────────────────────────
function parseLyricsInput(raw) {
  if (!raw || typeof raw !== 'string') return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  // ── Tentar JSON primeiro
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
      return null; // JSON malformado
    }
  }

  // ── Texto puro → converte
  const lines = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const SECONDS_PER_LINE = 4;

  return lines.map((text, i) => ({
    time: i * SECONDS_PER_LINE,
    text
  }));
}

// ─────────────────────────────────────────────────────────────
// Delegação global — UMA VEZ SÓ
// ─────────────────────────────────────────────────────────────
let _delegationBound = false;

function bindDelegation() {
  if (_delegationBound) return;
  _delegationBound = true;

  document.addEventListener('click', async (e) => {
    // Só processa cliques DENTRO do editor de álbuns
    const editor = e.target.closest('#albumsEditor');
    if (!editor) return;

    // ── Toggle álbum
    const toggle = e.target.closest('[data-album-toggle]');
    if (toggle) {
      e.preventDefault();
      const albumId = toggle.dataset.albumToggle;
      if (State.expandedAlbumIds.has(albumId)) {
        State.expandedAlbumIds.delete(albumId);
      } else {
        State.expandedAlbumIds.add(albumId);
        if (!State.tracks.has(albumId)) {
          await loadTracksForAlbum(albumId);
        }
      }
      repaint();
      return;
    }

    // ── Editar álbum
    const editAlbum = e.target.closest('[data-album-edit]');
    if (editAlbum) {
      e.preventDefault();
      e.stopPropagation();
      const albumId = editAlbum.dataset.albumEdit;
      const album = State.albums.find((a) => a.id === albumId);
      if (album) openAlbumModal(album);
      return;
    }

    // ── Excluir álbum
    const delAlbum = e.target.closest('[data-album-delete]');
    if (delAlbum) {
      e.preventDefault();
      e.stopPropagation();
      const albumId = delAlbum.dataset.albumDelete;
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
        console.error('[albums] delete album:', err);
        toast(err?.message || 'Falha ao excluir álbum.', '⚠');
      }
      return;
    }

    // ── Nova faixa
    const newTrack = e.target.closest('[data-track-new]');
    if (newTrack) {
      e.preventDefault();
      e.stopPropagation();
      openTrackModal(newTrack.dataset.trackNew, null);
      return;
    }

    // ── Editar faixa
    const editTrack = e.target.closest('[data-track-edit]');
    if (editTrack) {
      e.preventDefault();
      e.stopPropagation();
      const trackId = Number(editTrack.dataset.trackEdit);
      const albumId = editTrack.dataset.trackAlbum;
      if (!albumId) return;
      const list = State.tracks.get(albumId) || [];
      const track = list.find((t) => Number(t.id) === trackId);
      if (track) openTrackModal(albumId, track);
      else toast('Faixa não encontrada.', '⚠');
      return;
    }

    // ── Excluir faixa
    const delTrack = e.target.closest('[data-track-delete]');
    if (delTrack) {
      e.preventDefault();
      e.stopPropagation();
      const trackId = Number(delTrack.dataset.trackDelete);
      const albumId = delTrack.dataset.trackAlbum;
      if (!albumId) return;
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
      return;
    }

    // ── Atualizar
    const refresh = e.target.closest('[data-albums-refresh]');
    if (refresh) {
      e.preventDefault();
      await loadAlbums();
      return;
    }

    // ── Novo álbum
    const newAlbum = e.target.closest('[data-albums-new]');
    if (newAlbum) {
      e.preventDefault();
      openAlbumModal(null);
      return;
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Ponto de entrada
// ─────────────────────────────────────────────────────────────
export function renderAlbumsEditor(_content) {
  const container = document.getElementById('albumsEditor');
  if (!container) {
    console.warn('[albums] #albumsEditor não encontrado');
    return;
  }

  bindDelegation();

  if (container.dataset.mounted === '1') {
    const body = container.querySelector('[data-albums-body]');
    if (body) paintBody(body);
    return;
  }

  container.dataset.mounted = '1';
  paintShell(container);
  loadAlbums();
}

// ─────────────────────────────────────────────────────────────
// Shell
// ─────────────────────────────────────────────────────────────
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
    console.warn(`[albums] falha ao carregar faixas de ${albumId}:`, err);
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
    return;
  }

  body.innerHTML = State.albums.map((a) => renderAlbumBlock(a)).join('');
}

function renderAlbumBlock(album) {
  const isExpanded = State.expandedAlbumIds.has(album.id);
  const tracks = State.tracks.get(album.id) || [];
  const trackCount = tracks.length;
  const published = !!album.published;

  return `
    <div class="album-block ${isExpanded ? 'expanded' : ''}" data-album-id="${escAttr(album.id)}">
      <div class="album-header" data-album-toggle="${escAttr(album.id)}" style="cursor:pointer;">
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
          <th style="width:40px;">#</th>
          <th>Título</th>
          <th style="width:100px;">Duração</th>
          <th style="width:100px;">Preço</th>
          <th style="width:120px;">Áudio</th>
          <th style="width:100px;">Status</th>
          <th style="width:180px;">Ações</th>
        </tr>
      </thead>
      <tbody>
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
    <tr data-track-id="${escAttr(String(track.id))}">
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
  if (!saveBtn) {
    console.error('[albums] #albumSave não encontrado após openAdminModal');
    return;
  }

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

  // Mostra a letra como texto puro se for array simples
  const lyricsText = (() => {
    if (!Array.isArray(t.lyrics) || !t.lyrics.length) return '';
    // Se todas as linhas têm time === 0 ou times sequenciais, mostra texto puro
    return t.lyrics.map((l) => l.text || '').join('\n');
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
      <label for="trackLyrics">Letra (texto puro ou JSON)</label>
      <textarea id="trackLyrics" rows="6" style="font-family:inherit;font-size:0.9rem;">${esc(lyricsText)}</textarea>
      <div class="form-hint">
        Uma linha por verso. Os tempos são distribuídos automaticamente (4s por linha).
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
  if (!saveBtn) {
    console.error('[albums] #trackSave não encontrado após openAdminModal');
    return;
  }

  saveBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('trackError');
    if (errEl) errEl.textContent = '';

    // ⚡ Aceita texto puro OU JSON
    const lyrics = parseLyricsInput(
      document.getElementById('trackLyrics').value
    );

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

// ─────────────────────────────────────────────────────────────
// Upload de áudio associado a uma faixa
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

      toast(
        kind === 'audio-full' ? 'Áudio completo associado.' : 'Prévia associada.',
        '✓'
      );

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
