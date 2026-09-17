/* ============================================================
   admin/editors/frases.js — Editor de frases
   ============================================================ */

import { AdminState } from '../state.js';
import { esc } from '../ui/dom.js';

export function renderFrasesEditor(content = AdminState.content) {
  const wrap = document.getElementById('frasesEditor');
  if (!wrap) return;

  // Garante a estrutura mínima
  if (!content.filosofia) content.filosofia = {};
  if (!Array.isArray(content.filosofia.frases)) content.filosofia.frases = [];

  const frases = content.filosofia.frases;

  if (!frases.length) {
    wrap.innerHTML = '<p class="hint" style="color:var(--text-dim);padding:1rem;">Nenhuma frase ainda. Clique em "+ Adicionar frase".</p>';
    return;
  }

  wrap.innerHTML = frases.map((f, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>Frase ${i + 1}</strong>
        <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" aria-label="Remover">🗑 Remover</button>
      </div>
      <div class="form-group">
        <label>Texto</label>
        <textarea data-field="text" data-i="${i}">${esc(f.text || '')}</textarea>
      </div>
      <div class="form-group">
        <label>Autor</label>
        <input type="text" value="${esc(f.author || '')}" data-field="author" data-i="${i}">
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (!content.filosofia.frases[i]) content.filosofia.frases[i] = {};
      content.filosofia.frases[i][field] = el.value;
    });
  });

  wrap.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      content.filosofia.frases.splice(i, 1);
      renderFrasesEditor(content);
    });
  });
}
