/* ============================================================
   admin/editors/plans.js — Editor de planos de assinatura
   ------------------------------------------------------------
   ⚠️ Aqui o admin edita APENAS textos/descrições/features.
   Preços reais vêm de /api/plans (envs do Mercado Pago).
   ============================================================ */

import { AdminState } from '../index.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  wrap.innerHTML = content.planos.plans.map((p, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>${esc(p.name)} ${p.badge ? `· ${esc(p.badge)}` : ''}</strong>
        <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
      </div>
      <div style="color:var(--text-dim);font-size:0.8rem;">${esc(p.desc || '')}</div>
    </div>`).join('');

  wrap.querySelectorAll('[data-action="edit"]').forEach((b) =>
    b.addEventListener('click', () => openPlanModal(Number(b.dataset.i))));
}

function openPlanModal(i) {
  const plan = JSON.parse(JSON.stringify(AdminState.content.planos.plans[i]));

  openAdminModal(`
    <h3>Editar plano</h3>

    <div class="form-row">
      <div class="form-group"><label>Nome</label>
        <input type="text" id="pmName" value="${esc(plan.name)}"></div>
      <div class="form-group"><label>ID</label>
        <input type="text" id="pmId" value="${esc(plan.id)}" disabled></div>
    </div>

    <div class="form-row-3">
      <div class="form-group"><label>Sufixo (ex: /mês)</label>
        <input type="text" id="pmSuffix" value="${esc(plan.suffix || '')}"></div>
      <div class="form-group"><label>Badge</label>
        <input type="text" id="pmBadge" value="${esc(plan.badge || '')}"></div>
      <div class="form-group"><label>CTA</label>
        <input type="text" id="pmCta" value="${esc(plan.cta || '')}"></div>
    </div>

    <div class="form-group"><label>Descrição</label>
      <input type="text" id="pmDesc" value="${esc(plan.desc || '')}"></div>

    <div class="form-group">
      <label><input type="checkbox" id="pmFeatured" ${plan.featured ? 'checked' : ''}> Destaque</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="pmDisabled" ${plan.disabled ? 'checked' : ''}> Botão desabilitado</label>
    </div>

    <h3 style="margin-top:1rem;">Recursos</h3>
    <div id="pmFeatures"></div>
    <button class="btn btn-outline btn-sm" id="pmAddFeature" style="margin-top:0.5rem;">
      + Adicionar recurso
    </button>

    <p class="hint" style="margin-top:1rem;">
      O preço exibido no site vem de <code>/api/plans</code> (envs do Mercado Pago).
      Aqui você edita apenas a apresentação.
    </p>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="pmCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="pmSave">Salvar</button>
    </div>
  `);

  const featuresWrap = document.getElementById('pmFeatures');

  const renderFeatures = () => {
    featuresWrap.innerHTML = plan.features.map((f, fi) => `
      <div class="track-editor">
        <div class="track-head">
          <strong>Recurso ${fi + 1}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove-feature" data-fi="${fi}">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Texto</label>
            <input type="text" value="${esc(f.text)}" data-feature-field="text" data-fi="${fi}"></div>
          <div class="form-group">
            <label><input type="checkbox" data-feature-field="ok" data-fi="${fi}" ${f.ok ? 'checked' : ''}> Incluído</label>
          </div>
        </div>
      </div>`).join('');

    featuresWrap.querySelectorAll('[data-feature-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const fi = Number(el.dataset.fi);
        const key = el.dataset.featureField;
        plan.features[fi][key] = el.type === 'checkbox' ? el.checked : el.value;
      });
    });

    featuresWrap.querySelectorAll('[data-action="remove-feature"]').forEach((b) =>
      b.addEventListener('click', () => {
        plan.features.splice(Number(b.dataset.fi), 1);
        renderFeatures();
      }));
  };

  renderFeatures();

  document.getElementById('pmAddFeature').addEventListener('click', () => {
    plan.features.push({ text: 'Novo recurso', ok: true });
    renderFeatures();
  });

  document.getElementById('pmCancel').addEventListener('click', () => closeAdminModal());

  document.getElementById('pmSave').addEventListener('click', () => {
    plan.name = document.getElementById('pmName').value.trim();
    plan.suffix = document.getElementById('pmSuffix').value;
    plan.badge = document.getElementById('pmBadge').value || undefined;
    plan.cta = document.getElementById('pmCta').value;
    plan.desc = document.getElementById('pmDesc').value;
    plan.featured = document.getElementById('pmFeatured').checked;
    plan.disabled = document.getElementById('pmDisabled').checked;

    AdminState.content.planos.plans[i] = plan;
    renderPlansEditor(AdminState.content);
    closeAdminModal();
    toast('Plano salvo. Lembre de clicar em "Salvar" no topo.', '💳');
  });
}