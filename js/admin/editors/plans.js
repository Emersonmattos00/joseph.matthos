/* ============================================================
   admin/editors/plans.js — Editor de planos
   ============================================================ */

import { AdminState } from '../state.js';
import { esc } from '../ui/dom.js';

export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  if (!content.planos) content.planos = {};
  if (!Array.isArray(content.planos.plans)) content.planos.plans = [];

  const plans = content.planos.plans;

  if (!plans.length) {
    wrap.innerHTML = '<p class="hint" style="color:var(--text-dim);padding:1rem;">Nenhum plano ainda.</p>';
    return;
  }

  wrap.innerHTML = plans.map((p, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>${esc(p.name || 'Plano')} ${p.badge ? '· ' + esc(p.badge) : ''}</strong>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Nome</label>
          <input value="${esc(p.name || '')}" data-field="name" data-i="${i}">
        </div>
        <div class="form-group">
          <label>Descrição</label>
          <input value="${esc(p.desc || '')}" data-field="desc" data-i="${i}">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Texto do botão (CTA)</label>
          <input value="${esc(p.cta || '')}" data-field="cta" data-i="${i}">
        </div>
        <div class="form-group">
          <label>
            <input type="checkbox" data-field="featured" data-i="${i}" ${p.featured ? 'checked' : ''}>
            Destaque
          </label>
        </div>
      </div>
    </div>`).join('');

  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (!content.planos.plans[i]) return;
      if (el.type === 'checkbox') content.planos.plans[i][field] = el.checked;
      else content.planos.plans[i][field] = el.value;
    });
  });
}
