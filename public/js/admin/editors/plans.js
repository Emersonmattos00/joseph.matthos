/* ============================================================
   js/admin/editors/plans.js — Editor de Planos (v3.0)
   ------------------------------------------------------------
   - Separa apresentação visual dos dados comerciais
   - Normalização pura: renderizar não altera AdminState
   - Validação estrita dos campos e do UUID comercial
   - Impede UUID duplicado entre planos visuais
   - Preserva campos legados/desconhecidos já existentes
   - Permite remover badge e recursos intencionalmente
   - Limita texto, recursos e quantidade de planos
   - Não trata validação client-side como prova de existência
     do plano comercial: o backend deve validar no banco.
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

const VALID_PLAN_IDS = new Set(['free', 'premium', 'anual']);
const PLAN_SUFFIXES = Object.freeze({ free: '', premium: '/mês', anual: '/ano' });
const MAX_PLANS = 3;

const ALLOWED_PLAN_FIELDS = new Set([
  'id', 'name', 'desc', 'badge', 'cta', 'suffix',
  'features', 'featured', 'disabled', 'dbPlanId'
]);

const FORBIDDEN_PLAN_FIELDS = new Set([
  'price', 'priceCents', 'stripePriceId', 'mpPreferenceId',
  'amount', 'currency'
]);

const LIMITS = Object.freeze({
  name: 80,
  desc: 300,
  badge: 40,
  cta: 60,
  featureText: 160,
  maxFeatures: 20
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CANONICAL_PLANS = Object.freeze([
  {
    id: 'free', name: 'Visitante',
    desc: 'Para conhecer o som de Joseph Matthos.',
    featured: false, badge: null, suffix: '',
    features: [
      { text: 'Prévias de 30s de todas as faixas', ok: true },
      { text: 'Acesso à discografia completa', ok: true },
      { text: 'Aluguel de faixas individuais', ok: true },
      { text: 'Faixas completas na assinatura', ok: false }
    ],
    cta: 'Plano atual', disabled: true, dbPlanId: ''
  },
  {
    id: 'premium', name: 'Premium',
    desc: 'Experiência completa, sem limites.',
    featured: true, badge: 'Recomendado', suffix: '/mês',
    features: [
      { text: 'Toda a discografia desbloqueada', ok: true },
      { text: 'Áudio em alta qualidade', ok: true },
      { text: 'Aluguel de faixas incluído', ok: true },
      { text: 'Cancele quando quiser', ok: true }
    ],
    cta: 'Assinar Premium', disabled: false, dbPlanId: ''
  },
  {
    id: 'anual', name: 'Premium Anual',
    desc: 'Economize no plano anual.',
    featured: false, badge: null, suffix: '/ano',
    features: [
      { text: 'Tudo do Premium mensal', ok: true },
      { text: 'Desconto anual', ok: true },
      { text: 'Acesso antecipado a shows', ok: true },
      { text: 'Conteúdo exclusivo do bastidor', ok: true },
      { text: 'Badge de apoiador oficial', ok: true }
    ],
    cta: 'Assinar Anual', disabled: false, dbPlanId: ''
  }
]);

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

function isValidPlanUUID(value) {
  return typeof value === 'string' && UUID_REGEX.test(value.trim());
}

function normalizeText(value, fallback, max, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') return fallback;
  const clean = value.trim().slice(0, max);
  return allowEmpty ? clean : (clean || fallback);
}

function normalizeFeatures(rawFeatures, fallbackFeatures) {
  const source = Array.isArray(rawFeatures) ? rawFeatures : fallbackFeatures;
  return source
    .filter((feature) => isPlainObject(feature) && typeof feature.text === 'string')
    .slice(0, LIMITS.maxFeatures)
    .map((feature) => ({
      text: feature.text.trim().slice(0, LIMITS.featureText),
      ok: feature.ok !== false
    }))
    .filter((feature) => feature.text.length > 0);
}

/** Normaliza sem modificar rawPlans nem os objetos recebidos. */
function ensureCanonicalPlans(rawPlans) {
  const input = Array.isArray(rawPlans) ? rawPlans : [];
  const byId = new Map();

  for (const plan of input) {
    if (!isPlainObject(plan)) continue;
    const id = typeof plan.id === 'string' ? plan.id.toLowerCase().trim() : '';
    if (!VALID_PLAN_IDS.has(id) || byId.has(id)) continue;
    byId.set(id, plan);
  }

  return CANONICAL_PLANS.map((definition) => {
    const existing = byId.get(definition.id) || {};
    const badge = existing.badge === null
      ? null
      : typeof existing.badge === 'string'
        ? (existing.badge.trim().slice(0, LIMITS.badge) || null)
        : definition.badge;

    return {
      id: definition.id,
      name: normalizeText(existing.name, definition.name, LIMITS.name),
      desc: normalizeText(existing.desc, definition.desc, LIMITS.desc, { allowEmpty: true }),
      badge,
      cta: normalizeText(existing.cta, definition.cta, LIMITS.cta),
      suffix: PLAN_SUFFIXES[definition.id],
      featured: typeof existing.featured === 'boolean' ? existing.featured : definition.featured,
      disabled: typeof existing.disabled === 'boolean' ? existing.disabled : definition.disabled,
      dbPlanId: typeof existing.dbPlanId === 'string' ? existing.dbPlanId.trim() : '',
      features: normalizeFeatures(existing.features, definition.features)
    };
  });
}

/** Retorna um objeto validado; lança Error para entradas inválidas. */
function sanitizePlan(plan) {
  if (!isPlainObject(plan)) throw new Error('Dados do plano inválidos.');

  const id = typeof plan.id === 'string' ? plan.id.toLowerCase().trim() : '';
  if (!VALID_PLAN_IDS.has(id)) throw new Error('Identificador visual de plano inválido.');

  const name = normalizeText(plan.name, '', LIMITS.name);
  const desc = normalizeText(plan.desc, '', LIMITS.desc, { allowEmpty: true });
  const badge = plan.badge === null || plan.badge === ''
    ? null
    : normalizeText(plan.badge, '', LIMITS.badge, { allowEmpty: true }) || null;
  const cta = normalizeText(plan.cta, '', LIMITS.cta);

  if (!name) throw new Error('O nome do plano é obrigatório.');
  if (!cta) throw new Error('O texto do botão (CTA) é obrigatório.');
  if (typeof plan.featured !== 'boolean' || typeof plan.disabled !== 'boolean') {
    throw new Error('As opções visuais do plano são inválidas.');
  }

  const dbPlanId = typeof plan.dbPlanId === 'string' ? plan.dbPlanId.trim() : '';
  if (dbPlanId && !isValidPlanUUID(dbPlanId)) {
    throw new Error('O UUID comercial informado não possui formato válido.');
  }
  if (id !== 'free' && !dbPlanId) {
    throw new Error('Vincule o plano a um UUID comercial antes de salvar.');
  }

  if (!Array.isArray(plan.features) || plan.features.length > LIMITS.maxFeatures) {
    throw new Error(`O plano pode ter no máximo ${LIMITS.maxFeatures} recursos.`);
  }

  const features = plan.features.map((feature) => {
    if (!isPlainObject(feature) || typeof feature.text !== 'string' || typeof feature.ok !== 'boolean') {
      throw new Error('Existe um recurso com dados inválidos.');
    }
    const text = feature.text.trim().slice(0, LIMITS.featureText);
    if (!text) throw new Error('Os recursos não podem conter textos vazios. Remova a linha ou preencha-a.');
    return { text, ok: feature.ok };
  });

  return {
    id,
    dbPlanId,
    name,
    desc,
    badge,
    cta,
    suffix: PLAN_SUFFIXES[id],
    featured: plan.featured,
    disabled: plan.disabled,
    features
  };
}

function removeForbiddenFields(plan) {
  const result = { ...plan };
  for (const field of FORBIDDEN_PLAN_FIELDS) delete result[field];
  return result;
}

function hasDuplicateDbPlanId(plans, currentIndex, dbPlanId) {
  if (!dbPlanId) return false;
  const normalized = dbPlanId.toLowerCase();
  return plans.some((plan, index) =>
    index !== currentIndex &&
    typeof plan?.dbPlanId === 'string' &&
    plan.dbPlanId.trim().toLowerCase() === normalized
  );
}

function getPlansForRender(content) {
  const raw = content?.planos?.plans;
  return ensureCanonicalPlans(raw);
}

// ─────────────────────────────────────────────────────────────
// Renderização — sem mutação do conteúdo recebido
// ─────────────────────────────────────────────────────────────
export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  if (!isPlainObject(content)) {
    wrap.innerHTML = '<p class="admin-error-box">Conteúdo inválido.</p>';
    return;
  }

  const plans = getPlansForRender(content);
  const header = `
    <div class="plans-editor__header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
      <span>${plans.length} planos visuais</span>
    </div>`;

  const listHTML = plans.map((plan, index) => {
    const featured = plan.featured ? ' · <span style="color:var(--accent);">★ destaque</span>' : '';
    const disabled = plan.disabled ? ' · <span style="color:var(--text-dim);">desabilitado</span>' : '';
    const dbInfo = plan.dbPlanId
      ? `<span style="color:var(--success,#4ade80);font-size:0.75rem;">🔗 UUID informado: ${esc(plan.dbPlanId)}</span>`
      : `<span style="color:var(--warning,#f0a100);font-size:0.75rem;">⚠️ Sem vínculo comercial</span>`;

    return `
      <div class="track-editor" style="border:1px solid #333;padding:1rem;margin-bottom:0.8rem;border-radius:8px;">
        <div class="track-head" style="display:flex;justify-content:space-between;align-items:center;gap:.75rem;">
          <div>
            <strong>${esc(plan.name || 'Plano')}</strong>
            ${plan.badge ? `<span class="hint" style="color:var(--accent);margin-left:8px;">${esc(plan.badge)}</span>` : ''}
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-action="edit" data-i="${index}">✏ Editar</button>
        </div>
        <div style="color:var(--text-dim);font-size:0.8rem;margin-top:0.5rem;">
          <code>${esc(plan.id)}</code> · sufixo <code>${esc(plan.suffix)}</code>${featured}${disabled}
        </div>
        <div style="margin-top:0.5rem;">${dbInfo}</div>
      </div>`;
  }).join('');

  const warnHTML = `
    <div style="margin-top:1.5rem;padding:1rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;">
      <strong style="color:var(--accent);">⚠️ Preços não são editáveis aqui.</strong>
      <p style="margin:0.5rem 0 0;font-size:0.8rem;color:var(--text-dim);line-height:1.4;">
        Este editor controla somente a apresentação visual. O preço e a periodicidade devem ter uma única fonte comercial de verdade no backend/banco de dados.
        O UUID informado é apenas uma referência: o servidor precisa confirmar sua existência, estado e correspondência com o plano antes de permitir o checkout.
      </p>
    </div>`;

  wrap.innerHTML = `${header}${listHTML}${warnHTML}`;
  wrap.querySelectorAll('[data-action="edit"]').forEach((button) => {
    button.addEventListener('click', () => openPlanModal(content, Number(button.dataset.i)));
  });
}

// ─────────────────────────────────────────────────────────────
// Modal de edição
// ─────────────────────────────────────────────────────────────
function openPlanModal(content, index) {
  if (!isPlainObject(content)) return;
  const plans = getPlansForRender(content);
  const plan = plans[index];
  if (!plan) return;

  const cloned = cloneJSON(plan);
  const canonicalSuffix = PLAN_SUFFIXES[plan.id];

  openAdminModal(`
    <h3>Editar plano <span style="color:var(--accent);">${esc(plan.name)}</span></h3>
    <div class="form-row">
      <div class="form-group">
        <label for="pmVisualId">ID Visual (não editável)</label>
        <input type="text" id="pmVisualId" value="${esc(cloned.id)}" disabled>
      </div>
      <div class="form-group">
        <label for="pmDbPlanId">UUID do Plano no Banco (Comercial)</label>
        <input type="text" id="pmDbPlanId" value="${esc(cloned.dbPlanId || '')}" maxlength="36" placeholder="UUID do registro em plans" autocomplete="off" spellcheck="false">
        <small class="hint" style="color:var(--text-dim);font-size:0.7rem;margin-top:4px;display:block;">
          O formato será validado aqui. A existência e a periodicidade precisam ser confirmadas pelo servidor.
        </small>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="pmName">Nome</label>
        <input type="text" id="pmName" maxlength="${LIMITS.name}" value="${esc(cloned.name)}">
      </div>
      <div class="form-group">
        <label>Sufixo (fixo)</label>
        <input type="text" value="${esc(canonicalSuffix)}" disabled>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label for="pmBadge">Badge (ex.: Recomendado)</label>
        <input type="text" id="pmBadge" maxlength="${LIMITS.badge}" value="${esc(cloned.badge || '')}">
      </div>
      <div class="form-group">
        <label for="pmCta">Texto do botão (CTA)</label>
        <input type="text" id="pmCta" maxlength="${LIMITS.cta}" value="${esc(cloned.cta)}">
      </div>
    </div>
    <div class="form-group">
      <label for="pmDesc">Descrição</label>
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
    <h3 style="margin-top:1.5rem;font-size:1rem;">Recursos (máx. ${LIMITS.maxFeatures})</h3>
    <div id="pmFeatures" style="margin-top:0.5rem;"></div>
    <button type="button" class="btn btn-outline btn-sm" id="pmAddFeature" style="margin-top:0.5rem;">+ Adicionar recurso</button>
    <div style="display:flex;gap:0.7rem;margin-top:1.5rem;justify-content:flex-end;">
      <button type="button" class="btn btn-outline btn-sm" id="pmCancel">Cancelar</button>
      <button type="button" class="btn btn-primary btn-sm" id="pmSave">Salvar</button>
    </div>
  `);

  const featuresWrap = document.getElementById('pmFeatures');
  const addFeatureButton = document.getElementById('pmAddFeature');
  const saveButton = document.getElementById('pmSave');
  const cancelButton = document.getElementById('pmCancel');
  const requiredElements = [featuresWrap, addFeatureButton, saveButton, cancelButton];
  if (requiredElements.some((element) => !element)) {
    toast('Não foi possível inicializar o formulário de planos.', '⚠');
    closeAdminModal();
    return;
  }

  const renderFeatures = () => {
    featuresWrap.innerHTML = cloned.features.map((feature, featureIndex) => `
      <div class="track-editor" style="border:1px solid #333;padding:0.8rem;margin-bottom:0.5rem;border-radius:6px;">
        <div class="track-head" style="display:flex;justify-content:space-between;margin-bottom:0.5rem;">
          <strong style="font-size:0.85rem;">Recurso ${featureIndex + 1}</strong>
          <button type="button" class="btn btn-ghost btn-sm" data-action="remove-feature" data-fi="${featureIndex}" style="color:#ff4d4d;">🗑 Remover</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <input type="text" maxlength="${LIMITS.featureText}" value="${esc(feature.text)}" data-feature-field="text" data-fi="${featureIndex}" placeholder="Ex.: Downloads ilimitados" aria-label="Texto do recurso ${featureIndex + 1}">
          </div>
          <div class="form-group" style="display:flex;align-items:center;">
            <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
              <input type="checkbox" data-feature-field="ok" data-fi="${featureIndex}" ${feature.ok ? 'checked' : ''}> Incluído
            </label>
          </div>
        </div>
      </div>`).join('');

    featuresWrap.querySelectorAll('[data-feature-field]').forEach((element) => {
      const eventName = element.type === 'checkbox' ? 'change' : 'input';
      element.addEventListener(eventName, () => {
        const featureIndex = Number(element.dataset.fi);
        const field = element.dataset.featureField;
        if (!Number.isInteger(featureIndex) || !cloned.features[featureIndex]) return;
        cloned.features[featureIndex][field] = element.type === 'checkbox'
          ? element.checked
          : element.value;
      });
    });

    featuresWrap.querySelectorAll('[data-action="remove-feature"]').forEach((button) => {
      button.addEventListener('click', () => {
        const featureIndex = Number(button.dataset.fi);
        if (!Number.isInteger(featureIndex) || featureIndex < 0 || featureIndex >= cloned.features.length) return;
        cloned.features.splice(featureIndex, 1);
        renderFeatures();
      });
    });

    addFeatureButton.disabled = cloned.features.length >= LIMITS.maxFeatures;
  };

  renderFeatures();

  addFeatureButton.addEventListener('click', () => {
    if (cloned.features.length >= LIMITS.maxFeatures) return;
    cloned.features.push({ text: '', ok: true });
    renderFeatures();
    const newInput = featuresWrap.querySelector(`[data-feature-field="text"][data-fi="${cloned.features.length - 1}"]`);
    newInput?.focus();
  });

  cancelButton.addEventListener('click', () => closeAdminModal());

  saveButton.addEventListener('click', () => {
    if (saveButton.disabled) return;
    saveButton.disabled = true;

    try {
      const dbPlanId = document.getElementById('pmDbPlanId')?.value.trim() || '';
      if (hasDuplicateDbPlanId(plans, index, dbPlanId)) {
        throw new Error('Este UUID já está vinculado a outro plano visual.');
      }

      const payload = sanitizePlan({
        id: plan.id,
        dbPlanId,
        name: document.getElementById('pmName')?.value ?? plan.name,
        badge: document.getElementById('pmBadge')?.value ?? '',
        cta: document.getElementById('pmCta')?.value ?? '',
        desc: document.getElementById('pmDesc')?.value ?? '',
        featured: Boolean(document.getElementById('pmFeatured')?.checked),
        disabled: Boolean(document.getElementById('pmDisabled')?.checked),
        features: cloned.features
      });

      const currentRawPlans = Array.isArray(content.planos?.plans)
        ? content.planos.plans
        : [];
      const originalPlan = currentRawPlans.find((item) => item?.id === plan.id) || {};
      const mergedPlan = removeForbiddenFields({ ...originalPlan, ...payload });
      const nextPlans = plans.map((item, planIndex) => {
        if (planIndex === index) return mergedPlan;
        const rawExisting = currentRawPlans.find((candidate) => candidate?.id === item.id) || {};
        return removeForbiddenFields({ ...rawExisting, ...item });
      });

      // Confere novamente no conjunto final, sem depender somente do estado do modal.
      const linkedIds = nextPlans.map((item) => item.dbPlanId).filter(Boolean).map((id) => id.toLowerCase());
      if (new Set(linkedIds).size !== linkedIds.length) {
        throw new Error('Há UUIDs comerciais duplicados entre os planos.');
      }

      if (!isPlainObject(content.planos)) content.planos = {};
      content.planos.plans = nextPlans;
      markDirty();
      renderPlansEditor(content);
      closeAdminModal();
      toast('Plano atualizado. Salve no painel para persistir as alterações.', '💳');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Não foi possível validar o plano.', '⚠');
      saveButton.disabled = false;
    }
  });
}

export {
  ensureCanonicalPlans,
  sanitizePlan,
  isValidPlanUUID,
  hasDuplicateDbPlanId,
  VALID_PLAN_IDS,
  PLAN_SUFFIXES,
  LIMITS
};
