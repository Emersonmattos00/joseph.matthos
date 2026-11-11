/* ============================================================
   js/admin/editors/albums.js — v8 (Aderente ao Backend & Schema)
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
  error: null,
  loadReqId: 0 // Para controle de concorrência (Item 12)
};

let _dragState = null;

// ─────────────────────────────────────────────────────────────
// parseLyricsInput — Versão Estrita (Item 10)
// ─────────────────────────────────────────────────────────────
function parseLyricsInput(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let entries;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      entries = JSON.parse(trimmed);
    } catch {
      return null; // JSON inválido
    }
    if (!Array.isArray(entries)) return null;
  } else {
    // Texto puro: distribui 4s por linha
    entries = trimmed.split('\n').map((text, index) => ({ time: index * 4, text }));
  }

  const result = [];
  let previousTime = -1;

  for (const item of entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    
    const time = Number(item.time);
    const text = String(item.text || '').trim();

    // Validações: número finito, >= 0, texto presente, ordem crescente
    if (!Number.isFinite(time) || time < 0 || !text || time < previousTime) {
      return null;
    }

    previousTime = time;
    result.push({ time, text });
  }

  return result;
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

  // Controle de concorrência (Item 12)
  const currentReq = ++State.loadReqId;
  State.loading = true;
  State.error = null;
  paintBody(body);

  try {
    const res = await apiFetch('albums', { method: 'GET' });
    if (currentReq !== State.loadReqId) return; // Requisição obsoleta

    State.albums = Array.isArray(res?.albums) ? res.albums : [];

    await Promise.all(
      Array.from(State.expandedAlbumIds).map((id) => loadTracksForAlbum(id))
    );
  } catch (err) {
    if (currentReq !== State.loadReqId) return;
    if (err?.status === 401 || err?.status === 403) throw err;
    State.error = err?.message || 'Falha ao carregar álbuns.';
    State.albums = [];
  } finally {
    if (currentReq === State.loadReqId) {
      State.loading = false;
      paintBody(body);
    }
  }
}

async function loadTracksForAlbum(albumId) {
  try {
    const res = await apiFetch('tracks', { method: 'GET', query: { albumId } });
    State.tracks.set(albumId, Array.isArray(res?.tracks) ? res.tracks : []);
  } catch (err) {
    console.warn(`[albums] falha faixas ${albumId}:`, err);
    // Preserva o erro em vez de fingir que o álbum está vazio (Item 12)
    State.tracks.set(albumId, { error: err?.message || 'Erro ao carregar' });
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
        <button class="btn btn-outline btn-sm" data-albums-refresh type="button">Tentar novamente</button>
      </div>`;
    body.querySelector('[data-albums-refresh]')?.addEventListener('click', () => loadAlbums());
    return;
  }

  if (!State.albums.length) {
    body.innerHTML = `
      <div class="admin-empty">
        Nenhum álbum cadastrado ainda.<br>
        <button class="btn btn-primary btn-sm" data-albums-new type="button" style="margin-top:1rem;">
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
      e.preventDefault(); e.stopPropagation();
      const albumId = btn.dataset.albumToggle;

      if (State.expandedAlbumIds.has(albumId)) {
        State.expandedAlbumIds.delete(albumId);
      } else {
        State.expandedAlbumIds.add(albumId);
        if (!State.tracks.has(albumId)) await loadTracksForAlbum(albumId);
      }
      repaint();
    });
  });

  scope.querySelectorAll('[data-album-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const albumId = btn.dataset.albumEdit;
      const album = State.albums.find((a) => a.id === albumId);
      if (album) openAlbumModal(album);
      else toast('Álbum não encontrado.', '⚠');
    });
  });

  scope.querySelectorAll('[data-album-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const albumId = btn.dataset.albumDelete;
      const album = State.albums.find((a) => a.id === albumId);

      // Mostra o título real (Item 12)
      if (!confirm(`Excluir o álbum "${album?.title || albumId}"? As faixas também serão removidas.`)) return;

      try {
        await apiFetch('album', { method: 'DELETE', query: { id: albumId } });
        State.expandedAlbumIds.delete(albumId);
        State.tracks.delete(albumId);
        toast('Álbum excluído.', '🗑');
        await loadAlbums();
      } catch (err) {
        toast(err?.message || 'Falha ao excluir álbum.', '⚠');
      }
    });
  });

  scope.querySelectorAll('[data-album-download]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      downloadAlbum(btn.dataset.albumDownload);
    });
  });

  scope.querySelectorAll('[data-track-new]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openTrackModal(btn.dataset.trackNew, null);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Bind direto dos botões de faixa (UUIDs como String)
// ─────────────────────────────────────────────────────────────
function bindTrackButtons(scope) {
  scope.querySelectorAll('[data-track-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const trackId = String(btn.dataset.trackEdit);
      const albumId = String(btn.dataset.trackAlbum);

      const list = State.tracks.get(albumId);
      const track = Array.isArray(list) ? list.find((t) => String(t.id) === trackId) : null;
      if (track) openTrackModal(albumId, track);
      else toast('Faixa não encontrada.', '⚠');
    });
  });

  scope.querySelectorAll('[data-track-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const trackId = String(btn.dataset.trackDelete);
      const albumId = String(btn.dataset.trackAlbum);

      if (!trackId) return toast('Identificador da faixa inválido.', '⚠');
      if (!confirm('Excluir esta faixa?')) return;

      try {
        await apiFetch('track', { method: 'DELETE', query: { id: trackId } });
        toast('Faixa excluída.', '🗑');
        await loadTracksForAlbum(albumId);
        repaint();
      } catch (err) {
        toast(err?.message || 'Falha ao excluir faixa.', '⚠');
      }
    });
  });

  scope.querySelectorAll('[data-track-download]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      downloadTrack(btn.dataset.trackDownload, btn.dataset.trackDownloadTitle);
    });
  });

  bindTrackDragDrop(scope);
}

// ─────────────────────────────────────────────────────────────
// Download — faixa individual
// ─────────────────────────────────────────────────────────────
async function downloadTrack(trackId, titleHint) {
  if (!trackId) return;
  const btn = document.querySelector(`[data-track-download="${trackId}"]`);
  const originalHtml = btn?.innerHTML;

  try {
    if (btn) { btn.disabled = true; btn.textContent = '⬇ …'; }
    const res = await apiFetch('download-url', { method: 'GET', query: { id: trackId } });

    if (!res?.ok || !res.url) throw new Error(res?.error || 'Falha ao gerar URL.');
    triggerDownload(res.url, res.filename || `${titleHint || trackId}.mp3`);
    toast(`Download iniciado: ${titleHint || trackId}`, '⬇');
  } catch (err) {
    toast(err?.message || `Falha ao baixar.`, '⚠');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

// ─────────────────────────────────────────────────────────────
// Download — álbum completo (Honesto)
// ─────────────────────────────────────────────────────────────
async function downloadAlbum(albumId) {
  if (!albumId) return;
  const album = State.albums.find((a) => a.id === albumId);
  const albumTitle = album?.title || albumId;

  const confirmed = confirm(
    `Solicitar download de todas as faixas do álbum "${albumTitle}"?\n\n` +
    `O navegador pode pedir permissão para salvar múltiplos arquivos.`
  );
  if (!confirmed) return;

  try {
    toast(`Preparando álbum "${albumTitle}"…`, '⏳');
    const res = await apiFetch('download-album', { method: 'GET', query: { id: albumId } });

    if (!res?.ok || !Array.isArray(res.tracks)) throw new Error(res?.error || 'Falha ao listar faixas.');
    
    const valid = res.tracks.filter((t) => t.url);
    if (!valid.length) return toast('Este álbum não tem áudios completos.', '⚠');

    // Item 11: Mensagem honesta
    toast(`Disparando ${valid.length} download(s)...`, '⬇');
    let failures = 0;

    for (let i = 0; i < valid.length; i++) {
      try { triggerDownload(valid[i].url, valid[i].filename || `${valid[i].title}.mp3`); }
      catch { failures++; }
      await sleep(600);
    }

    if (failures) toast(`Concluído com ${failures} falha(s) de URL.`, '⚠');
    else toast(`${valid.length} downloads solicitados ao navegador.`, '✓');

  } catch (err) {
    toast(err?.message || 'Falha ao baixar álbum.', '⚠');
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers de download (Validação de Origem)
// ─────────────────────────────────────────────────────────────
function triggerDownload(url, filename) {
  // Item 12: Restringe URLs ao Backblaze (evita redirecionamento malicioso)
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('r2.cloudflarestorage.com') && !u.hostname.endsWith('josephmatthos.com.br')) {
      throw new Error('Domínio de download inválido.');
    }
  } catch {
    toast('URL de download mal formatada ou insegura.', '⚠');
    return;
  }

  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
      try { e.dataTransfer.setData('text/plain', row.dataset.trackId); e.dataTransfer.effectAllowed = 'move'; } catch {}
    });

    tbody.addEventListener('dragover', (e) => {
      if (!_dragState) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || targetRow === _dragState.row) return;
      tbody.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      const rect = targetRow.getBoundingClientRect();
      targetRow.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
    });

    tbody.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!_dragState) return;
      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || targetRow === _dragState.row) { cleanupDrag(scope); return; }

      const rect = targetRow.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      const rows = Array.from(tbody.querySelectorAll('tr[data-track-id]'));
      
      rows.splice(rows.indexOf(_dragState.row), 1);
      let insertAt = rows.indexOf(targetRow);
      if (!isAbove) insertAt += 1;
      rows.splice(insertAt, 0, _dragState.row);

      const order = rows.map((row, i) => ({ id: String(row.dataset.trackId), track_number: i + 1 }));
      const originalHtml = tbody.innerHTML;
      cleanupDrag(scope);

      await persistTrackOrder(albumId, order, tbody, originalHtml, scope);
    });

    tbody.addEventListener('dragend', () => cleanupDrag(scope));
  });
}

function cleanupDrag(scope) {
  if (_dragState?.row) _dragState.row.classList.remove('dragging');
  scope.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  _dragState = null;
}

async function persistTrackOrder(albumId, order, tbody, originalHtml, scope) {
  try {
    reorderTableRows(tbody, order);
    // Envia albumId e UUIDs (String)
    const res = await apiFetch('track-order', { method: 'PATCH', body: { albumId, order } });
    if (!res?.ok) throw new Error(res?.error || 'Falha ao reordenar.');
    toast('Ordem atualizada.', '✓');
    await loadTracksForAlbum(albumId);
    repaint();
  } catch (err) {
    toast(err?.message || 'Falha ao reordenar.', '⚠');
    tbody.innerHTML = originalHtml;
    bindTrackDragDrop(scope);
  }
}

function reorderTableRows(tbody, order) {
  const rowsById = new Map();
  tbody.querySelectorAll('tr[data-track-id]').forEach((row) => rowsById.set(String(row.dataset.trackId), row));

  order.forEach((item, newIndex) => {
    const row = rowsById.get(String(item.id));
    if (!row) throw new Error(`Faixa não encontrada: ${item.id}`);
    if (row.children[1]) row.children[1].textContent = String(newIndex + 1);
    row.dataset.trackIndex = String(newIndex);
    tbody.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
function renderAlbumBlock(album) {
  const isExpanded = State.expandedAlbumIds.has(album.id);
  const tracks = State.tracks.get(album.id);
  const trackCount = Array.isArray(tracks) ? tracks.length : 0;
  const isPublished = !!album.published;

  return `
    <div class="album-block ${isExpanded ? 'expanded' : ''}" data-album-id="${escAttr(album.id)}">
      <div class="album-header">
        <div class="album-cover" ${(album.coverUrl || album.cover_image) ? `style="background-image:url('${escAttr(album.coverUrl || album.cover_image)}')"` : ''}>
          ${(album.coverUrl || album.cover_image) ? '' : esc(album.title?.charAt(0) || '♪')}
        </div>
        <div class="album-info">
          <div class="album-title">
            ${esc(album.title)}
            <span class="album-badge ${isPublished ? 'premium' : ''}">${isPublished ? 'Publicado' : 'Rascunho'}</span>
          </div>
          <div class="album-meta">
            <span class="gold">ÁLBUM</span> · ${album.year || '—'} · ${trackCount} faixa${trackCount === 1 ? '' : 's'}
          </div>
        </div>
        <div class="album-actions" style="display:flex;gap:0.4rem;align-items:center;">
          <button class="btn btn-ghost btn-sm" data-album-download="${escAttr(album.id)}" type="button" title="Baixar">⬇</button>
          <button class="btn btn-ghost btn-sm" data-album-edit="${escAttr(album.id)}" type="button" title="Editar">✎</button>
          <button class="btn btn-ghost btn-sm" data-album-delete="${escAttr(album.id)}" type="button" title="Excluir">🗑</button>
          <button class="album-toggle" data-album-toggle="${escAttr(album.id)}" type="button">▼</button>
        </div>
      </div>
      <div class="album-tracks">${isExpanded ? renderTracksList(album.id, tracks) : ''}</div>
    </div>
  `;
}

function renderTracksList(albumId, tracks) {
  const addBtn = `
    <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" data-track-new="${escAttr(albumId)}" type="button">+ Nova faixa</button>
    </div>`;

  if (tracks?.error) {
    return `<div class="admin-error-box" style="margin-top:1rem;"><p>${esc(tracks.error)}</p></div>${addBtn}`;
  }
  if (!Array.isArray(tracks) || !tracks.length) {
    return `<p class="admin-empty">Nenhuma faixa cadastrada.</p>${addBtn}`;
  }

  return `
    <table class="admin-table" style="margin-top:0.5rem;">
      <thead>
        <tr>
          <th style="width:32px;"></th><th style="width:40px;">#</th><th>Título</th>
          <th style="width:100px;">Duração</th><th style="width:100px;">Preço</th>
          <th style="width:120px;">Áudio</th><th style="width:100px;">Status</th><th style="width:240px;">Ações</th>
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
  const hasPreview = !!track.previewPath || !!track.preview_path;
  const hasFull = !!track.fullPath || !!track.full_path;

  const audioChips = `
    <span class="audio-chip ${hasPreview ? '' : 'none'}" title="Preview">${hasPreview ? 'P' : '—'}</span>
    <span class="audio-chip ${hasFull ? '' : 'none'}" title="Completo">${hasFull ? 'F' : '—'}</span>`;

  const isPublished = track.status === 'PUBLISHED' || track.published;
  const statusBadge = isPublished
    ? '<span class="badge-mini badge-premium">Pub</span>'
    : '<span class="badge-mini badge-free">Rasc</span>';

  const price = Number(track.priceCents || track.price_cents) || 0;

  return `
    <tr data-track-id="${escAttr(String(track.id))}" data-track-index="${Number(track.trackNumber || track.track_index) || 0}" draggable="true" class="track-row">
      <td class="track-drag-cell"><span class="track-drag-handle">⋮⋮</span></td>
      <td>${idx + 1}</td>
      <td>${esc(track.title || '—')}</td>
      <td>${esc(track.duration || '—')}</td>
      <td>R$ ${(price / 100).toFixed(2).replace('.', ',')}</td>
      <td><span style="display:inline-flex;gap:4px;">${audioChips}</span></td>
      <td>${statusBadge}</td>
      <td>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" data-track-download="${escAttr(String(track.id))}" data-track-download-title="${escAttr(track.title || '')}" type="button" ${hasFull ? '' : 'disabled'}>⬇ Baixar</button>
          <button class="btn btn-ghost btn-sm" data-track-edit="${escAttr(String(track.id))}" data-track-album="${escAttr(albumId)}" type="button">✎ Editar</button>
          <button class="btn btn-ghost btn-sm" data-track-delete="${escAttr(String(track.id))}" data-track-album="${escAttr(albumId)}" type="button">🗑</button>
        </div>
      </td>
    </tr>`;
}

// ─────────────────────────────────────────────────────────────
// Modal — Álbum
// ─────────────────────────────────────────────────────────────
function openAlbumModal(album) {
  const isNew = !album;
  const a = album || { id: '', title: '', coverUrl: '', year: new Date().getFullYear(), published: false };

  openAdminModal(`
    <h3>${isNew ? 'Novo álbum' : 'Editar álbum'}</h3>
    <div class="form-group">
      <label>Título *</label>
      <input type="text" id="albumTitle" value="${escAttr(a.title)}" required>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Ano</label><input type="number" id="albumYear" value="${escAttr(String(a.year || ''))}"></div>
      <div class="form-group"><label>URL da capa</label><input type="text" id="albumCoverUrl" value="${escAttr(a.coverUrl || a.cover_image || '')}"></div>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:0.5rem;"><input type="checkbox" id="albumPublished" ${a.published ? 'checked' : ''}> Publicar álbum</label>
    </div>
    <div class="form-error" id="albumError"></div>
    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" data-close type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="albumSave" type="button">${isNew ? 'Criar' : 'Salvar'}</button>
    </div>
  `);

  document.getElementById('albumSave')?.addEventListener('click', async () => {
    const errEl = document.getElementById('albumError');
    const payload = {
      title: document.getElementById('albumTitle').value.trim(),
      year: Number(document.getElementById('albumYear').value) || null,
      coverUrl: document.getElementById('albumCoverUrl').value.trim(),
      published: document.getElementById('albumPublished').checked
    };

    if (!payload.title) { if (errEl) errEl.textContent = 'Título obrigatório.'; return; }

    try {
      if (isNew) await apiFetch('albums', { method: 'POST', body: payload });
      else await apiFetch('album', { method: 'PATCH', query: { id: a.id }, body: payload });
      toast('Álbum salvo.', '💿');
      closeAdminModal();
      await loadAlbums();
    } catch (err) {
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar.';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Modal — Faixa
// ─────────────────────────────────────────────────────────────
function openTrackModal(albumId, track) {
  const isNew = !track;
  const t = track || { id: null, title: '', duration: '', priceCents: 499, status: 'DRAFT', previewPath: null, fullPath: null, lyrics: [] };
  const lyricsText = Array.isArray(t.lyrics) && t.lyrics.length ? JSON.stringify(t.lyrics, null, 2) : '[]';

  openAdminModal(`
    <h3>${isNew ? 'Nova faixa' : 'Editar faixa'}</h3>
    <div class="form-group"><label>Título *</label><input type="text" id="trackTitle" value="${escAttr(t.title)}" required></div>
    <div class="form-row">
      <div class="form-group"><label>Duração (mm:ss)</label><input type="text" id="trackDuration" value="${escAttr(t.duration || '')}"></div>
      <div class="form-group"><label>Preço (centavos)</label><input type="number" id="trackPrice" value="${escAttr(String(t.priceCents || 0))}"></div>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:0.5rem;"><input type="checkbox" id="trackPublished" ${t.status === 'PUBLISHED' ? 'checked' : ''}> Publicar faixa</label>
    </div>
    
    <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
      <h4 style="margin:0 0 0.5rem;font-size:0.9rem;color:var(--accent);">🎧 Prévia</h4>
      <div data-preview-status style="font-size:0.85rem;margin-bottom:0.5rem;">${t.previewPath ? `<span class="audio-chip">✓ ${esc(t.previewPath)}</span>` : '<span class="audio-chip none">Nenhum</span>'}</div>
      <button class="btn btn-outline btn-sm" data-upload-preview type="button">⬆ Enviar</button>
      <input type="file" id="trackPreviewInput" accept="audio/*" hidden>
    </div>
    <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
      <h4 style="margin:0 0 0.5rem;font-size:0.9rem;color:var(--accent);">🎵 Áudio Completo</h4>
      <div data-full-status style="font-size:0.85rem;margin-bottom:0.5rem;">${t.fullPath ? `<span class="audio-chip">✓ ${esc(t.fullPath)}</span>` : '<span class="audio-chip none">Nenhum</span>'}</div>
      <button class="btn btn-outline btn-sm" data-upload-full type="button">⬆ Enviar</button>
      <input type="file" id="trackFullInput" accept="audio/*" hidden>
    </div>
    
    <div class="form-group">
      <label>Letra (JSON)</label>
      <textarea id="trackLyrics" rows="8" style="font-family:monospace;">${esc(lyricsText)}</textarea>
    </div>
    
    <div class="form-error" id="trackError"></div>
    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" data-close type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="trackSave" type="button">${isNew ? 'Criar' : 'Salvar'}</button>
    </div>
  `);

  bindTrackUpload({ buttonSel: '[data-upload-preview]', inputId: 'trackPreviewInput', statusSel: '[data-preview-status]', kind: 'audio-preview', uploadFn: uploadAudioPreview, field: 'previewPath', albumId, track: t });
  bindTrackUpload({ buttonSel: '[data-upload-full]', inputId: 'trackFullInput', statusSel: '[data-full-status]', kind: 'audio-full', uploadFn: uploadAudioFull, field: 'fullPath', albumId, track: t });

  document.getElementById('trackSave')?.addEventListener('click', async () => {
    const errEl = document.getElementById('trackError');
    const lyrics = parseLyricsInput(document.getElementById('trackLyrics').value);

    if (lyrics === null) { if (errEl) errEl.textContent = 'Letra inválida. Verifique o JSON.'; return; }

    const priceCents = Number(document.getElementById('trackPrice').value);
    if (!Number.isInteger(priceCents) || priceCents < 0) { if (errEl) errEl.textContent = 'Preço inválido.'; return; }

    const payload = {
      title: document.getElementById('trackTitle').value.trim(),
      duration: document.getElementById('trackDuration').value.trim(),
      priceCents: priceCents,
      status: document.getElementById('trackPublished').checked ? 'PUBLISHED' : 'DRAFT'
    };

    if (!payload.title) { if (errEl) errEl.textContent = 'Título obrigatório.'; return; }

    try {
      let savedTrackId = t.id;
      if (isNew) {
        const res = await apiFetch('tracks', { method: 'POST', body: { ...payload, albumId: albumId } });
        savedTrackId = res.track.id; // Pega o UUID gerado
      } else {
        await apiFetch('track', { method: 'PATCH', query: { id: t.id }, body: payload });
      }

      // Integração com o endpoint de letras (Item 3)
      await apiFetch('update-lyrics', { method: 'PATCH', query: { id: savedTrackId }, body: { lyrics } });

      toast('Faixa salva.', '🎵');
      closeAdminModal();
      await loadTracksForAlbum(albumId);
      repaint();
    } catch (err) {
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar.';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Upload de Faixa
// ─────────────────────────────────────────────────────────────
function bindTrackUpload({ buttonSel, inputId, statusSel, kind, uploadFn, field, albumId, track }) {
  const button = document.querySelector(buttonSel);
  const input = document.getElementById(inputId);
  const statusEl = document.querySelector(statusSel);

  if (!button || !input) return;
  button.addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!track.id) { toast('Salve a faixa antes de enviar o áudio.', '⚠'); input.value = ''; return; }

    const original = button.textContent;
    try {
      button.disabled = true;
      button.textContent = 'Enviando…';
      if (statusEl) statusEl.innerHTML = '<span class="audio-chip">⬆ 0%</span>';

      const result = await uploadFn(file, (pct) => {
        if (statusEl) statusEl.innerHTML = `<span class="audio-chip">⬆ ${pct}%</span>`;
      });

      if (!result?.path) throw new Error('Upload não retornou path.');

      // O campo agora usa camelCase ('previewPath' ou 'fullPath')
      await apiFetch('track', { method: 'PATCH', query: { id: track.id }, body: { [field]: result.path } });
      track[field] = result.path;

      if (statusEl) statusEl.innerHTML = `<span class="audio-chip">✓ ${esc(result.path)}</span>`;
      toast('Áudio associado.', '✓');

      // Item 5: Aguardar o load antes de repintar
      await loadTracksForAlbum(albumId);
      repaint();

    } catch (err) {
      toast(err?.message || 'Falha no upload.', '⚠');
      if (statusEl) statusEl.innerHTML = '<span class="audio-chip none">Falha no upload</span>';
    } finally {
      button.disabled = false;
      button.textContent = original;
      input.value = '';
    }
  });
}