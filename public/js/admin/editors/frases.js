/* ============================================================
   admin/editors/frases.js — Editor de frases (v2 Corrigida)
   ------------------------------------------------------------
   - Adiciona / edita / remove / reordena
   - Proteção contra dados malformados (sem apagar silenciosamente)
   - Limites de tamanho para texto, autor e quantidade de frases
   - markDirty() aplicado em todas as alterações
   - Preview em tempo real
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Constantes de Limite
// ─────────────────────────────────────────────────────────────
const MAX_FRASES = 500;
const MAX_TEXT_LEN = 2000;
const MAX_AUTHOR_LEN = 120;

// ─────────────────────────────────────────────────────────────
// Render principal
// ─────────────────────────────────────────────────────────────
export function renderFrasesEditor(content = AdminState.content) {
  const wrap = document.getElementById('frasesEditor');
  if (!wrap) return;

  // 1. Validação do Objeto Principal
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    wrap.innerHTML = '<div class="admin-error-box"><p>Conteúdo administrativo inválido.</p></div>';
    return;
  }

  // 2. Validação da Estrutura Filosofia
  if (!content.filosofia || typeof content.filosofia !== 'object') {
    content.filosofia = { frases: [] };
  }

  if (!Array.isArray(content.filosofia.frases)) {
    wrap.innerHTML = '<div class="admin-error-box"><p>A estrutura das frases está inválida. Verifique os dados no banco antes de editar.</p></div>';
    toast('Estrutura de frases inválida.', '⚠');
    return;
  }

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
// Render de UMA frase (com tratamento de dados malformados)
// ─────────────────────────────────────────────────────────────
function renderFrase(f, i, total) {
  // Normaliza a frase para não quebrar o HTML
  const safeFrase = (f && typeof f === 'object') ? f : {};
  const text = typeof safeFrase.text === 'string' ? safeFrase.text : '';
  const author = typeof safeFrase.author === 'string' ? safeFrase.author : 'Joseph Matthos';

  const previewHTML = text
    ? `<div class="frase-preview">
         <p>"${esc(text)}"</p>
         <span class="author">— ${esc(author)}</span>
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
        <label for="fraseText${i}">Texto (máx ${MAX_TEXT_LEN})</label>
        <textarea id="fraseText${i}"
                  rows="3"
                  maxlength="${MAX_TEXT_LEN}"
                  data-field="text"
                  data-i="${i}"
                  placeholder="Digite a frase...">${esc(text)}</textarea>
        <small class="hint">${text.length} caracteres</small>
      </div>

      <div class="form-group">
        <label for="fraseAuthor${i}">Autor (máx ${MAX_AUTHOR_LEN})</label>
        <input type="text"
               id="fraseAuthor${i}"
               maxlength="${MAX_AUTHOR_LEN}"
               value="${esc(author)}"
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
  // ── Inputs (texto e autor)
  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      const frases = content.filosofia.frases;

      if (!frases[i] || typeof frases[i] !== 'object') {
        frases[i] = { text: '', author: 'Joseph Matthos' };
      }

      // Compara o valor antigo com o novo para evitar markDirty desnecessário
      if (frases[i][field] !== el.value) {
        frases[i][field] = el.value;
        markDirty();
      }

      // Atualiza contador de caracteres
      if (field === 'text') {
        const hintEl = el.parentElement?.querySelector('.hint');
        if (hintEl) hintEl.textContent = `${el.value.length} caracteres`;
      }

      // Atualiza preview
      updatePreview(wrap, i, frases[i]);
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
// Preview em tempo real
// ─────────────────────────────────────────────────────────────
function updatePreview(wrap, i, frase) {
  const previewEl = wrap.querySelector(`[data-preview-for="${i}"]`);
  if (!previewEl) return;

  const text = typeof frase?.text === 'string' ? frase.text : '';
  const author = typeof frase?.author === 'string' ? frase.author : 'Joseph Matthos';

  if (!text) {
    previewEl.innerHTML = '<p class="hint" style="color:var(--text-dim);font-size:0.8rem;">A frase aparecerá aqui conforme você digita.</p>';
    return;
  }

  previewEl.innerHTML = `
    <div class="frase-preview">
      <p>"${esc(text)}"</p>
      <span class="author">— ${esc(author)}</span>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────
// Ações: adicionar / remover / mover (com validação)
// ─────────────────────────────────────────────────────────────
function addFrase(content) {
  const frases = content?.filosofia?.frases;

  if (!Array.isArray(frases)) {
    toast('Não foi possível adicionar a frase.', '⚠');
    return;
  }

  if (frases.length >= MAX_FRASES) {
    toast(`Limite máximo de ${MAX_FRASES} frases atingido.`, '⚠');
    return;
  }

  frases.push({
    text: '',
    author: 'Joseph Matthos'
  });

  markDirty();
  renderFrasesEditor(content);

  // Auto-focus + scroll na nova frase
  setTimeout(() => {
    const lastIdx = frases.length - 1;
    const wrap = document.getElementById('frasesEditor');
    if (!wrap) return;

    const newCard = wrap.querySelector(`[data-i="${lastIdx}"].frase-editor`);
    if (newCard) {
      newCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      newCard.querySelector('[data-field="text"]')?.focus();
    }
  }, 0);

  toast('Frase adicionada. Lembre de salvar.', '✦');
}

function removeFrase(content, index) {
  const frases = content?.filosofia?.frases;

  if (
    !Array.isArray(frases) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= frases.length
  ) {
    return;
  }

  const frase = frases[index];
  const text = typeof frase?.text === 'string' ? frase.text : '';
  const preview = text.slice(0, 60);

  const msg = preview
    ? `Remover esta frase?\n\n"${preview}${text.length > 60 ? '…' : ''}"`
    : 'Remover esta frase vazia?';

  if (!window.confirm(msg)) return;

  frases.splice(index, 1);

  markDirty();
  renderFrasesEditor(content);

  toast('Frase removida. Lembre de salvar.', '🗑');
}

function moveFrase(content, index, delta) {
  const arr = content?.filosofia?.frases;

  if (
    !Array.isArray(arr) ||
    !Number.isInteger(index) ||
    !Number.isInteger(delta) ||
    ![-1, 1].includes(delta) ||
    index < 0 ||
    index >= arr.length
  ) {
    return;
  }

  const target = index + delta;
  if (target < 0 || target >= arr.length) return;

  [arr[index], arr[target]] = [arr[target], arr[index]];

  markDirty();
  renderFrasesEditor(content);
}