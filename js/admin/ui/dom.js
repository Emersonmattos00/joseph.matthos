/* ============================================================
   js/admin/ui/dom.js
   ------------------------------------------------------------
   Helpers DOM utilizados pelo painel administrativo.

   - getByPath / setByPath : acesso e mutação segura de objetos
   - esc                   : escape de HTML (conteúdo em elementos)
   - escAttr               : escape de atributos HTML (mais rigoroso)
   - sanitizeHtml          : permite apenas tags seguras
   - stripHtml             : remove todas as tags
   - reexports             : safeExternalUrl (compat com socials.js)

   🎯 REGRA DO PROJETO
   ------------------------------------------------------------
   • Conteúdo controlado pelo sistema → sanitizar (sanitizeHtml)
   • Texto do usuário                 → escapar (esc / escAttr)
   • HTML permitido (hero, sobre)     → sanitizeHtml()
   • NUNCA usar innerHTML com string de usuário sem escapar
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// REEXPORTS de utils.js
// ------------------------------------------------------------
// Mantém o contrato de imports existentes:
//   import { safeExternalUrl } from '../ui/dom.js';
// A implementação vive em ../../utils.js.
// ─────────────────────────────────────────────────────────────
export { safeExternalUrl } from '../../utils.js';

// ============================================================
// VALIDAÇÃO DE CAMINHOS
// ------------------------------------------------------------
// Bloqueia chaves que poderiam causar prototype pollution.
// ============================================================

const FORBIDDEN_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor'
]);

function parseSafePath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    return null;
  }

  const keys = path.split('.');

  if (
    keys.length === 0 ||
    keys.some(
      key =>
        !key ||
        key.trim() !== key ||
        FORBIDDEN_KEYS.has(key)
    )
  ) {
    return null;
  }

  return keys;
}

// ============================================================
// LEITURA DE PROPRIEDADES
// ------------------------------------------------------------
// Usa Object.hasOwn para não acessar propriedades herdadas.
// ============================================================

export function getByPath(obj, path) {
  const keys = parseSafePath(path);

  if (
    !obj ||
    typeof obj !== 'object' ||
    !keys
  ) {
    return undefined;
  }

  let current = obj;

  for (const key of keys) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, key)
    ) {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

// ============================================================
// GRAVAÇÃO DE PROPRIEDADES
// ------------------------------------------------------------
// Retorna true em caso de sucesso, false caso contrário.
// Nunca cria/atravessa arrays nem chaves proibidas.
// ============================================================

export function setByPath(obj, path, value) {
  const keys = parseSafePath(path);

  if (
    !obj ||
    typeof obj !== 'object' ||
    Array.isArray(obj) ||
    !keys
  ) {
    return false;
  }

  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];

    if (!Object.hasOwn(current, key)) {
      current[key] = {};
    }

    const next = current[key];

    if (
      !next ||
      typeof next !== 'object' ||
      Array.isArray(next)
    ) {
      return false;
    }

    current = next;
  }

  const last = keys[keys.length - 1];

  current[last] = value;

  return true;
}

// ============================================================
// ESCAPE — TEXTO EM ELEMENTOS HTML
// ------------------------------------------------------------
//   <div>${esc(userText)}</div>
//
// Escapa: & < > " ' ` =
// ─────────────────────────────────────────────────────────────

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '=': '&#61;'
};

export function esc(value) {
  return String(value ?? '')
    .replace(/[&<>"'`=]/g, char => HTML_ESCAPE_MAP[char]);
}

// ============================================================
// ESCAPE — VALORES DE ATRIBUTOS HTML
// ------------------------------------------------------------
//   <input value="${escAttr(userText)}">
//   <a href="${escAttr(url)}">
//
// Escapa < > " ' ` e também newlines/tabs.
// ⚠️ Sempre usar quotes duplas nos atributos.
// ─────────────────────────────────────────────────────────────

const ATTR_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
  '\n': '&#10;',
  '\r': '&#13;',
  '\t': '&#9;'
};

export function escAttr(value) {
  return String(value ?? '')
    .replace(
      /[&<>"'`\n\r\t]/g,
      char => ATTR_ESCAPE_MAP[char]
    );
}

// ============================================================
// SANITIZAÇÃO HTML
// ------------------------------------------------------------
// Tags permitidas: b, i, em, strong, br, span, p, a
// Atributos: apenas span.gold e a[href|target|rel]
// Tags bloqueadas: removidas integralmente (sem preservar texto).
// Demais tags não permitidas: removidas, filhos preservados.
// ─────────────────────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'B',
  'I',
  'EM',
  'STRONG',
  'BR',
  'SPAN',
  'P',
  'A'
]);

const BLOCKED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'MATH',
  'FORM',
  'INPUT',
  'BUTTON',
  'TEXTAREA',
  'SELECT',
  'TEMPLATE',
  'NOSCRIPT'
]);

const ALLOWED_SPAN_CLASSES = new Set([
  'gold'
]);

export function sanitizeHtml(input) {
  const raw = String(input ?? '');

  if (!raw) return '';

  if (typeof DOMParser === 'undefined') {
    return esc(raw);
  }

  const doc = new DOMParser().parseFromString(
    raw,
    'text/html'
  );

  const root = doc.body;

  if (!root) return '';

  function cleanNode(parent) {
    for (const child of Array.from(parent.childNodes)) {
      // Texto → mantém
      if (child.nodeType === 3) {
        continue;
      }

      // Comentários e outros nós → remove
      if (child.nodeType !== 1) {
        child.remove();
        continue;
      }

      const tag = child.tagName.toUpperCase();

      // Remove completamente elementos perigosos.
      if (BLOCKED_TAGS.has(tag)) {
        child.remove();
        continue;
      }

      // Tags não autorizadas são removidas,
      // mas seus filhos são preservados e sanitizados.
      if (!ALLOWED_TAGS.has(tag)) {
        cleanNode(child);

        while (child.firstChild) {
          child.parentNode.insertBefore(
            child.firstChild,
            child
          );
        }

        child.remove();
        continue;
      }

      // SPAN: somente class="gold".
      if (tag === 'SPAN') {
        const validClass =
          ALLOWED_SPAN_CLASSES.has(
            child.getAttribute('class')
          );

        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name);
        }

        if (validClass) {
          child.setAttribute('class', 'gold');
        }
      }

      // A: somente href, target e rel.
      else if (tag === 'A') {
        const href = child.getAttribute('href') || '';

        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name);
        }

        if (isSafeHref(href)) {
          child.setAttribute('href', href.trim());
          child.setAttribute('target', '_blank');
          child.setAttribute(
            'rel',
            'noopener noreferrer'
          );
        }
      }

      // Demais tags permitidas: nenhum atributo.
      else {
        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name);
        }
      }

      cleanNode(child);
    }
  }

  cleanNode(root);

  return root.innerHTML;
}

// ============================================================
// VALIDAÇÃO DE LINKS
// ------------------------------------------------------------
// Aceita: #ancora, http(s):, mailto:
// Rejeita: javascript:, data:, file:, //host, controles.
// ─────────────────────────────────────────────────────────────

function isSafeHref(href) {
  const raw = String(href || '').trim();

  if (!raw) return false;

  // Rejeita caracteres de controle.
  if (/[\u0000-\u001F\u007F]/.test(raw)) {
    return false;
  }

  if (raw.startsWith('#')) {
    return true;
  }

  if (raw.startsWith('//')) {
    return false;
  }

  try {
    const url = new URL(raw, 'https://local.invalid');

    return [
      'https:',
      'http:',
      'mailto:'
    ].includes(url.protocol);
  } catch {
    return false;
  }
}

// ============================================================
// REMOÇÃO DE HTML
// ------------------------------------------------------------
// Remove todas as tags, preservando o texto.
// O fallback por regex é apenas emergência.
// ─────────────────────────────────────────────────────────────

export function stripHtml(input) {
  const raw = String(input ?? '');

  if (!raw) return '';

  if (typeof DOMParser === 'undefined') {
    return raw
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim();
  }

  const doc = new DOMParser().parseFromString(
    raw,
    'text/html'
  );

  return doc.body?.textContent || '';
}