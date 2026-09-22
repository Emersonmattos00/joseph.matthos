/* ============================================================
   admin/editors/frases.js — Editor de frases (filosofia)
   ------------------------------------------------------------
   - Adiciona / edita / remove / reordena
   - Exclusão com confirmação
   - Preview em tempo real (com tipografia do site)
   - Contador de frases
   - Auto-scroll ao adicionar nova frase
   ============================================================ */

import { AdminState } from '../state.js';
import { esc } from '../ui/dom.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Render principal
// ─────────────────────────────────────────────────────────────
export function renderFrasesEditor(content = AdminState.content) {
  const wrap = document.getElementById('frasesEditor');
  if (!wrap) return;

  // Garante estrutura mínima
  if (!content.filosofia) content.filosofia = {};
  if (!Array.isArray(content.filosofia.frases)) content.filosofia.frases = [];

  const frases = content.filosofia.frases;

  // ── Cabeçalho com contador
  const header = `
    <div class="frases-editor__header">
      <span class="frases-editor__count">
        ${frases.length} ${frases.length === 1 ? 'frase' : 'frases'}
      </span>
      <button type="button" class="btn btn-outline btn-sm" id="frasesAddTop">
        + Adicionar frase
      </button>
    </div>
  `;

  // ── Estado vazio
  if (!frases.length) {
    wrap.innerHTML = `
      ${header}
      <p class="admin-empty">
        Nenhuma frase ainda. Clique em "Adicionar frase" para começar.
      </p>
    `;
    bindHeader(wrap, content);
    return;
  }

  // ── Lista de frases
  wrap.innerHTML = `
    ${header}
    <div class="frases-editor__list">
      ${frases.map((f, i) => renderFrase(f, i, frases.length)).join('')}
    </div>
  `;

  bindHeader(wrap, content);
  bindFrases(wrap, content);
}

// ─────────────────────────────────────────────────────────────
// Render de UMA frase
// ─────────────────────────────────────────────────────────────
function renderFrase(f, i, total) {
  const previewHTML = f.text
    ? `<div class="frase-preview">
         <p>"${esc(f.text)}"</p>
         <span class="author">— ${esc(f.author || 'Joseph Matthos')}</span>
       </div>`
    : '';

  return `
    <div class="track-editor frase-editor" data-i="${i}">
      <div class="track-head">
        <div class="frase-editor__order">
          <button type="button"
                  class="frase-order-btn"
                  data-action="move-up"
                  data-i="${i}"
                  ${i === 0 ? 'disabled' : ''}
                  title="Subir">↑</button>
          <button type="button"
                  class="frase-order-btn"
                  data-action="move-down"
                  data-i="${i}"
                  ${i === total - 1 ? 'disabled' : ''}
                  title="Descer">↓</button>
          <strong>Frase ${i + 1}</strong>
        </div>
        <button type="button"
                class="btn btn-ghost btn-sm"
                data-action="remove"
                data-i="${i}"
                style="color:var(--danger);"
                aria-label="Remover frase ${i + 1}">🗑 Remover</button>
      </div>

      <div class="form-group">
        <label for="fraseText${i}">Texto</label>
        <textarea id="fraseText${i}"
                  rows="3"
                  data-field="text"
                  data-i="${i}"
                  placeholder="Digite a frase...">${esc(f.text || '')}</textarea>
        <small class="hint">${(f.text || '').length} caracteres</small>
      </div>

      <div class="form-group">
        <label for="fraseAuthor${i}">Autor</label>
        <input type="text"
               id="fraseAuthor${i}"
               value="${esc(f.author || '')}"
               data-field="author"
               data-i="${i}"
               placeholder="Joseph Matthos">
      </div>

      <div class="form-group">
        <label>Preview (como aparece no site)</label>
        <div class="frase-editor__preview-wrap" data-preview-for="${i}">
          ${previewHTML || '<p class="hint" style="color:var(--text-dim);font-size:0.8rem;">A frase aparecerá aqui conforme você digita.</p>'}
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Bind: cabeçalho
// ─────────────────────────────────────────────────────────────
function bindHeader(wrap, content) {
  const addTop = document.getElementById('frasesAddTop');
  if (addTop && addTop.dataset.bound !== '1') {
    addTop.dataset.bound = '1';
    addTop.addEventListener('click', () => addFrase(content));
  }
}

// ─────────────────────────────────────────────────────────────
// Bind: ações das frases
// ─────────────────────────────────────────────────────────────
function bindFrases(wrap, content) {
  // ── Inputs (texto e autor) — atualizam modelo + preview em tempo real
  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (!content.filosofia.frases[i]) content.filosofia.frases[i] = {};
      content.filosofia.frases[i][field] = el.value;

      // Atualiza contador de caracteres
      if (field === 'text') {
        const hintEl = el.parentElement?.querySelector('.hint');
        if (hintEl) hintEl.textContent = `${el.value.length} caracteres`;
      }

      // Atualiza preview sem re-renderizar tudo
      updatePreview(wrap, i, content.filosofia.frases[i]);
    });
  });

  // ── Remover
  wrap.querySelectorAll('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      removeFrase(content, i);
    });
  });

  // ── Reordenar
  wrap.querySelectorAll('[data-action="move-up"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      moveFrase(content, i, -1);
    });
  });

  wrap.querySelectorAll('[data-action="move-down"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.i);
      moveFrase(content, i, +1);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Preview em tempo real (sem re-render)
// ─────────────────────────────────────────────────────────────
function updatePreview(wrap, i, frase) {
  const previewEl = wrap.querySelector(`[data-preview-for="${i}"]`);
  if (!previewEl) return;

  if (!frase.text) {
    previewEl.innerHTML = '<p class="hint" style="color:var(--text-dim);font-size:0.8rem;">A frase aparecerá aqui conforme você digita.</p>';
    return;
  }

  previewEl.innerHTML = `
    <div class="frase-preview">
      <p>"${esc(frase.text)}"</p>
      <span class="author">— ${esc(frase.author || 'Joseph Matthos')}</span>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Ações: adicionar / remover / mover
// ─────────────────────────────────────────────────────────────
function addFrase(content) {
  content.filosofia.frases.push({
    text: '',
    author: 'Joseph Matthos'
  });
  renderFrasesEditor(content);

  // Auto-focus + scroll na nova frase
  setTimeout(() => {
    const lastIdx = content.filosofia.frases.length - 1;
    const wrap = document.getElementById('frasesEditor');
    if (!wrap) return;

    const newCard = wrap.querySelector(`[data-i="${lastIdx}"].frase-editor`);
    if (newCard) {
      newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const textarea = newCard.querySelector('[data-field="text"]');
      textarea?.focus();
    }
  }, 0);

  toast('Frase adicionada. Lembre de salvar.', '✦');
}

function removeFrase(content, index) {
  const frase = content.filosofia.frases[index];
  if (!frase) return;

  const preview = (frase.text || '').slice(0, 60);
  const msg = preview
    ? `Remover esta frase?\n\n"${preview}${frase.text.length > 60 ? '…' : ''}"`
    : 'Remover esta frase vazia?';

  if (!window.confirm(msg)) return;

  content.filosofia.frases.splice(index, 1);
  renderFrasesEditor(content);
  toast('Frase removida. Lembre de salvar.', '🗑');
}

function moveFrase(content, index, delta) {
  const arr = content.filosofia.frases;
  const target = index + delta;
  if (target < 0 || target >= arr.length) return;

  [arr[index], arr[target]] = [arr[target], arr[index]];
  renderFrasesEditor(content);
}
