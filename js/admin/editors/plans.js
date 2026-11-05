/* ============================================================
   js/admin/editors/plans.js — Editor de planos (textos)
   ------------------------------------------------------------
   ⚠️  Este editor NÃO controla preços nem ativação comercial.
       Preços vêm da tabela `plans` do banco (via /api/payments).
       Ativação comercial (`plans.active`) é controlada no banco.
       
       Este arquivo edita APENAS textos exibidos no site:
         - name, desc, badge, cta, features, featured

   Correções aplicadas (auditoria):
   - Validação de tamanho de textos
   - Limites em features (quantidade e tamanho)
   - Não descarta planos válidos do banco (só avisa)
   - sync aviso "disabled é apenas visual"
   - sanitizePlan no save
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

const MAX_NAME = 80;
const MAX_DESC = 240;
const MAX_CTA = 50;
const MAX_BADGE = 40;
const MAX_FEATURES = 20;
const MAX_FEATURE_TEXT = 120;

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
      { text: 'Faixas completas na assinatura', ok: false },
      { text: 'Downloads ilimitados', ok: false }
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
      { text: 'Downloads ilimitados', ok: true },
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
// Validação de payload (antes de gravar)
// ─────────────────────────────────────────────────────────────
function validatePlanPayload(payload) {
  const errors = [];

  if (!payload.name || payload.name.length > MAX_NAME) {
    errors.push(`Nome deve ter 1–${MAX_NAME} caracteres.`);
  }

  if (payload.cta.length > MAX_CTA) {
    errors.push(`Texto do botão deve ter até ${MAX_CTA} caracteres.`);
  }

  if (payload.desc.length > MAX_DESC) {
    errors.push(`Descrição deve ter até ${MAX_DESC} caracteres.`);
  }

  if (payload.badge && payload.badge.length > MAX_BADGE) {
    errors.push(`Badge deve ter até ${MAX_BADGE} caracteres.`);
  }

  if (!Array.isArray(payload.features) || payload.features.length > MAX_FEATURES) {
    errors.push(`O plano pode ter até ${MAX_FEATURES} recursos.`);
  }

  for (const f of payload.features || []) {
    if (!f.text || f.text.length > MAX_FEATURE_TEXT || typeof f.ok !== 'boolean') {
      errors.push(`Recurso inválido (máx ${MAX_FEATURE_TEXT} caracteres).`);
      break;
    }
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────
// Normalização: mantém 3 canônicos, mas não descarta textos válidos
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
    const merged = {};

    merged.id = def.id;

    merged.name = typeof existing.name === 'string' && existing.name.trim()
      ? existing.name.trim().slice(0, MAX_NAME)
      : def.name;

    merged.desc = typeof existing.desc === 'string'
      ? existing.desc.slice(0, MAX_DESC)
      : def.desc;

    merged.badge = typeof existing.badge === 'string' && existing.badge.trim()
      ? existing.badge.trim().slice(0, MAX_BADGE)
      : def.badge;

    merged.cta = typeof existing.cta === 'string' && existing.cta.trim()
      ? existing.cta.trim().slice(0, MAX_CTA)
      : def.cta;

    merged.suffix = PLAN_SUFFIXES[def.id] || '';

    merged.featured = typeof existing.featured === 'boolean'
      ? existing.featured
      : def.featured;

    merged.disabled = typeof existing.disabled === 'boolean'
      ? existing.disabled
      : def.disabled;

    const rawFeatures = Array.isArray(existing.features)
      ? existing.features
      : def.features;

    merged.features = rawFeatures
      .filter((f) => f && typeof f.text === 'string')
      .slice(0, MAX_FEATURES)
      .map((f) => ({
        text: String(f.text).slice(0, MAX_FEATURE_TEXT),
        ok: f.ok !== false
      }));

    if (!merged.features.length) {
      merged.features = JSON.parse(JSON.stringify(def.features));
    }

    return merged;
  });
}

// ─────────────────────────────────────────────────────────────
// Sanitize
// ─────────────────────────────────────────────────────────────
function sanitizePlan(plan) {
  const clean = {};

  for (const key of Object.keys(plan || {})) {
    if (ALLOWED_PLAN_FIELDS.has(key)) {
      clean[key] = plan[key];
    }
  }

  for (const key of FORBIDDEN_PLAN_FIELDS) {
    delete clean[key];
  }

  if (clean.id) clean.id = String(clean.id).toLowerCase().trim();

  if (clean.features && Array.isArray(clean.features)) {
    clean.features = clean.features
      .filter((f) => f && typeof f.text === 'string')
      .slice(0, MAX_FEATURES)
      .map((f) => ({
        text: String(f.text).slice(0, MAX_FEATURE_TEXT),
        ok: f.ok !== false
      }));
  }

  return clean;
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  if (!content.planos) content.planos = {};
  if (!Array.isArray(content.planos.plans)) content.planos.plans = [];

  content.planos.plans = ensureCanonicalPlans(content.planos.plans);
  const plans = content.planos.plans;

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
                  data-i="${i}">✏ Editar</button>
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
      Desabilitar um plano aqui <strong>não bloqueia</strong> o checkout —
      use o banco (ou uma futura tela de planos comerciais) para isso.
    </p>
  `;

  wrap.innerHTML = `${header}${listHTML}${warnHTML}`;

  wrap.querySelectorAll('[data-action="edit"]').forEach((b) => {
    b.addEventListener('click', () => openPlanModal(Number(b.dataset.i)));
  });
}

// ─────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────
function openPlanModal(i) {
  const content = AdminState.content;
  const plan = content.planos.plans[i];
  if (!plan) return;

  const cloned = JSON.parse(JSON.stringify(plan));
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
        <input type="text" id="pmName" maxlength="${MAX_NAME}" value="${esc(cloned.name || '')}">
      </div>
    </div>

    <div class="form-row-3">
      <div class="form-group">
        <label>Sufixo (fixo)</label>
        <input type="text" value="${esc(canonicalSuffix || '—')}" disabled>
      </div>
      <div class="form-group">
        <label>Badge</label>
        <input type="text" id="pmBadge" maxlength="${MAX_BADGE}" value="${esc(cloned.badge || '')}">
      </div>
      <div class="form-group">
        <label>Texto do botão (CTA)</label>
        <input type="text" id="pmCta" maxlength="${MAX_CTA}" value="${esc(cloned.cta || '')}">
      </div>
    </div>

    <div class="form-group">
      <label>Descrição</label>
      <input type="text" id="pmDesc" maxlength="${MAX_DESC}" value="${esc(cloned.desc || '')}">
    </div>

    <div class="form-group">
      <label><input type="checkbox" id="pmFeatured" ${cloned.featured ? 'checked' : ''}> Destaque visual</label>
    </div>
    <div class="form-group">
      <label><input type="checkbox" id="pmDisabled" ${cloned.disabled ? 'checked' : ''}> Botão desabilitado (apenas visual)</label>
    </div>

    <h3 style="margin-top:1rem;">Recursos</h3>
    <div id="pmFeatures"></div>
    <button class="btn btn-outline btn-sm" id="pmAddFeature" style="margin-top:0.5rem;">
      + Adicionar recurso
    </button>

    <p class="hint" style="margin-top:1rem;color:var(--text-dim);font-size:0.8rem;line-height:1.5;padding:0.7rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;">
      <strong style="color:var(--accent);">🔒 Preço:</strong>
      o valor cobrado vem do servidor (tabela <code>plans</code>).
    </p>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="pmCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="pmSave">Salvar</button>
    </div>
  `);

  const featuresWrap = document.getElementById('pmFeatures');

  const renderFeatures = () => {
    featuresWrap.innerHTML = cloned.features.map((f, fi) => `
      <div class="track-editor">
        <div class="track-head">
          <strong>Recurso ${fi + 1}</strong>
          <button class="btn btn-ghost btn-sm"
                  data-action="remove-feature"
                  data-fi="${fi}">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Texto</label>
            <input type="text"
                   value="${esc(f.text || '')}"
                   maxlength="${MAX_FEATURE_TEXT}"
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
      el.addEventListener('input', () => {
        const fi = Number(el.dataset.fi);
        const key = el.dataset.featureField;
        if (!cloned.features[fi]) cloned.features[fi] = {};
        cloned.features[fi][key] = el.type === 'checkbox' ? el.checked : el.value;
      });
    });

    featuresWrap.querySelectorAll('[data-action="remove-feature"]').forEach((b) => {
      b.addEventListener('click', () => {
        cloned.features.splice(Number(b.dataset.fi), 1);
        renderFeatures();
      });
    });
  };

  renderFeatures();

  document.getElementById('pmAddFeature').addEventListener('click', () => {
    if (cloned.features.length >= MAX_FEATURES) {
      toast(`Limite de ${MAX_FEATURES} recursos.`, '⚠');
      return;
    }
    cloned.features.push({ text: 'Novo recurso', ok: true });
    renderFeatures();
  });

  document.getElementById('pmCancel').addEventListener('click', () => closeAdminModal());

  document.getElementById('pmSave').addEventListener('click', () => {
    const payload = {
      id: plan.id,
      name: document.getElementById('pmName').value.trim(),
      suffix: canonicalSuffix,
      badge: document.getElementById('pmBadge').value.trim() || null,
      cta: document.getElementById('pmCta').value,
      desc: document.getElementById('pmDesc').value,
      featured: document.getElementById('pmFeatured').checked,
      disabled: document.getElementById('pmDisabled').checked,
      features: cloned.features
        .filter((f) => f && typeof f.text === 'string' && f.text.trim())
        .map((f) => ({ text: f.text.trim(), ok: f.ok !== false }))
    };

    const errors = validatePlanPayload(payload);
    if (errors.length) {
      toast(errors[0], '⚠');
      return;
    }

    const sanitized = sanitizePlan(payload);
    content.planos.plans[i] = sanitized;

    markDirty();
    renderPlansEditor(content);
    closeAdminModal();
    toast('Plano atualizado. Clique em "Salvar alterações" no topo.', '💳');
  });
}

export {
  ensureCanonicalPlans,
  sanitizePlan,
  VALID_PLAN_IDS,
  PLAN_SUFFIXES
};