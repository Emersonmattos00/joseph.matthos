/* ============================================================
   js/admin/editors/plans.js — Editor de planos de assinatura
   ------------------------------------------------------------
   ⚠️ IMPORTANTE — Preços:
     • Este editor NÃO define preços.
     • Os preços vivem no servidor (envs do Mercado Pago):
         - MP_PREMIUM_MONTHLY_PRICE
         - MP_PREMIUM_ANNUAL_PRICE
     • O frontend lê de /api/plans e usa apenas para exibição.
     • O backend SEMPRE cobra o preço da env, nunca do que o
       frontend enviar.

   Este editor controla APENAS:
     • nome do plano
     • descrição curta
     • badge ("Recomendado", etc.)
     • CTA do botão
     • lista de features (texto + ok/sem ok)
     • flags "featured" e "disabled"
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// IDs válidos (fixos no backend)
// ─────────────────────────────────────────────────────────────
const VALID_PLAN_IDS = new Set(['free', 'premium', 'anual']);

// ─────────────────────────────────────────────────────────────
// Render — lista
// ─────────────────────────────────────────────────────────────
export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  // Guard: garante estrutura mínima
  if (!content.planos) content.planos = {};
  if (!Array.isArray(content.planos.plans)) content.planos.plans = [];

  const plans = content.planos.plans;

  if (!plans.length) {
    wrap.innerHTML = `
      <p class="hint" style="color:var(--text-dim);padding:1rem;">
        Nenhum plano configurado. Os planos padrão (free, premium, anual) são
        definidos no <code>config.js</code>.
      </p>`;
    return;
  }

  wrap.innerHTML = plans.map((p, i) => {
    const featured = p.featured ? ' · <span style="color:var(--accent);">★ destaque</span>' : '';
    const disabled = p.disabled ? ' · <span style="color:var(--text-dim);">desabilitado</span>' : '';
    const idValid = VALID_PLAN_IDS.has(p.id);

    return `
      <div class="track-editor">
        <div class="track-head">
          <strong>
            ${esc(p.name || 'Plano')}
            ${p.badge ? `<span class="hint" style="color:var(--accent);"> · ${esc(p.badge)}</span>` : ''}
          </strong>
          <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
        </div>
        <div style="color:var(--text-dim);font-size:0.8rem;">
          <code>${esc(p.id || '?')}</code>
          ${idValid ? '' : ' <span style="color:var(--danger);">⚠ id inválido</span>'}
          ${featured}${disabled}
        </div>
        ${p.desc ? `<div style="color:var(--text-dim);font-size:0.8rem;margin-top:0.3rem;">${esc(p.desc)}</div>` : ''}
      </div>`;
  }).join('');

  // Bind dos botões "Editar"
  wrap.querySelectorAll('[data-action="edit"]').forEach((b) => {
    b.addEventListener('click', () => openPlanModal(Number(b.dataset.i)));
  });

  // Aviso sobre preços (visível sempre)
  const existingWarn = wrap.querySelector('.plans-pricing-warn');
  if (!existingWarn) {
    const warn = document.createElement('p');
    warn.className = 'plans-pricing-warn hint';
    warn.style.cssText = 'color:var(--text-dim);font-size:0.75rem;margin-top:1rem;padding:0.7rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;line-height:1.5;';
    warn.innerHTML = `
      <strong style="color:var(--accent);">🔒 Preços não são editáveis aqui.</strong>
      O valor cobrado vem das variáveis de ambiente no servidor
      (<code>MP_PREMIUM_MONTHLY_PRICE</code> e <code>MP_PREMIUM_ANNUAL_PRICE</code>).
      Este editor controla apenas os <em>textos</em> dos planos.
    `;
    wrap.appendChild(warn);
  }
}

// ─────────────────────────────────────────────────────────────
// Modal de edição
// ─────────────────────────────────────────────────────────────
function openPlanModal(i) {
  const content = AdminState.content;
  const plan = content.planos.plans[i];
  if (!plan) return;

  const cloned = JSON.parse(JSON.stringify(plan));

  openAdminModal(`
    <h3>Editar plano <span style="color:var(--accent);">${esc(plan.name || '')}</span></h3>

    <div class="form-row">
      <div class="form-group">
        <label>ID (não editável)</label>
        <input type="text" value="${esc(cloned.id || '')}" disabled>
      </div>
      <div class="form-group">
        <label>Nome</label>
        <input type="text" id="pmName" value="${esc(cloned.name || '')}">
      </div>
    </div>

    <div class="form-row-3">
      <div class="form-group">
        <label>Sufixo (ex: /mês)</label>
        <input type="text" id="pmSuffix" value="${esc(cloned.suffix || '')}">
      </div>
      <div class="form-group">
        <label>Badge</label>
        <input type="text" id="pmBadge" value="${esc(cloned.badge || '')}">
      </div>
      <div class="form-group">
        <label>Texto do botão (CTA)</label>
        <input type="text" id="pmCta" value="${esc(cloned.cta || '')}">
      </div>
    </div>

    <div class="form-group">
      <label>Descrição</label>
      <input type="text" id="pmDesc" value="${esc(cloned.desc || '')}">
    </div>

    <div class="form-group">
      <label><input type="checkbox" id="pmFeatured" ${cloned.featured ? 'checked' : ''}> Destaque visual</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="pmDisabled" ${cloned.disabled ? 'checked' : ''}> Botão desabilitado</label>
    </div>

    <h3 style="margin-top:1rem;">Recursos</h3>
    <div id="pmFeatures"></div>
    <button class="btn btn-outline btn-sm" id="pmAddFeature" style="margin-top:0.5rem;">
      + Adicionar recurso
    </button>

    <p class="hint" style="margin-top:1rem;color:var(--text-dim);font-size:0.8rem;line-height:1.5;padding:0.7rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;">
      <strong style="color:var(--accent);">🔒 Preço:</strong>
      o valor cobrado vem do servidor (<code>MP_PREMIUM_MONTHLY_PRICE</code>
      / <code>MP_PREMIUM_ANNUAL_PRICE</code>), nunca deste editor.
    </p>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="pmCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="pmSave">Salvar</button>
    </div>
  `);

  // ── Features
  const featuresWrap = document.getElementById('pmFeatures');

  const renderFeatures = () => {
    featuresWrap.innerHTML = cloned.features.map((f, fi) => `
      <div class="track-editor">
        <div class="track-head">
          <strong>Recurso ${fi + 1}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove-feature" data-fi="${fi}">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Texto</label>
            <input type="text" value="${esc(f.text || '')}" data-feature-field="text" data-fi="${fi}">
          </div>
          <div class="form-group">
            <label><input type="checkbox" data-feature-field="ok" data-fi="${fi}" ${f.ok ? 'checked' : ''}> Incluído</label>
          </div>
        </div>
      </div>`).join('');

    featuresWrap.querySelectorAll('[data-feature-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const fi = Number(el.dataset.fi);
        const key = el.dataset.featureField;
        if (!cloned.features[fi]) cloned.features[fi] = {};
        cloned.features[fi][key] = el.type === 'checkbox' ? el.checked : el.value;
      });
    });

    featuresWrap.querySelectorAll('[data-action="remove-feature"]').forEach((b) => {
      b.addEventListener('click', () => {
        const fi = Number(b.dataset.fi);
        cloned.features.splice(fi, 1);
        renderFeatures();
      });
    });
  };

  renderFeatures();

  document.getElementById('pmAddFeature').addEventListener('click', () => {
    cloned.features.push({ text: 'Novo recurso', ok: true });
    renderFeatures();
  });

  document.getElementById('pmCancel').addEventListener('click', () => closeAdminModal());

  document.getElementById('pmSave').addEventListener('click', () => {
    // Só campos editáveis do plano (nunca `id`, nunca preço)
    cloned.name = document.getElementById('pmName').value.trim() || cloned.name;
    cloned.suffix = document.getElementById('pmSuffix').value;
    cloned.badge = document.getElementById('pmBadge').value.trim() || null;
    cloned.cta = document.getElementById('pmCta').value;
    cloned.desc = document.getElementById('pmDesc').value;
    cloned.featured = document.getElementById('pmFeatured').checked;
    cloned.disabled = document.getElementById('pmDisabled').checked;

    // ⚠️ Guard: `id` nunca muda
    if (plan.id) cloned.id = plan.id;

    // ⚠️ Guard: preço nunca é adicionado/alterado aqui
    delete cloned.price;
    delete cloned.priceCents;

    content.planos.plans[i] = cloned;

    markDirty();
    renderPlansEditor(content);
    closeAdminModal();
    toast('Plano atualizado. Clique em "Salvar alterações" no topo.', '💳');
  });
}
