/* ============================================================
   admin/content.js — Conteúdo do site (GET/PUT)
   ------------------------------------------------------------
   - GET: tenta API, propaga 401/403, cai para DEFAULT_CONTENT
     só em falha de rede/5xx
   - PUT: envia baseVersion (controle de conflito otimista),
     preserva status/code do erro, marca "clean" ao salvar
   - ✅ NOVO: validateContentSchema() antes do PUT — garante
     integridade mínima das seções conhecidas sem bloquear
     extensões futuras
   ============================================================ */

import { apiFetch } from './api.js';
import { DEFAULT_CONTENT } from '../config.js';
import { markClean } from './state.js';

const MAX_PAYLOAD_BYTES = 2_000_000;

// ─────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────
export async function loadContent() {
  try {
    const result = await apiFetch('content', { method: 'GET' });

    if (result && result.ok) {
      const rawData =
        result.data && typeof result.data === 'object'
          ? result.data
          : {};

      // Normaliza/valida antes de devolver ao caller
      const data = normalizeContent(rawData);

      return {
        data,
        version: Number(result.version) || 0,
        updatedAt: result.updatedAt || null
      };
    }

    throw new Error(result?.error || 'Resposta inválida do servidor.');
  } catch (err) {
    if (err && (err.status === 401 || err.status === 403)) {
      throw err;
    }

    console.warn(
      '[content] API indisponível, usando DEFAULT_CONTENT:',
      err?.message || err
    );
    return {
      data: JSON.parse(JSON.stringify(DEFAULT_CONTENT)),
      version: 0,
      updatedAt: null
    };
  }
}

// ─────────────────────────────────────────────────────────────
// PUT
// ─────────────────────────────────────────────────────────────
export async function saveContent(data, options = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('Conteúdo inválido.');
  }

  // ── Validação de schema (best-effort) ──────────────────────
  const validation = validateContentSchema(data);
  if (!validation.valid) {
    const err = new Error(
      `Conteúdo inválido: ${validation.errors.join(' ')}`
    );
    err.status = 422;
    err.code = 'SCHEMA_INVALID';
    err.errors = validation.errors;
    throw err;
  }

  // Aplica normalização (defaults + coerção segura)
  const normalized = normalizeContent(validation.data);

  // Check local de tamanho
  const serialized = JSON.stringify(normalized);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    const err = new Error('Conteúdo muito grande. Reduza imagens ou remova itens.');
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  // Versão base para controle de concorrência otimista
  const baseVersion = Number.isFinite(options.baseVersion)
    ? Number(options.baseVersion)
    : undefined;

  let result;
  try {
    result = await apiFetch('content', {
      method: 'PUT',
      body: { data: normalized, baseVersion }
    });
  } catch (err) {
    if (err && err.status === 409) {
      const conflict = new Error(
        'O conteúdo foi alterado por outro administrador. Recarregue e tente novamente.'
      );
      conflict.status = 409;
      conflict.code = 'VERSION_CONFLICT';
      conflict.data = err.data;
      throw conflict;
    }
    throw err;
  }

  if (!result || !result.ok) {
    const e = new Error(result?.error || 'Falha ao salvar.');
    e.status = result?.status || 0;
    e.code = result?.code || null;
    throw e;
  }

  markClean();

  return {
    version: Number(result.version) || 0,
    updatedAt: result.updatedAt || null
  };
}

// ─────────────────────────────────────────────────────────────
// SCHEMA — Validação mínima
// ------------------------------------------------------------
// Regras:
//  - Se a seção existe, deve ser do tipo esperado (object/array)
//  - Se não existe, é tolerada (será preenchida com default)
//  - Campos internos desconhecidos NÃO são removidos (extensível)
//  - Campos internos críticos são validados por tipo
// ─────────────────────────────────────────────────────────────
export function validateContentSchema(content) {
  const errors = [];

  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return { valid: false, errors: ['Conteúdo deve ser um objeto.'], data: null };
  }

  // Helper: valida se um campo (se presente) é do tipo esperado
  const checkType = (path, value, expectedType, { required = false } = {}) => {
    if (value === undefined || value === null) {
      if (required) errors.push(`"${path}" é obrigatório.`);
      return true;
    }
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== expectedType) {
      errors.push(`"${path}" deve ser ${expectedType}, recebeu ${actualType}.`);
      return false;
    }
    return true;
  };

  // Helper: valida array de objetos com pelo menos 1 campo obrigatório
  const checkArrayOfObjects = (path, arr, requiredField) => {
    if (!Array.isArray(arr)) return;
    arr.forEach((item, idx) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`"${path}[${idx}]" deve ser um objeto.`);
        return;
      }
      if (requiredField && !item[requiredField]) {
        errors.push(`"${path}[${idx}].${requiredField}" é obrigatório.`);
      }
    });
  };

  // ── branding ──────────────────────────────────────────────
  if (checkType('branding', content.branding, 'object')) {
    const b = content.branding;
    if (b) {
      checkType('branding.name', b.name, 'string');
      checkType('branding.footer', b.footer, 'string');
      checkType('branding.bgImage', b.bgImage, 'string');
      checkType('branding.nameParts', b.nameParts, 'object');
      checkType('branding.meta', b.meta, 'object');
    }
  }

  // ── hero ──────────────────────────────────────────────────
  if (checkType('hero', content.hero, 'object')) {
    const h = content.hero;
    if (h) {
      checkType('hero.title', h.title, 'string');
      checkType('hero.subtitle', h.subtitle, 'string');
      checkType('hero.primaryBtn', h.primaryBtn, 'object');
      checkType('hero.secondaryBtn', h.secondaryBtn, 'object');
      checkType('hero.vinyl', h.vinyl, 'object');
    }
  }

  // ── sobre ─────────────────────────────────────────────────
  if (checkType('sobre', content.sobre, 'object')) {
    const s = content.sobre;
    if (s) {
      checkType('sobre.title', s.title, 'string');
      checkType('sobre.subtitle', s.subtitle, 'string');
      checkType('sobre.paragraphs', s.paragraphs, 'string');
      checkType('sobre.quote', s.quote, 'string');
      checkType('sobre.image', s.image, 'string');
    }
  }

  // ── filosofia ─────────────────────────────────────────────
  if (checkType('filosofia', content.filosofia, 'object')) {
    const f = content.filosofia;
    if (f) {
      checkType('filosofia.title', f.title, 'string');
      checkType('filosofia.subtitle', f.subtitle, 'string');
      checkType('filosofia.frases', f.frases, 'array');
      if (Array.isArray(f.frases)) {
        checkArrayOfObjects('filosofia.frases', f.frases, 'text');
      }
    }
  }

  // ── discografia ───────────────────────────────────────────
  if (checkType('discografia', content.discografia, 'object')) {
    const d = content.discografia;
    if (d) {
      checkType('discografia.title', d.title, 'string');
      checkType('discografia.subtitle', d.subtitle, 'string');
    }
  }

  // ── playlists ─────────────────────────────────────────────
  if (checkType('playlists', content.playlists, 'array')) {
    if (Array.isArray(content.playlists)) {
      content.playlists.forEach((p, idx) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          errors.push(`"playlists[${idx}]" deve ser um objeto.`);
          return;
        }
        if (!p.id) errors.push(`"playlists[${idx}].id" é obrigatório.`);
        if (!p.title) errors.push(`"playlists[${idx}].title" é obrigatório.`);
        checkType(`playlists[${idx}].tracks`, p.tracks, 'array');
      });
    }
  }

  // ── planos ────────────────────────────────────────────────
  if (checkType('planos', content.planos, 'object')) {
    const p = content.planos;
    if (p) {
      checkType('planos.title', p.title, 'string');
      checkType('planos.subtitle', p.subtitle, 'string');
      checkType('planos.plans', p.plans, 'array');
      if (Array.isArray(p.plans)) {
        p.plans.forEach((plan, idx) => {
          if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
            errors.push(`"planos.plans[${idx}]" deve ser um objeto.`);
            return;
          }
          if (!plan.id) errors.push(`"planos.plans[${idx}].id" é obrigatório.`);
          if (!plan.name) errors.push(`"planos.plans[${idx}].name" é obrigatório.`);
          checkType(`planos.plans[${idx}].features`, plan.features, 'array');
        });
      }
    }
  }

  // ── contato ───────────────────────────────────────────────
  if (checkType('contato', content.contato, 'object')) {
    const c = content.contato;
    if (c) {
      checkType('contato.title', c.title, 'string');
      checkType('contato.subtitle', c.subtitle, 'string');
      checkType('contato.heading', c.heading, 'string');
      checkType('contato.description', c.description, 'string');
      checkType('contato.socials', c.socials, 'array');
      if (Array.isArray(c.socials)) {
        c.socials.forEach((s, idx) => {
          if (!s || typeof s !== 'object' || Array.isArray(s)) {
            errors.push(`"contato.socials[${idx}]" deve ser um objeto.`);
            return;
          }
          if (!s.network && !s.icon) {
            errors.push(`"contato.socials[${idx}].network" é obrigatório.`);
          }
          if (!s.url) errors.push(`"contato.socials[${idx}].url" é obrigatório.`);
        });
      }
    }
  }

  // ── aparencia ─────────────────────────────────────────────
  if (checkType('aparencia', content.aparencia, 'object')) {
    const a = content.aparencia;
    if (a) {
      checkType('aparencia.bg', a.bg, 'string');
      checkType('aparencia.accent', a.accent, 'string');
      checkType('aparencia.text', a.text, 'string');
      checkType('aparencia.accentDark', a.accentDark, 'string');
      checkType('aparencia.border', a.border, 'string');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    data: content
  };
}

// ─────────────────────────────────────────────────────────────
// NORMALIZE — Preenche defaults sem quebrar extensões
// ------------------------------------------------------------
// Regras:
//  - Se uma seção não existe → usa default do DEFAULT_CONTENT
//  - Se existe mas faltam campos → preenche com default
//  - Se existe e é tipo errado → mantém o default (substitui)
//  - Campos extras NÃO são removidos
// ─────────────────────────────────────────────────────────────
export function normalizeContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONTENT));
  }

  const out = JSON.parse(JSON.stringify(content));
  const def = DEFAULT_CONTENT;

  // Helper: se campo não existe ou é tipo errado, usa default
  const ensureType = (obj, key, expectedType) => {
    const val = obj[key];
    const actualType = Array.isArray(val) ? 'array' : typeof val;
    if (val === undefined || val === null || actualType !== expectedType) {
      // Só substitui se for tipo errado E o default existir
      if (def[key] !== undefined) {
        obj[key] = JSON.parse(JSON.stringify(def[key]));
      }
    }
  };

  // branding
  if (typeof out.branding !== 'object' || out.branding === null || Array.isArray(out.branding)) {
    out.branding = JSON.parse(JSON.stringify(def.branding || {}));
  } else {
    ensureType(out.branding, 'nameParts', 'object');
    ensureType(out.branding, 'meta', 'object');
  }

  // hero
  if (typeof out.hero !== 'object' || out.hero === null || Array.isArray(out.hero)) {
    out.hero = JSON.parse(JSON.stringify(def.hero || {}));
  } else {
    ensureType(out.hero, 'primaryBtn', 'object');
    ensureType(out.hero, 'secondaryBtn', 'object');
    ensureType(out.hero, 'vinyl', 'object');
  }

  // sobre
  if (typeof out.sobre !== 'object' || out.sobre === null || Array.isArray(out.sobre)) {
    out.sobre = JSON.parse(JSON.stringify(def.sobre || {}));
  }

  // filosofia
  if (typeof out.filosofia !== 'object' || out.filosofia === null || Array.isArray(out.filosofia)) {
    out.filosofia = JSON.parse(JSON.stringify(def.filosofia || {}));
  } else {
    ensureType(out.filosofia, 'frases', 'array');
  }

  // discografia
  if (typeof out.discografia !== 'object' || out.discografia === null || Array.isArray(out.discografia)) {
    out.discografia = JSON.parse(JSON.stringify(def.discografia || {}));
  }

  // playlists
  if (!Array.isArray(out.playlists)) {
    out.playlists = JSON.parse(JSON.stringify(def.playlists || []));
  }

  // planos
  if (typeof out.planos !== 'object' || out.planos === null || Array.isArray(out.planos)) {
    out.planos = JSON.parse(JSON.stringify(def.planos || {}));
  } else {
    ensureType(out.planos, 'plans', 'array');
  }

  // contato
  if (typeof out.contato !== 'object' || out.contato === null || Array.isArray(out.contato)) {
    out.contato = JSON.parse(JSON.stringify(def.contato || {}));
  } else {
    ensureType(out.contato, 'socials', 'array');
  }

  // aparencia
  if (typeof out.aparencia !== 'object' || out.aparencia === null || Array.isArray(out.aparencia)) {
    out.aparencia = JSON.parse(JSON.stringify(def.aparencia || {}));
  }

  return out;
}
