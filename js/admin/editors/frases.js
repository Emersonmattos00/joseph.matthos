import { AdminState } from '../index.js';
import { esc } from '../ui/dom.js';

export function renderFrasesEditor(content = AdminState.content) {
  const wrap = document.getElementById('frasesEditor');
  if (!wrap) return;

  wrap.innerHTML = content.filosofia.frases.map((f, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>Frase ${i + 1}</strong>
        <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" aria-label="Remover">🗑 Remover</button>
      </div>
      <div class="form-group">
        <label>Texto</label>
        <textarea data-field="text" data-i="${i}">${esc(f.text)}</textarea>
      </div>
      <div class="form-group">
        <label>Autor</label>
        <input type="text" value="${esc(f.author)}" data-field="author" data-i="${i}">
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
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

// Botão "adicionar frase" — registrado uma vez no bootstrap (fora deste módulo)
// document.getElementById('addFraseBtn').addEventListener('click', () => { ... });