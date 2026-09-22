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

   🛡️ BLINDAGENS:
     • IDs são canônicos e imutáveis (free / premium / anual)
     • Sufixos são fixos por plano (/mês, /ano)
     • Whitelist de campos no save (nada de price/stripePriceId)
     • Estrutura sempre garantida (3 planos, mesmo se vazios)
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Constantes canônicas
// ─────────────────────────────────────────────────────────────
const VALID_PLAN_IDS = new Set(['free', 'premium', 'anual']);

/**
 * Sufixos fixos por plano — não editáveis pelo admin.
 * Refletem o intervalo cobrado pelo backend (envs MP_PREMIUM_*).
 */
const PLAN_SUFFIXES = {
  free: '',
  premium: '/mês',
  anual: '/ano'
};

/**
 * Campos que o editor pode gravar. Tudo mais é descartado.
 */
const ALLOWED_PLAN_FIELDS = new Set([
  'id', 'name', 'desc', 'badge', 'cta', 'suffix',
  'features', 'featured', 'disabled'
]);

/**
 * Campos proibidos — nunca podem existir no plano.
 * Se aparecerem, são removidos antes de gravar.
 */
const FORBIDDEN_PLAN_FIELDS = new Set([
  'price', 'priceCents', 'stripePriceId',
  'mpPreferenceId', 'amount', 'currency'
]);

/**
 * Definições canônicas dos 3 planos.
 * Usadas como fallback quando o admin apaga ou corrompe.
 */
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
// Normalização: garante 3 planos canônicos, IDs imutáveis,
// sufixos fixos, sem campos proibidos
// ─────────────────────────────────────────────────────────────
function ensureCanonicalPlans(rawPlans) {
  const input = Array.isArray(rawPlans) ? rawPlans : [];

  // Indexa por ID (aceita apenas IDs canônicos)
  const byId = new Map();
  for (const p of input) {
    if (!p || typeof p !== 'object') continue;
    const id = String(p.id || '').toLowerCase().trim();
    if (!VALID_PLAN_IDS.has(id)) continue;
    byId.set(id, p);
  }

  // Monta os 3 canônicos, mesclando customizações existentes
  return CANONICAL_PLANS.map((def) => {
    const existing = byId.get(def.id) || {};
    const merged = {};

    // ID sempre canônico
    merged.id = def.id;

    // Textos editáveis (fallback para o default)
    merged.name = typeof existing.name === 'string' && existing.name.trim()
      ? existing.name.trim()
      : def.name;
    merged.desc = typeof existing.desc === 'string'
      ? existing.desc
      : def.desc;
    merged.badge = typeof existing.badge === 'string' && existing.badge.trim()
      ? existing.badge.trim()
      : def.badge;
    merged.cta = typeof existing.cta === 'string' && existing.cta.trim()
      ? existing.cta.trim()
      : def.cta;

    // Sufixo sempre fixo (ignora o que estiver no existing)
    merged.suffix = PLAN_SUFFIXES[def.id] || '';

    // Flags booleanas
    merged.featured = typeof existing.featured === 'boolean'
      ? existing.featured
      : def.featured;
    merged.disabled = typeof existing.disabled === 'boolean'
      ? existing.disabled
      : def.disabled;

    // Features — normaliza para {text: string, ok: boolean}
    const rawFeatures = Array.isArray(existing.features)
      ? existing.features
      : def.features;
    merged.features = rawFeatures
      .filter((f) => f && typeof f.text === 'string')
      .map((f) => ({
        text: String(f.text),
        ok: f.ok !== false
      }));

    // Se ficou vazio, usa os defaults
    if (!merged.features.length) {
      merged.features = JSON.parse(JSON.stringify(def.features));
    }

    return merged;
  });
}

// ─────────────────────────────────────────────────────────────
// Sanitização no save: whitelist + remoção de campos proibidos
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

  // Reforça tipos
  if (clean.id) clean.id = String(clean.id).toLowerCase().trim();
  if (clean.features && Array.isArray(clean.features)) {
    clean.features = clean.features
      .filter((f) => f && typeof f.text === 'string')
      .map((f) => ({ text: String(f.text), ok: f.ok !== false }));
  }

  return clean;
}

// ─────────────────────────────────────────────────────────────
// Render — lista
// ─────────────────────────────────────────────────────────────
export function renderPlansEditor(content = AdminState.content) {
  const wrap = document.getElementById('plansEditor');
  if (!wrap) return;

  // Guard: garante estrutura mínima
  if (!content.planos) content.planos = {};
  if (!Array.isArray(content.planos.plans)) content.planos.plans = [];

  // 🛡️ BLINDAGEM 1: força 3 planos canônicos
  content.planos.plans = ensureCanonicalPlans(content.planos.plans);
  const plans = content.planos.plans;

  // Cabeçalho
  const header = `
    <div class="plans-editor__header">
      <span class="plans-editor__count">
        ${plans.length} plano${plans.length === 1 ? '' : 's'}
      </span>
    </div>
  `;

  // Lista de planos
  const listHTML = plans.map((p, i) => {
    const featured = p.featured
      ? ' · <span style="color:var(--accent);">★ destaque</span>'
      : '';
    const disabled = p.disabled
      ? ' · <span style="color:var(--text-dim);">desabilitado</span>'
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

  // Aviso permanente sobre preços
  const warnHTML = `
    <p class="plans-pricing-warn hint" style="color:var(--text-dim);font-size:0.75rem;margin-top:1rem;padding:0.7rem;background:rgba(212,175,55,0.05);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;line-height:1.5;">
      <strong style="color:var(--accent);">🔒 Preços não são editáveis aqui.</strong>
      O valor cobrado vem das variáveis de ambiente no servidor
      (<code>MP_PREMIUM_MONTHLY_PRICE</code> e <code>MP_PREMIUM_ANNUAL_PRICE</code>).
      Este editor controla apenas os <em>textos</em> dos planos.
    </p>
  `;

  wrap.innerHTML = `${header}${listHTML}${warnHTML}`;

  // Bind dos botões "Editar"
  wrap.querySelectorAll('[data-action="edit"]').forEach((b) => {
    b.addEventListener('click', () => openPlanModal(Number(b.dataset.i)));
  });
}

// ─────────────────────────────────────────────────────────────
// Modal de edição
// ─────────────────────────────────────────────────────────────
function openPlanModal(i) {
  const content = AdminState.content;
  const plan = content.planos.plans[i];
  if (!plan) return;

  // Trabalha com uma cópia para não mutar o modelo até salvar
  const cloned = JSON.parse(JSON.stringify(plan));

  // Sufixo canônico (não editável)
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
        <input type="text" id="pmName" value="${esc(cloned.name || '')}">
      </div>
    </div>

    <div class="form-row-3">
      <div class="form-group">
        <label>Sufixo (fixo)</label>
        <input type="text" value="${esc(canonicalSuffix || '—')}" disabled>
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
          <button class="btn btn-ghost btn-sm"
                  data-action="remove-feature"
                  data-fi="${fi}">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Texto</label>
            <input type="text"
                   value="${esc(f.text || '')}"
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

  // 🛡️ BLINDAGEM 2: whitelist no save
  document.getElementById('pmSave').addEventListener('click', () => {
    // Monta o payload a partir do estado + inputs (fonte de verdade)
    const payload = {
      id: plan.id, // sempre o ID original
      name: document.getElementById('pmName').value.trim() || plan.name,
      suffix: canonicalSuffix, // sempre fixo, ignora input
      badge: document.getElementById('pmBadge').value.trim() || null,
      cta: document.getElementById('pmCta').value,
      desc: document.getElementById('pmDesc').value,
      featured: document.getElementById('pmFeatured').checked,
      disabled: document.getElementById('pmDisabled').checked,
      features: cloned.features
        .filter((f) => f && typeof f.text === 'string' && f.text.trim())
        .map((f) => ({ text: f.text, ok: f.ok !== false }))
    };

    // Aplica whitelist + remove campos proibidos
    const sanitized = sanitizePlan(payload);

    // Substitui no array
    content.planos.plans[i] = sanitized;

    markDirty();
    renderPlansEditor(content);
    closeAdminModal();
    toast('Plano atualizado. Clique em "Salvar alterações" no topo.', '💳');
  });
}

// ─────────────────────────────────────────────────────────────
// Exports utilitários (para reuso)
// ─────────────────────────────────────────────────────────────
export {
  ensureCanonicalPlans,
  sanitizePlan,
  VALID_PLAN_IDS,
  PLAN_SUFFIXES
};
