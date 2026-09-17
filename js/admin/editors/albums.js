/* ============================================================
   admin/editors/albums.js — Editor de álbuns
   ============================================================ */

import { AdminState } from '../state.js';
import { esc } from '../ui/dom.js';

export function renderAlbumsEditor(content = AdminState.content) {
  const wrap = document.getElementById('albumsEditor');
  if (!wrap) return;

  if (!content.discografia) content.discografia = {};
  if (!Array.isArray(content.discografia.albums)) content.discografia.albums = [];

  const albums = content.discografia.albums;

  if (!albums.length) {
    wrap.innerHTML = '<p class="hint" style="color:var(--text-dim);padding:1rem;">Nenhum álbum ainda. Clique em "+ Adicionar álbum".</p>';
    return;
  }

  wrap.innerHTML = albums.map((al, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>${esc(al.title || 'Sem título')} <span style="color:var(--text-dim);font-weight:400;font-size:0.75rem;">(${esc(al.type || 'album')})</span></strong>
        <div>
          <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" aria-label="Remover">🗑</button>
        </div>
      </div>
      <div style="color:var(--text-dim);font-size:0.8rem;">
        ${(al.tracks || []).length} faixa(s) · ${esc(al.year || '—')}
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-action="edit"]').forEach((b) =>
    b.addEventListener('click', () => openAlbumModal(Number(b.dataset.i))));

  wrap.querySelectorAll('[data-action="remove"]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (!confirm('Remover este álbum e todas as faixas?')) return;
      content.discografia.albums.splice(i, 1);
      renderAlbumsEditor(content);
    }));
}

export function bindAlbumsAddButton() {
  const btn = document.getElementById('addAlbumBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    const content = AdminState.content;
    if (!content.discografia) content.discografia = {};
    if (!Array.isArray(content.discografia.albums)) content.discografia.albums = [];
    content.discografia.albums.push({
      id: 'album-' + Date.now().toString(36),
      type: 'single',
      title: 'Novo álbum',
      year: new Date().getFullYear(),
      cover: 'NN',
      coverImage: '',
      description: '',
      tracks: []
    });
    renderAlbumsEditor(content);
  });
}

function openAlbumModal(index) {
  const content = AdminState.content;
  const al = content.discografia.albums[index];
  if (!al) return;

  // Para simplificar, edita os campos direto sem modal complexo
  const title = prompt('Título do álbum:', al.title || '');
  if (title !== null) al.title = title;

  const yearStr = prompt('Ano:', String(al.year || new Date().getFullYear()));
  if (yearStr !== null) al.year = parseInt(yearStr, 10) || al.year;

  renderAlbumsEditor(content);
}
