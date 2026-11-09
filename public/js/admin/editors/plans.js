/* ============================================================
   js/admin/editors/plans.js — Editor de Planos (v2 Corrigida)
   ------------------------------------------------------------
   - Separação entre plano VISUAL (site_content) e COMERCIAL (banco)
   - Vinculação do ID visual ao UUID do plano no banco
   - Proteção contra perda de dados na renderização
   - Validação de limites de texto e quantidade de recursos
   - Aviso correto sobre a origem dos preços (banco/env)
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Constantes canônicas
// ─────────────────────────────────────────────────────────────
const VALID_PLAN_IDS = new Set(['free', 'premium', 'anual']);

const PLAN_SUFFIXES = {
  free: '',
  premium: '/mês',
  anual: '/ano'
};

const ALLOWED_PLAN_FIELDS = new Set([
  'id', 'name', 'desc', 'badge', 'cta', 'suffix',
  'features', 'featured', 'disabled', 'dbPlanId' // ← Novo campo para linkar ao banco
]);

const FORBIDDEN_PLAN_FIELDS = new Set([
  'price', 'priceCents', 'stripePriceId',
  'mpPreferenceId', 'amount', 'currency'
]);

// Limites de texto
const LIMITS = {
  name: 80,
  desc: 300,
  badge: 40,
  cta: 60,
  featureText: 160,
  maxFeatures: 20
};

// Definições canônicas dos 3 planos
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
    disabled: true,
    dbPlanId: '' // Preenchido pelo admin
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
    disabled: false,
    dbPlanId: ''
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
    disabled: false,
    dbPlanId: ''
  }
];

// ─────────────────────────────────────────────────────────────
// Normalização Segura (Não Destrutiva)
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
    merged.name = typeof existing.name === 'string' && existing.name.trim() ? existing.name.trim().slice(0, LIMITS.name) : def.name;
    merged.desc = typeof existing.desc === 'string' ? existing.desc.slice(0, LIMITS.desc) : def.desc;
    merged.badge = typeof existing.badge === 'string' && existing.badge.trim() ? existing.badge.trim().slice(0, LIMITS.badge) : def.badge;
    merged.cta = typeof existing.cta === 'string' && existing.cta.trim() ? existing.cta.trim().slice(0, LIMITS.cta) : def.cta;
    merged.suffix = PLAN_SUFFIXES[def.id] || '';
    merged.featured = typeof existing.featured === 'boolean' ? existing.featured : def.featured;
    merged.disabled = typeof existing.disabled === 'boolean' ? existing.disabled : def.disabled;
    merged.dbPlanId = typeof existing.dbPlanId === 'string' ? existing.dbPlanId.trim() : '';

    const rawFeatures = Array.isArray(existing.features) ? existing.features : def.features;
    merged.features = rawFeatures
      .filter((f) => f && typeof f.text === 'string')
      .map((f) => ({ text: String(f.text).slice(0, LIMITS.featureText), ok: f.ok !== false }))
      .slice(0, LIMITS.maxFeatures);

    if (!merged.features.length) {
      merged.features = JSON.parse(JSON.stringify(def.features));
    }

    return merged;
  });
}

// ─────────────────────────────────────────────────────────────
// Sanitização
// ─────────────────────────────────────────────────────────────
function sanitizePlan(plan) {
  const clean = {};
  for (const key of Object.keys(plan || {})) {
    if (ALLOWED_PLAN_FIELDS.has(key)) clean[key] = plan[key];
  }
  for (const key of FORBIDDEN_PLAN_FIELDS) delete clean[key];

  if (clean.id) clean.id = String(clean.id).toLowerCase().trim();
  if (clean.features && Array.isArray(clean.features)) {
    clean.features = clean.features
      .filter((f) => f && typeof f.text === 'string')
      .map((f) => ({ text: String(f.text).slice(0, LIMITS.featureText), ok: f.ok !== false }))
      .slice(0, LIMITS.maxFeatures);
  }

  return clean;
}

// ─────────────────────────────────────────────────────────────
// Render — lista
// ─────────────────────────────────────────────────────────────
export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  if (!content || typeof content !== 'object') {
    wrap.innerHTML = '<p class="admin-error-box">Conteúdo inválido.</p>';
    return;
  }

  if (!content.planos) content.planos = {};
  if (!Array.isArray(content.planos.plans)) content.planos.plans = [];

  // A normalização NÃO apaga dados existentes, apenas mescla
  content.planos.plans = ensureCanonicalPlans(content.planos.plans);
  const plans = content.planos.plans;

  const header = `
    <div class="plans-editor__header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <span>${plans.length} planos visuais</span>
    </div>
  `;

  const listHTML = plans.map((p, i) => {
    const featured = p.featured ? ' · <span style="color:var(--accent);">★ destaque</span>' : '';
    const disabled = p.disabled ? ' · <span style="color:var(--text-dim);">desabilitado</span>' : '';
    const dbInfo = p.dbPlanId 
      ? `<span style="color:var(--success,#4ade80);font-size:0.75rem;">🔗 Vinculado ao banco (ID: ${esc(p.dbPlanId)})</span>`
      : `<span style="color:var(--warning,#f0a100);font-size:0.75rem;">⚠️ Não vinculado ao banco comercial</span>`;

    return `
      <div class="track-editor" style="border:1px solid #333;padding:1rem;margin-bottom:0.8rem;border-radius:8px;">
        <div class="track-head" style="display:flex;justify-content:space-between;align-items:center;">
          <div>
            <strong>${esc(p.name || 'Plano')}</strong>
            ${p.badge ? `<span class="hint" style="color:var(--accent);margin-left:8px;">${esc(p.badge)}</span>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" data-action="edit" data-i="${i}">✏ Editar</button>
        </div>
        <div style="color:var(--text-dim);font-size:0.8rem;margin-top:0.5rem;">
          <code>${esc(p.id)}</code> · sufixo <code>${esc(p.suffix)}</code> ${featured}${disabled}
        </div>
        <div style="margin-top:0.5rem;">${dbInfo}</div>
      </div>`;
  }).join('');

  const warnHTML = `
    <div style="margin-top:1.5rem;padding:1rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;">
      <strong style="color:var(--accent);">⚠️ Preços não são editáveis aqui.</strong>
      <p style="margin:0.5rem 0 0 0;font-size:0.8rem;color:var(--text-dim);line-height:1.4;">
        Os valores cobrados vêm da tabela <code>plans</code> no banco de dados (ou das variáveis de ambiente no servidor). 
        Este editor controla apenas a <strong>apresentação visual</strong> (textos, badges e recursos).
        Certifique-se de vincular o ID do banco (UUID) para que o checkout do Mercado Pago funcione corretamente.
      </p>
    </div>
  `;

  wrap.innerHTML = `${header}${listHTML}${warnHTML}`;

  wrap.querySelectorAll('[data-action="edit"]').forEach((b) => {
    b.addEventListener('click', () => openPlanModal(content, Number(b.dataset.i)));
  });
}

// ─────────────────────────────────────────────────────────────
// Modal de edição
// ─────────────────────────────────────────────────────────────
function openPlanModal(content, i) {
  const plan = content.planos.plans[i];
  if (!plan) return;

  const cloned = JSON.parse(JSON.stringify(plan));
  const canonicalSuffix = PLAN_SUFFIXES[plan.id] || '';

  openAdminModal(`
    <h3>Editar plano <span style="color:var(--accent);">${esc(plan.name)}</span></h3>

    <div class="form-row">
      <div class="form-group">
        <label>ID Visual (não editável)</label>
        <input type="text" value="${esc(cloned.id)}" disabled>
      </div>
      <div class="form-group">
        <label>UUID do Plano no Banco (Comercial)</label>
        <input type="text" id="pmDbPlanId" value="${esc(cloned.dbPlanId || '')}" placeholder="Ex: 550e8400-e29b-41d4-a716-446655440000">
        <small class="hint" style="color:var(--text-dim);font-size:0.7rem;margin-top:4px;display:block;">
          Obrigatório para o botão de assinatura funcionar.
        </small>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label>Nome</label>
        <input type="text" id="pmName" maxlength="${LIMITS.name}" value="${esc(cloned.name)}">
      </div>
      <div class="form-group">
        <label>Sufixo (fixo)</label>
        <input type="text" value="${esc(canonicalSuffix)}" disabled>
      </div>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label>Badge (ex: Recomendado)</label>
        <input type="text" id="pmBadge" maxlength="${LIMITS.badge}" value="${esc(cloned.badge || '')}">
      </div>
      <div class="form-group">
        <label>Texto do botão (CTA)</label>
        <input type="text" id="pmCta" maxlength="${LIMITS.cta}" value="${esc(cloned.cta)}">
      </div>
    </div>

    <div class="form-group">
      <label>Descrição</label>
      <input type="text" id="pmDesc" maxlength="${LIMITS.desc}" value="${esc(cloned.desc)}">
    </div>

    <div class="form-row">
      <div class="form-group">
        <label><input type="checkbox" id="pmFeatured" ${cloned.featured ? 'checked' : ''}> Destaque visual</label>
      </div>
      <div class="form-group">
        <label><input type="checkbox" id="pmDisabled" ${cloned.disabled ? 'checked' : ''}> Botão desabilitado</label>
      </div>
    </div>

    <h3 style="margin-top:1.5rem;font-size:1rem;">Recursos (máx ${LIMITS.maxFeatures})</h3>
    <div id="pmFeatures" style="margin-top:0.5rem;"></div>
    <button class="btn btn-outline btn-sm" id="pmAddFeature" style="margin-top:0.5rem;" ${cloned.features.length >= LIMITS.maxFeatures ? 'disabled' : ''}>
      + Adicionar recurso
    </button>

    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button class="btn btn-outline btn-sm" id="pmCancel">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="pmSave">Salvar</button>
    </div>
  `);

  const featuresWrap = document.getElementById('pmFeatures');
  const addFeatureBtn = document.getElementById('pmAddFeature');

  const renderFeatures = () => {
    featuresWrap.innerHTML = cloned.features.map((f, fi) => `
      <div class="track-editor" style="border:1px solid #333;padding:0.8rem;margin-bottom:0.5rem;border-radius:6px;">
        <div class="track-head" style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
          <strong style="font-size:0.85rem;">Recurso ${fi + 1}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove-feature" data-fi="${fi}" style="color:#ff4d4d;">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <input type="text" maxlength="${LIMITS.featureText}" value="${esc(f.text || '')}" data-feature-field="text" data-fi="${fi}" placeholder="Ex: Downloads ilimitados">
          </div>
          <div class="form-group" style="display:flex;align-items:center;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
              <input type="checkbox" data-feature-field="ok" data-fi="${fi}" ${f.ok ? 'checked' : ''}> Incluído
            </label>
          </div>
        </div>
      </div>`).join('');

    featuresWrap.querySelectorAll('[data-feature-field]').forEach((el) => {
      el.addEventListener('input', () => {
        const fi = Number(el.dataset.fi);
        const key = el.dataset.featureField;
        if (!cloned.features[fi]) return;
        cloned.features[fi][key] = el.type === 'checkbox' ? el.checked : el.value;
      });
    });

    featuresWrap.querySelectorAll('[data-action="remove-feature"]').forEach((b) => {
      b.addEventListener('click', () => {
        const fi = Number(b.dataset.fi);
        if (!Number.isInteger(fi) || fi < 0 || fi >= cloned.features.length) return;
        cloned.features.splice(fi, 1);
        renderFeatures();
        if (cloned.features.length < LIMITS.maxFeatures) addFeatureBtn.disabled = false;
      });
    });
  };

  renderFeatures();

  addFeatureBtn.addEventListener('click', () => {
    if (cloned.features.length >= LIMITS.maxFeatures) return;
    cloned.features.push({ text: '', ok: true });
    renderFeatures();
    if (cloned.features.length >= LIMITS.maxFeatures) addFeatureBtn.disabled = true;
  });

  document.getElementById('pmCancel').addEventListener('click', () => closeAdminModal());

  document.getElementById('pmSave').addEventListener('click', () => {
    const payload = {
      id: plan.id,
      dbPlanId: document.getElementById('pmDbPlanId').value.trim(),
      name: document.getElementById('pmName').value.trim() || plan.name,
      suffix: canonicalSuffix,
      badge: document.getElementById('pmBadge').value.trim() || null,
      cta: document.getElementById('pmCta').value.trim(),
      desc: document.getElementById('pmDesc').value.trim(),
      featured: document.getElementById('pmFeatured').checked,
      disabled: document.getElementById('pmDisabled').checked,
      features: cloned.features
        .filter((f) => f && typeof f.text === 'string' && f.text.trim())
        .map((f) => ({ text: f.text.trim(), ok: f.ok !== false }))
        .slice(0, LIMITS.maxFeatures)
    };

    if (!payload.cta) {
      toast('O texto do botão (CTA) não pode ficar vazio.', '⚠');
      return;
    }

    const sanitized = sanitizePlan(payload);
    content.planos.plans[i] = sanitized;

    markDirty();
    renderPlansEditor(content);
    closeAdminModal();
    toast('Plano atualizado. Salve no topo para confirmar.', '💳');
  });
}

export {
  ensureCanonicalPlans,
  sanitizePlan,
  VALID_PLAN_IDS,
  PLAN_SUFFIXES
};