/* ============================================================
   js/admin/editors/plans.js — Editor de planos (textos)
   ------------------------------------------------------------
   ⚠️  Este editor NÃO controla preços nem ativação comercial.

       Fonte de verdade dos preços: tabela `plans` do banco
       (consultada por /api/payments ao criar a preferência).
       Variáveis de ambiente MP_PREMIUM_* NÃO são a fonte
       de preço neste projeto — o backend lê `plans.priceCents`.

       Ativação comercial (`plans.active`) também vive no banco.
       Desabilitar aqui só esconde o botão no frontend —
       NÃO bloqueia contratação direta via API.

       Este arquivo edita APENAS textos exibidos no site:
         - name, desc, badge, cta, features, featured, disabled

   Correções aplicadas (auditoria):
   - render não chama ensureCanonicalPlans (não muta dados ao abrir)
   - openPlanModal usa o mesmo `content` passado ao render
   - validação unificada com limites explícitos
   - sanitizePlan reforça tipos (id, booleanos, features)
   - limites no HTML (maxlength) e no JS
   - markDirty só após validação bem-sucedida
   - botão Salvar bloqueado enquanto processa
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

const VALID_PLAN_IDS = new Set(['free', 'premium', 'anual']);

const PLAN_SUFFIXES = {
  free: '',
  premium: '/mês',
  anual: '/ano'
};

const PLAN_LIMITS = {
  name: 80,
  desc: 240,
  badge: 40,
  cta: 50,
  featureText: 140,
  features: 20
};

const ALLOWED_PLAN_FIELDS = new Set([
  'id', 'name', 'desc', 'badge', 'cta', 'suffix',
  'features', 'featured', 'disabled'
]);

const FORBIDDEN_PLAN_FIELDS = new Set([
  'price', 'priceCents', 'stripePriceId',
  'mpPreferenceId', 'amount', 'currency'
]);

const CANONICAL_PLANS = [
  {
    id: 'free',
    name: 'Visitante',
    desc: 'Para conhecer o som de Joseph Matthos.',
    featured: false,
    badge: null,
    suffix: '',
    features: [
      { text: 'Prévias de 30s de todas as faixas', ok: true },
      { text: 'Acesso à discografia completa', ok: true },
      { text: 'Aluguel de faixas individuais', ok: true },
      { text: 'Faixas completas na assinatura', ok: false }
    ],
    cta: 'Plano atual',
    disabled: true
  },
  {
    id: 'premium',
    name: 'Premium',
    desc: 'Experiência completa, sem limites.',
    featured: true,
    badge: 'Recomendado',
    suffix: '/mês',
    features: [
      { text: 'Toda a discografia desbloqueada', ok: true },
      { text: 'Áudio em alta qualidade', ok: true },
      { text: 'Aluguel de faixas incluído', ok: true },
      { text: 'Cancele quando quiser', ok: true }
    ],
    cta: 'Assinar Premium',
    disabled: false
  },
  {
    id: 'anual',
    name: 'Premium Anual',
    desc: 'Economize no plano anual.',
    featured: false,
    badge: null,
    suffix: '/ano',
    features: [
      { text: 'Tudo do Premium mensal', ok: true },
      { text: 'Desconto anual', ok: true },
      { text: 'Acesso antecipado a shows', ok: true },
      { text: 'Conteúdo exclusivo do bastidor', ok: true },
      { text: 'Badge de apoiador oficial', ok: true }
    ],
    cta: 'Assinar Anual',
    disabled: false
  }
];

// ─────────────────────────────────────────────────────────────
// Validação (usada antes de gravar)
// ─────────────────────────────────────────────────────────────
function validatePlanPayload(plan) {
  const errors = [];

  if (!VALID_PLAN_IDS.has(String(plan?.id || ''))) {
    errors.push('Identificador de plano inválido.');
  }

  if (!plan.name || !plan.name.trim()) {
    errors.push('O nome do plano é obrigatório.');
  } else if (plan.name.length > PLAN_LIMITS.name) {
    errors.push(`Nome deve ter até ${PLAN_LIMITS.name} caracteres.`);
  }

  if (!plan.cta || !plan.cta.trim()) {
    errors.push('O texto do botão é obrigatório.');
  } else if (plan.cta.length > PLAN_LIMITS.cta) {
    errors.push(`Texto do botão deve ter até ${PLAN_LIMITS.cta} caracteres.`);
  }

  if (plan.desc && plan.desc.length > PLAN_LIMITS.desc) {
    errors.push(`Descrição deve ter até ${PLAN_LIMITS.desc} caracteres.`);
  }

  if (plan.badge && plan.badge.length > PLAN_LIMITS.badge) {
    errors.push(`Badge deve ter até ${PLAN_LIMITS.badge} caracteres.`);
  }

  if (!Array.isArray(plan.features)) {
    errors.push('A lista de recursos é inválida.');
  } else if (plan.features.length > PLAN_LIMITS.features) {
    errors.push(`O plano pode ter até ${PLAN_LIMITS.features} recursos.`);
  } else {
    plan.features.forEach((f, i) => {
      if (!f || typeof f.text !== 'string' || !f.text.trim()) {
        errors.push(`O recurso ${i + 1} está vazio.`);
      } else if (f.text.length > PLAN_LIMITS.featureText) {
        errors.push(`O recurso ${i + 1} ultrapassa ${PLAN_LIMITS.featureText} caracteres.`);
      }
      if (typeof f.ok !== 'boolean') {
        errors.push(`O recurso ${i + 1} tem estado inválido.`);
      }
    });
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────
// Sanitize (aplicado no save, depois da validação)
// ─────────────────────────────────────────────────────────────
function sanitizePlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('Plano inválido.');
  }

  const id = String(plan.id || '').toLowerCase().trim();
  if (!VALID_PLAN_IDS.has(id)) {
    throw new Error('Identificador de plano não permitido.');
  }

  const clean = {};

  for (const key of Object.keys(plan)) {
    if (ALLOWED_PLAN_FIELDS.has(key)) {
      clean[key] = plan[key];
    }
  }

  for (const key of FORBIDDEN_PLAN_FIELDS) {
    delete clean[key];
  }

  const features = Array.isArray(plan.features)
    ? plan.features
        .filter((f) => f && typeof f.text === 'string')
        .slice(0, PLAN_LIMITS.features)
        .map((f) => ({
          text: String(f.text).trim().slice(0, PLAN_LIMITS.featureText),
          ok: f.ok === true
        }))
    : [];

  return {
    id,
    name: String(plan.name || '').trim().slice(0, PLAN_LIMITS.name),
    desc: String(plan.desc || '').trim().slice(0, PLAN_LIMITS.desc),
    badge:
      typeof plan.badge === 'string' && plan.badge.trim()
        ? plan.badge.trim().slice(0, PLAN_LIMITS.badge)
        : null,
    cta: String(plan.cta || '').trim().slice(0, PLAN_LIMITS.cta),
    suffix: PLAN_SUFFIXES[id] || '',
    featured: plan.featured === true,
    disabled: plan.disabled === true,
    features
  };
}

// ─────────────────────────────────────────────────────────────
// Mescla dados existentes com o canônico (SEM mutar o content)
// ------------------------------------------------------------
// Retorna um NOVO array. Use apenas em fluxo explícito de
// normalização/gravação, nunca no render.
// ─────────────────────────────────────────────────────────────
function ensureCanonicalPlans(rawPlans) {
  const input = Array.isArray(rawPlans) ? rawPlans : [];

  const byId = new Map();
  for (const p of input) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '').toLowerCase().trim();
    if (!VALID_PLAN_IDS.has(id)) continue;
    byId.set(id, p);
  }

  return CANONICAL_PLANS.map((def) => {
    const existing = byId.get(def.id) || {};

    const merged = { id: def.id };

    merged.name =
      typeof existing.name === 'string' && existing.name.trim()
        ? existing.name.trim().slice(0, PLAN_LIMITS.name)
        : def.name;

    merged.desc =
      typeof existing.desc === 'string'
        ? existing.desc.slice(0, PLAN_LIMITS.desc)
        : def.desc;

    merged.badge =
      typeof existing.badge === 'string' && existing.badge.trim()
        ? existing.badge.trim().slice(0, PLAN_LIMITS.badge)
        : def.badge;

    merged.cta =
      typeof existing.cta === 'string' && existing.cta.trim()
        ? existing.cta.trim().slice(0, PLAN_LIMITS.cta)
        : def.cta;

    merged.suffix = PLAN_SUFFIXES[def.id] || '';

    merged.featured =
      typeof existing.featured === 'boolean' ? existing.featured : def.featured;
    merged.disabled =
      typeof existing.disabled === 'boolean' ? existing.disabled : def.disabled;

    const rawFeatures = Array.isArray(existing.features)
      ? existing.features
      : def.features;

    merged.features = rawFeatures
      .filter((f) => f && typeof f.text === 'string')
      .slice(0, PLAN_LIMITS.features)
      .map((f) => ({
        text: String(f.text).slice(0, PLAN_LIMITS.featureText),
        ok: f.ok !== false
      }));

    if (!merged.features.length) {
      merged.features = def.features.map((f) => ({ ...f }));
    }

    return merged;
  });
}

// ─────────────────────────────────────────────────────────────
// Render
// ------------------------------------------------------------
// Não normaliza nem cria planos. Só exibe o que existe.
// ─────────────────────────────────────────────────────────────
export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  if (!content || typeof content !== 'object') {
    wrap.innerHTML = '<p class="admin-empty">Conteúdo administrativo indisponível.</p>';
    return;
  }

  const planos = content.planos;

  if (!planos || typeof planos !== 'object' || Array.isArray(planos)) {
    wrap.innerHTML = '<p class="admin-empty">Estrutura de planos inválida.</p>';
    return;
  }

  if (!Array.isArray(planos.plans)) {
    wrap.innerHTML = '<p class="admin-empty">Lista de planos inválida.</p>';
    return;
  }

  const plans = planos.plans;

  const header = `
    <div class="plans-editor__header">
      <span class="plans-editor__count">
        ${plans.length} plano${plans.length === 1 ? '' : 's'}
      </span>
    </div>
  `;

  const listHTML = plans.map((p, i) => {
    const featured = p.featured
      ? ' · <span style="color:var(--accent);">★ destaque</span>'
      : '';
    const disabled = p.disabled
      ? ' · <span style="color:var(--text-dim);">desabilitado (apenas visual)</span>'
      : '';

    return `
      <div class="track-editor">
        <div class="track-head">
          <strong>
            ${esc(p.name || 'Plano')}
            ${p.badge ? `<span class="hint" style="color:var(--accent);"> · ${esc(p.badge)}</span>` : ''}
          </strong>
          <button class="btn btn-ghost btn-sm"
                  data-action="edit"
                  data-i="${i}"
                  type="button">✏ Editar</button>
        </div>
        <div style="color:var(--text-dim);font-size:0.8rem;">
          <code>${esc(p.id || '?')}</code>
          · sufixo <code>${esc(p.suffix || '—')}</code>
          ${featured}${disabled}
        </div>
        ${p.desc ? `<div style="color:var(--text-dim);font-size:0.8rem;margin-top:0.3rem;">${esc(p.desc)}</div>` : ''}
      </div>`;
  }).join('');

  const warnHTML = `
    <p class="plans-pricing-warn hint" style="color:var(--text-dim);font-size:0.75rem;margin-top:1rem;padding:0.7rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;line-height:1.5;">
      <strong style="color:var(--accent);">🔒 Este editor controla apenas textos.</strong>
      Preço e ativação comercial vêm da tabela <code>plans</code> do banco.
      Desabilitar um plano aqui <strong>não bloqueia</strong> o checkout.
    </p>
  `;

  wrap.innerHTML = `${header}${listHTML}${warnHTML}`;

  wrap.querySelectorAll('[data-action="edit"]').forEach((b) => {
    b.addEventListener('click', () => {
      const index = Number(b.dataset.i);

      if (!Number.isInteger(index) || index < 0 || index >= plans.length) {
        toast('Plano inválido.', '⚠');
        return;
      }

      openPlanModal(index, content);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────
function openPlanModal(i, content = AdminState.content) {
  if (!content?.planos || !Array.isArray(content.planos.plans)) {
    toast('Não foi possível carregar os planos.', '⚠');
    return;
  }

  const plan = content.planos.plans[i];

  if (!plan) {
    toast('Plano não encontrado.', '⚠');
    return;
  }

  const cloned = JSON.parse(JSON.stringify(plan));
  if (!Array.isArray(cloned.features)) cloned.features = [];

  const canonicalSuffix = PLAN_SUFFIXES[plan.id] || '';

  openAdminModal(`
    <h3>Editar plano <span style="color:var(--accent);">${esc(plan.name || '')}</span></h3>

    <div class="form-row">
      <div class="form-group">
        <label>ID (não editável)</label>
        <input type="text" value="${esc(cloned.id || '')}" disabled>
      </div>
      <div class="form-group">
        <label>Nome</label>
        <input type="text" id="pmName"
               maxlength="${PLAN_LIMITS.name}"
               value="${esc(cloned.name || '')}">
      </div>
    </div>

    <div class="form-row-3">
      <div class="form-group">
        <label>Sufixo (fixo)</label>
        <input type="text" value="${esc(canonicalSuffix || '—')}" disabled>
      </div>
      <div class="form-group">
        <label>Badge</label>
        <input type="text" id="pmBadge"
               maxlength="${PLAN_LIMITS.badge}"
               value="${esc(cloned.badge || '')}">
      </div>
      <div class="form-group">
        <label>Texto do botão (CTA)</label>
        <input type="text" id="pmCta"
               maxlength="${PLAN_LIMITS.cta}"
               value="${esc(cloned.cta || '')}">
      </div>
    </div>

    <div class="form-group">
      <label>Descrição</label>
      <input type="text" id="pmDesc"
             maxlength="${PLAN_LIMITS.desc}"
             value="${esc(cloned.desc || '')}">
    </div>

    <div class="form-group">
      <label><input type="checkbox" id="pmFeatured" ${cloned.featured ? 'checked' : ''}> Destaque visual</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="pmDisabled" ${cloned.disabled ? 'checked' : ''}> Botão desabilitado (apenas visual)</label>
    </div>

    <h3 style="margin-top:1rem;">Recursos</h3>
    <div id="pmFeatures"></div>
    <button class="btn btn-outline btn-sm" id="pmAddFeature" style="margin-top:0.5rem;" type="button">
      + Adicionar recurso
    </button>

    <p class="hint" style="margin-top:1rem;color:var(--text-dim);font-size:0.8rem;line-height:1.5;padding:0.7rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;">
      <strong style="color:var(--accent);">🔒 Preço:</strong>
      o valor cobrado vem do servidor (tabela <code>plans</code>).
    </p>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="pmCancel" type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="pmSave" type="button">Salvar</button>
    </div>
  `);

  const featuresWrap = document.getElementById('pmFeatures');
  if (!featuresWrap) return;

  const renderFeatures = () => {
    featuresWrap.innerHTML = cloned.features.map((f, fi) => `
      <div class="track-editor">
        <div class="track-head">
          <strong>Recurso ${fi + 1}</strong>
          <button class="btn btn-ghost btn-sm"
                  data-action="remove-feature"
                  data-fi="${fi}"
                  type="button">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Texto</label>
            <input type="text"
                   value="${esc(f.text || '')}"
                   maxlength="${PLAN_LIMITS.featureText}"
                   data-feature-field="text"
                   data-fi="${fi}">
          </div>
          <div class="form-group">
            <label><input type="checkbox"
                          data-feature-field="ok"
                          data-fi="${fi}"
                          ${f.ok ? 'checked' : ''}> Incluído</label>
          </div>
        </div>
      </div>`).join('');

    featuresWrap.querySelectorAll('[data-feature-field]').forEach((el) => {
      const eventName = el.type === 'checkbox' ? 'change' : 'input';

      el.addEventListener(eventName, () => {
        const fi = Number(el.dataset.fi);
        const key = el.dataset.featureField;

        if (!Number.isInteger(fi) || !cloned.features[fi]) return;

        cloned.features[fi][key] =
          el.type === 'checkbox' ? el.checked : el.value;
      });
    });

    featuresWrap.querySelectorAll('[data-action="remove-feature"]').forEach((b) => {
      b.addEventListener('click', () => {
        const fi = Number(b.dataset.fi);
        if (!Number.isInteger(fi) || fi < 0 || fi >= cloned.features.length) return;
        cloned.features.splice(fi, 1);
        renderFeatures();
      });
    });
  };

  renderFeatures();

  document.getElementById('pmAddFeature')?.addEventListener('click', () => {
    if (cloned.features.length >= PLAN_LIMITS.features) {
      toast(`Limite de ${PLAN_LIMITS.features} recursos.`, '⚠');
      return;
    }

    cloned.features.push({ text: '', ok: true });
    renderFeatures();

    const inputs = featuresWrap.querySelectorAll('[data-feature-field="text"]');
    inputs[inputs.length - 1]?.focus();
  });

  document.getElementById('pmCancel')?.addEventListener('click', () => closeAdminModal());

  document.getElementById('pmSave')?.addEventListener('click', () => {
    const saveButton = document.getElementById('pmSave');
    if (!saveButton || saveButton.disabled) return;

    saveButton.disabled = true;

    try {
      const payload = {
        id: plan.id,
        name: document.getElementById('pmName').value.trim(),
        suffix: canonicalSuffix,
        badge: document.getElementById('pmBadge').value.trim() || null,
        cta: document.getElementById('pmCta').value.trim(),
        desc: document.getElementById('pmDesc').value.trim(),
        featured: document.getElementById('pmFeatured').checked,
        disabled: document.getElementById('pmDisabled').checked,
        features: cloned.features
          .filter((f) => f && typeof f.text === 'string' && f.text.trim())
          .map((f) => ({ text: f.text.trim(), ok: f.ok !== false }))
      };

      const errors = validatePlanPayload(payload);
      if (errors.length) {
        toast(errors[0], '⚠');
        saveButton.disabled = false;
        return;
      }

      const sanitized = sanitizePlan(payload);

      if (
        !Array.isArray(content.planos.plans) ||
        !content.planos.plans[i] ||
        content.planos.plans[i].id !== plan.id
      ) {
        throw new Error('O plano foi alterado ou não está mais disponível.');
      }

      content.planos.plans[i] = sanitized;

      markDirty();
      renderPlansEditor(content);
      closeAdminModal();
      toast('Plano atualizado. Clique em "Salvar alterações" no topo.', '💳');
    } catch (error) {
      console.error('[plans] erro ao salvar:', error);
      toast(error?.message || 'Não foi possível salvar o plano.', '⚠');
      saveButton.disabled = false;
    }
  });
}

export {
  ensureCanonicalPlans,
  sanitizePlan,
  VALID_PLAN_IDS,
  PLAN_SUFFIXES,
  PLAN_LIMITS
};