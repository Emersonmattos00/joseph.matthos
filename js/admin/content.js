/* ============================================================
   admin/content.js — Conteúdo do site (GET/PUT)
   ------------------------------------------------------------
   Correções aplicadas (auditoria):
   - loadContent NÃO cai para DEFAULT_CONTENT em erros HTTP/5xx
   - loadContent valida schema antes de retornar
   - Tamanho medido em bytes reais (TextEncoder), não .length
   - baseVersion validado (Number.isSafeInteger >= 0)
   - normalizeContent usa mergeDefaults recursivo
   - Validação de IDs duplicados em playlists/planos
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

    if (!result || result.ok !== true) {
      const err = new Error(result?.error || 'Resposta inválida do servidor.');
      err.status = result?.status || 502;
      throw err;
    }

    const rawData = result.data;

    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      const err = new Error('O servidor retornou um conteúdo inválido.');
      err.status = 422;
      err.code = 'STORED_CONTENT_INVALID';
      throw err;
    }

    const validation = validateContentSchema(rawData);

    if (!validation.valid) {
      const err = new Error(
        'O conteúdo armazenado possui inconsistências: ' + validation.errors.join(' ')
      );
      err.code = 'STORED_CONTENT_INVALID';
      err.status = 422;
      throw err;
    }

    return {
      data: normalizeContent(rawData),
      version: Number.isInteger(Number(result.version)) ? Number(result.version) : 0,
      updatedAt: result.updatedAt || null
    };

  } catch (err) {
    // Nunca substituir silenciosamente dados por defaults em erros HTTP/autenticação
    if (err?.status || err?.code === 'STORED_CONTENT_INVALID') {
      throw err;
    }

    // Fallback somente quando a API está realmente indisponível
    console.warn('[content] Falha de comunicação com a API:', err?.message || err);
    throw new Error(
      'Não foi possível carregar o conteúdo do servidor. Verifique a conexão e tente novamente.'
    );
  }
}

// ─────────────────────────────────────────────────────────────
// PUT
// ─────────────────────────────────────────────────────────────
export async function saveContent(data, options = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('Conteúdo inválido.');
  }

  // Validação de schema
  const validation = validateContentSchema(data);
  if (!validation.valid) {
    const err = new Error(`Conteúdo inválido: ${validation.errors.join(' ')}`);
    err.status = 422;
    err.code = 'SCHEMA_INVALID';
    err.errors = validation.errors;
    throw err;
  }

  // Normalização
  const normalized = normalizeContent(validation.data);

  // Tamanho em bytes reais (UTF-8)
  const serialized = JSON.stringify(normalized);
  const payloadBytes = new TextEncoder().encode(serialized).byteLength;

  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    const err = new Error('Conteúdo muito grande. O limite é de 2 MB.');
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  // baseVersion validado
  let baseVersion;
  if (options.baseVersion !== undefined) {
    baseVersion = Number(options.baseVersion);

    if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
      const err = new Error('A versão base do conteúdo é inválida. Recarregue o painel.');
      err.status = 400;
      err.code = 'INVALID_BASE_VERSION';
      throw err;
    }
  }

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
// ─────────────────────────────────────────────────────────────
export function validateContentSchema(content) {
  const errors = [];

  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return { valid: false, errors: ['Conteúdo deve ser um objeto.'], data: null };
  }

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

  const validateUniqueIds = (items, path) => {
    if (!Array.isArray(items)) return;
    const ids = new Set();
    items.forEach((item, index) => {
      if (!item || typeof item.id !== 'string') return;
      const id = item.id.trim();
      if (!id) {
        errors.push(`${path}[${index}].id não pode ser vazio.`);
        return;
      }
      if (ids.has(id)) errors.push(`ID duplicado em ${path}: ${id}.`);
      ids.add(id);
    });
  };

  // branding
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

  // hero
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

  // sobre
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

  // filosofia
  if (checkType('filosofia', content.filosofia, 'object')) {
    const f = content.filosofia;
    if (f) {
      checkType('filosofia.title', f.title, 'string');
      checkType('filosofia.subtitle', f.subtitle, 'string');
      checkType('filosofia.frases', f.frases, 'array');
      if (Array.isArray(f.frases)) checkArrayOfObjects('filosofia.frases', f.frases, 'text');
    }
  }

  // discografia
  if (checkType('discografia', content.discografia, 'object')) {
    const d = content.discografia;
    if (d) {
      checkType('discografia.title', d.title, 'string');
      checkType('discografia.subtitle', d.subtitle, 'string');
    }
  }

  // playlists
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
      validateUniqueIds(content.playlists, 'playlists');
    }
  }

  // planos
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
        validateUniqueIds(p.plans, 'planos.plans');
      }
    }
  }

  // contato
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
          if (!s.network && !s.icon) errors.push(`"contato.socials[${idx}].network" é obrigatório.`);
          if (!s.url) errors.push(`"contato.socials[${idx}].url" é obrigatório.`);
        });
      }
    }
  }

  // aparencia
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

  return { valid: errors.length === 0, errors, data: content };
}

// ─────────────────────────────────────────────────────────────
// NORMALIZE — mergeDefaults recursivo
// ─────────────────────────────────────────────────────────────
function mergeDefaults(defaults, current) {
  if (Array.isArray(defaults)) {
    return Array.isArray(current) ? JSON.parse(JSON.stringify(current)) : JSON.parse(JSON.stringify(defaults));
  }

  if (
    defaults &&
    typeof defaults === 'object' &&
    current &&
    typeof current === 'object' &&
    !Array.isArray(current)
  ) {
    const result = JSON.parse(JSON.stringify(defaults));

    for (const key of Object.keys(current)) {
      if (Object.prototype.hasOwnProperty.call(defaults, key)) {
        result[key] = mergeDefaults(defaults[key], current[key]);
      } else {
        result[key] = JSON.parse(JSON.stringify(current[key]));
      }
    }

    return result;
  }

  return current === undefined || current === null
    ? JSON.parse(JSON.stringify(defaults))
    : current;
}

export function normalizeContent(content) {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return JSON.parse(JSON.stringify(DEFAULT_CONTENT));
  }
  return mergeDefaults(DEFAULT_CONTENT, content);
}