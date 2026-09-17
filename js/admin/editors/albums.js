/* ============================================================
   admin/editors/albums.js — Editor de álbuns, EPs e singles
   ------------------------------------------------------------
   - Lista de álbuns com botões Editar/Remover
   - Modal de edição com faixas, uploads (áudio + capa)
   - Sem localStorage/IndexedDB — uploads vão para /api/admin/upload
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { uploadAudio, uploadImage } from '../uploads.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Lista
// ─────────────────────────────────────────────────────────────
export function renderAlbumsEditor(content = AdminState.content) {
  const wrap = document.getElementById('albumsEditor');
  if (!wrap) return;

  wrap.innerHTML = content.discografia.albums.map((al, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>${esc(al.title)}
          <span style="color:var(--text-dim);font-weight:400;font-size:0.75rem;">(${esc(al.type)})</span>
        </strong>
        <div>
          <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" aria-label="Remover">🗑</button>
        </div>
      </div>
      <div style="color:var(--text-dim);font-size:0.8rem;">
        ${al.tracks.length} faixa(s) · ${esc(al.year)}
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-action="edit"]').forEach((b) =>
    b.addEventListener('click', () => openAlbumModal(Number(b.dataset.i))));
  wrap.querySelectorAll('[data-action="remove"]').forEach((b) =>
    b.addEventListener('click', () => removeAlbum(Number(b.dataset.i))));
}

function removeAlbum(i) {
  if (!confirm('Remover este álbum e todas as faixas?')) return;
  AdminState.content.discografia.albums.splice(i, 1);
  renderAlbumsEditor(AdminState.content);
}

// Registra o botão "+ Adicionar" uma vez
export function bindAlbumsAddButton() {
  const btn = document.getElementById('addAlbumBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => openAlbumModal(-1));
}

// ─────────────────────────────────────────────────────────────
// Modal de edição
// ─────────────────────────────────────────────────────────────
function openAlbumModal(index) {
  const isNew = index < 0;
  const al = isNew
    ? {
        id: generateId('album'),
        type: 'single',
        title: 'Novo',
        year: new Date().getFullYear(),
        cover: 'NN',
        coverImage: '',
        description: '',
        tracks: []
      }
    : JSON.parse(JSON.stringify(AdminState.content.discografia.albums[index]));

  openAdminModal(`
    <h3>${isNew ? 'Novo álbum/EP/single' : 'Editar álbum'}</h3>

    <div class="form-row">
      <div class="form-group"><label>Título</label>
        <input type="text" id="amTitle" value="${esc(al.title)}"></div>
      <div class="form-group"><label>Tipo</label>
        <select id="amType">
          <option value="album" ${al.type === 'album' ? 'selected' : ''}>Álbum</option>
          <option value="ep" ${al.type === 'ep' ? 'selected' : ''}>EP</option>
          <option value="single" ${al.type === 'single' ? 'selected' : ''}>Single</option>
        </select>
      </div>
    </div>

    <div class="form-row-3">
      <div class="form-group"><label>Ano</label>
        <input type="number" id="amYear" value="${al.year}"></div>
      <div class="form-group"><label>Iniciais</label>
        <input type="text" id="amCover" maxlength="3" value="${esc(al.cover)}"></div>
      <div class="form-group"><label>ID interno</label>
        <input type="text" value="${esc(al.id)}" disabled></div>
    </div>

    <div class="form-group"><label>Descrição</label>
      <textarea id="amDesc">${esc(al.description)}</textarea></div>

    <div class="form-group"><label>URL da capa</label>
      <input type="text" id="amCoverImage" value="${esc(al.coverImage)}"
             placeholder="https://... ou deixe vazio"></div>
    <div class="upload-zone" id="amCoverUploadBtn">📁 Ou enviar capa</div>
    <input type="file" id="amCoverUpload" accept="image/*" style="display:none;">
    <div class="admin-img-preview" id="amCoverPreview"
         style="${al.coverImage ? `background-image:url('${esc(al.coverImage)}')` : ''}">
      ${al.coverImage ? '' : 'Sem capa'}
    </div>

    <h3 style="margin-top:1.5rem;">Faixas</h3>
    <div id="amTracks"></div>
    <button class="btn btn-outline btn-sm" id="amAddTrackBtn" style="margin-top:0.5rem;">
      + Adicionar faixa
    </button>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="amCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="amSave">Salvar álbum</button>
    </div>
  `);

  // ── Faixas
  const tracksWrap = document.getElementById('amTracks');

  const renderTracks = () => {
    tracksWrap.innerHTML = al.tracks.map((t, ti) => `
      <div class="track-editor" data-track="${ti}">
        <div class="track-head">
          <strong>Faixa ${ti + 1}: ${esc(t.title || 'Sem título')}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove-track" data-ti="${ti}" aria-label="Remover">🗑</button>
        </div>

        <div class="form-row">
          <div class="form-group"><label>Título</label>
            <input type="text" value="${esc(t.title || '')}"
                   data-track-field="title" data-ti="${ti}"></div>
          <div class="form-group"><label>Duração (4:32)</label>
            <input type="text" value="${esc(t.duration || '')}"
                   data-track-field="duration" data-ti="${ti}"></div>
        </div>

        <div class="form-group">
          <label>Letra sincronizada (mm:ss|texto)</label>
          <textarea rows="4" data-track-field="lyricsText" data-ti="${ti}"
                    placeholder="0:12|Primeira linha">${esc(lyricsToText(t.lyrics))}</textarea>
        </div>

        <div class="form-group">
          <label>Faixa completa (Premium + base da prévia)</label>
          <input type="text" value="${esc(t.fullAudio || '')}"
                 data-track-field="fullAudio" data-ti="${ti}"
                 placeholder="https://... ou envie abaixo">
          <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm"
                    data-action="upload-full" data-ti="${ti}">📁 Enviar áudio</button>
            ${audioChip(t.fullAudio)}
          </div>
          <input type="file" accept="audio/*" style="display:none;"
                 data-upload-full data-ti="${ti}">
        </div>

        <div class="form-group">
          <label>Prévia dedicada (opcional)</label>
          <input type="text" value="${esc(t.previewAudio || '')}"
                 data-track-field="previewAudio" data-ti="${ti}"
                 placeholder="Vazio = corta a completa">
          <div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost btn-sm"
                    data-action="upload-preview" data-ti="${ti}">📁 Enviar prévia</button>
            ${t.previewAudio ? audioChip(t.previewAudio) : ''}
          </div>
          <input type="file" accept="audio/*" style="display:none;"
                 data-upload-preview data-ti="${ti}">
        </div>

        <div class="form-row">
          <div class="form-group"><label>Início da prévia (s)</label>
            <input type="number" min="0" value="${parseInt(t.previewStart) || 0}"
                   data-track-field="previewStart" data-ti="${ti}"></div>
          <div class="form-group"><label>Duração da prévia (s)</label>
            <input type="number" min="5" max="120" value="${parseInt(t.previewDuration) || 30}"
                   data-track-field="previewDuration" data-ti="${ti}"></div>
        </div>
      </div>`).join('');

    // Bind de campos
    tracksWrap.querySelectorAll('[data-track-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const ti = Number(el.dataset.ti);
        const key = el.dataset.trackField;
        if (key === 'lyricsText') {
          al.tracks[ti].lyrics = textToLyrics(el.value);
        } else if (key === 'previewStart' || key === 'previewDuration') {
          al.tracks[ti][key] = parseInt(el.value) || 0;
        } else {
          al.tracks[ti][key] = el.value;
        }
      });
    });

    // Remover faixa
    tracksWrap.querySelectorAll('[data-action="remove-track"]').forEach((b) => {
      b.addEventListener('click', () => {
        const ti = Number(b.dataset.ti);
        al.tracks.splice(ti, 1);
        renderTracks();
      });
    });

    // Uploads
    tracksWrap.querySelectorAll('[data-action="upload-full"]').forEach((b) => {
      b.addEventListener('click', () => {
        tracksWrap.querySelector(`input[data-upload-full][data-ti="${b.dataset.ti}"]`).click();
      });
    });
    tracksWrap.querySelectorAll('[data-action="upload-preview"]').forEach((b) => {
      b.addEventListener('click', () => {
        tracksWrap.querySelector(`input[data-upload-preview][data-ti="${b.dataset.ti}"]`).click();
      });
    });
    tracksWrap.querySelectorAll('input[data-upload-full]').forEach((inp) => {
      inp.addEventListener('change', () => onAudioUpload(inp, al, Number(inp.dataset.ti), 'fullAudio', renderTracks));
    });
    tracksWrap.querySelectorAll('input[data-upload-preview]').forEach((inp) => {
      inp.addEventListener('change', () => onAudioUpload(inp, al, Number(inp.dataset.ti), 'previewAudio', renderTracks));
    });
  };

  renderTracks();

  // ── Upload de capa
  const coverUploadBtn = document.getElementById('amCoverUploadBtn');
  const coverUploadInput = document.getElementById('amCoverUpload');
  if (coverUploadBtn && coverUploadInput) {
    coverUploadBtn.addEventListener('click', () => coverUploadInput.click());
    coverUploadInput.addEventListener('change', async () => {
      const f = coverUploadInput.files[0];
      if (!f) return;
      try {
        toast('Enviando capa...', '⬆');
        al.coverImage = await uploadImage(f);
        const p = document.getElementById('amCoverPreview');
        p.style.backgroundImage = `url('${al.coverImage}')`;
        p.textContent = '';
        document.getElementById('amCoverImage').value = al.coverImage;
        toast('Capa atualizada.', '✓');
      } catch (err) {
        toast(err.message || 'Erro no upload.', '⚠');
      } finally {
        coverUploadInput.value = '';
      }
    });
  }

  // ── URL manual da capa
  const coverImageInput = document.getElementById('amCoverImage');
  if (coverImageInput) {
    coverImageInput.addEventListener('input', () => {
      al.coverImage = coverImageInput.value.trim();
      const p = document.getElementById('amCoverPreview');
      if (al.coverImage) {
        p.style.backgroundImage = `url('${al.coverImage}')`;
        p.textContent = '';
      } else {
        p.style.backgroundImage = '';
        p.textContent = 'Sem capa';
      }
    });
  }

  // ── Adicionar faixa
  document.getElementById('amAddTrackBtn').addEventListener('click', () => {
    al.tracks.push({
      title: 'Nova faixa',
      fullAudio: '',
      previewAudio: '',
      previewStart: 0,
      previewDuration: 30,
      duration: '0:00',
      forSale: true,
      lyrics: []
    });
    renderTracks();
  });

  // ── Cancelar / Salvar
  document.getElementById('amCancel').addEventListener('click', () => closeAdminModal());
  document.getElementById('amSave').addEventListener('click', () => {
    al.title = document.getElementById('amTitle').value.trim() || 'Sem título';
    al.type = document.getElementById('amType').value;
    al.year = parseInt(document.getElementById('amYear').value, 10) || new Date().getFullYear();
    al.cover = (document.getElementById('amCover').value || 'NN').slice(0, 3);
    al.description = document.getElementById('amDesc').value;
    al.coverImage = document.getElementById('amCoverImage').value.trim() || al.coverImage || '';

    if (isNew) AdminState.content.discografia.albums.push(al);
    else AdminState.content.discografia.albums[index] = al;

    renderAlbumsEditor(AdminState.content);
    closeAdminModal();
    toast('Álbum salvo. Lembre de clicar em "Salvar" no topo.', '💿');
  });
}

// ─────────────────────────────────────────────────────────────
// Upload de áudio
// ─────────────────────────────────────────────────────────────
async function onAudioUpload(inputEl, album, ti, key, rerender) {
  const file = inputEl.files[0];
  if (!file) return;
  try {
    toast('Enviando áudio...', '⬆');
    const url = await uploadAudio(file);
    album.tracks[ti][key] = url;
    rerender();
    toast('Áudio enviado.', '✓');
  } catch (err) {
    toast(err.message || 'Erro no upload.', '⚠');
  } finally {
    inputEl.value = '';
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function audioChip(url) {
  if (!url) return '<span class="audio-chip none">⚠ sem áudio</span>';
  return `<span class="audio-chip remote">🔗 ${/^https?:\/\//i.test(url) ? 'URL' : 'arquivo'}</span>`;
}

function lyricsToText(lyrics) {
  return (Array.isArray(lyrics) ? lyrics : []).map((line) => {
    const s = Number(line.time) || 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, '0')}|${String(line.text || '')}`;
  }).join('\n');
}

function textToLyrics(value) {
  return String(value || '').split('\n').map((line) => {
    const parts = line.split('|');
    if (parts.length < 2) return null;
    const stamp = parts.shift().trim().split(':');
    const time = stamp.length === 2 ? Number(stamp[0]) * 60 + Number(stamp[1]) : Number(stamp[0]);
    const text = parts.join('|').trim();
    return Number.isFinite(time) && time >= 0 && text ? { time, text } : null;
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

function generateId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}