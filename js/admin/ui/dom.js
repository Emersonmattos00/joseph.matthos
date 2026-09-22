/* ============================================================
   js/admin/ui/dom.js
   ------------------------------------------------------------
   Helpers DOM utilizados pelo painel administrativo.

   - getByPath / setByPath : acesso e mutação segura de objetos
   - esc                   : escape de HTML (conteúdo em elementos)
   - escAttr               : escape de atributos HTML (mais rigoroso)
   - sanitizeHtml          : permite apenas tags seguras (b/i/br/span)
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

// ─────────────────────────────────────────────────────────────
// ACESSO A PATHS
// ─────────────────────────────────────────────────────────────
export function getByPath(obj, path) {
  if (!obj || typeof path !== 'string' || !path) {
    return undefined;
  }

  return path
    .split('.')
    .reduce(
      (o, k) => (
        o && o[k] !== undefined
          ? o[k]
          : undefined
      ),
      obj
    );
}

export function setByPath(obj, path, value) {
  if (!obj || typeof obj !== 'object') {
    return;
  }

  if (typeof path !== 'string' || !path) {
    return;
  }

  const keys = path.split('.');
  const last = keys.pop();

  if (!last) return;

  const target = keys.reduce((o, k) => {
    if (
      typeof o[k] !== 'object' ||
      o[k] === null ||
      Array.isArray(o[k])
    ) {
      o[k] = {};
    }

    return o[k];
  }, obj);

  target[last] = value;
}

// ─────────────────────────────────────────────────────────────
// ESCAPE — TEXTO EM ELEMENTOS HTML
// ------------------------------------------------------------
// Use para conteúdo que vai DENTRO de elementos:
//   <div>${esc(userText)}</div>
//
// Escapa: & < > " ' ` =
// (inclui backtick e igual para cobrir casos em atributos sem quotes)
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
  return String(value == null ? '' : value)
    .replace(/[&<>"'`=]/g, (char) => HTML_ESCAPE_MAP[char]);
}

// ─────────────────────────────────────────────────────────────
// ESCAPE — VALORES DE ATRIBUTOS HTML
// ------------------------------------------------------------
// Use para valores de atributos:
//   <input value="${escAttr(userText)}">
//   <a href="${escAttr(url)}">
//
// Diferente do esc(): NÃO escapa '&' e '=' porque em atributos
// eles são legítimos. Mas escapa < > " ' ` e também newlines/tabs
// para evitar quebras em atributos não citados.
//
// ⚠️ Sempre use quotes duplas nos atributos quando usar escAttr.
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
  return String(value == null ? '' : value)
    .replace(/[&<>"'`\n\r\t]/g, (char) => ATTR_ESCAPE_MAP[char]);
}

// ─────────────────────────────────────────────────────────────
// SANITIZE HTML — permite apenas tags seguras
// ------------------------------------------------------------
// Use quando o admin pode escrever HTML simples no painel:
//   hero.title     → <br>, <span class="gold">
//   sobre.paragraphs → <strong>, <em>, <br>
//
// Tags permitidas: b, i, em, strong, br, span, p, a
// Atributos permitidos: apenas em <span> (class="gold") e <a>
//   (href com whitelist http(s), target, rel)
//
// Se a string vier com tags maliciosas (<script>, <iframe>, etc),
// elas são REMOVIDAS — o texto interno é mantido.
// ─────────────────────────────────────────────────────────────
const ALLOWED_TAGS = new Set([
  'B', 'I', 'EM', 'STRONG', 'BR', 'SPAN', 'P', 'A'
]);

const ALLOWED_SPAN_CLASSES = new Set(['gold']);

const ALLOWED_A_ATTRS = new Set(['href', 'target', 'rel']);

export function sanitizeHtml(input) {
  const raw = String(input == null ? '' : input);
  if (!raw) return '';

  if (typeof DOMParser === 'undefined') {
    // Ambiente sem DOM → apenas escapa
    return esc(raw);
  }

  const doc = new DOMParser().parseFromString(
    `<div>${raw}</div>`,
    'text/html'
  );

  const root = doc.body.firstChild;
  if (!root) return '';

  // Walk recursivo
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      // Texto → mantém
      if (child.nodeType === Node.TEXT_NODE) continue;

      // Comentários e outros nós → remove
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }

      const tag = child.tagName.toUpperCase();

      // Tag não permitida → troca por texto
      if (!ALLOWED_TAGS.has(tag)) {
        child.replaceWith(doc.createTextNode(child.textContent || ''));
        continue;
      }

      // Tag permitida → limpa atributos
      if (tag === 'SPAN') {
        const cls = child.getAttribute('class');
        // Só permite class="gold"
        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name);
        }
        if (cls && ALLOWED_SPAN_CLASSES.has(cls)) {
          child.setAttribute('class', cls);
        }
      } else if (tag === 'A') {
        for (const attr of Array.from(child.attributes)) {
          if (!ALLOWED_A_ATTRS.has(attr.name.toLowerCase())) {
            child.removeAttribute(attr.name);
          }
        }
        // Valida href
        const href = child.getAttribute('href') || '';
        if (!isSafeHref(href)) {
          child.removeAttribute('href');
        }
        // Força rel seguro em links externos
        if (child.getAttribute('href')) {
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
      } else {
        // b/i/em/strong/br/p → remove todos os atributos
        for (const attr of Array.from(child.attributes)) {
          child.removeAttribute(attr.name);
        }
      }

      // Recursivo
      walk(child);
    }
  };

  walk(root);
  return root.innerHTML;
}

// ─────────────────────────────────────────────────────────────
// STRIP HTML — remove todas as tags
// ─────────────────────────────────────────────────────────────
export function stripHtml(input) {
  const raw = String(input == null ? '' : input);
  if (!raw) return '';
  if (typeof DOMParser === 'undefined') {
    return raw.replace(/<[^>]*>/g, '');
  }
  const doc = new DOMParser().parseFromString(
    `<div>${raw}</div>`,
    'text/html'
  );
  return doc.body.textContent || '';
}

// ─────────────────────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────────────────────

/**
 * Valida href de link:
 *  - aceita http:// e https://
 *  - aceita mailto:
 *  - aceita caminhos relativos (#ancora, /pagina)
 *  - rejeita javascript:, data:, file:, etc.
 */
function isSafeHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return false;

  // Âncora interna
  if (raw.startsWith('#')) return true;

  // Caminho relativo (sem esquema)
  if (!/^[a-z][a-z0-9+.\-]*:/i.test(raw)) return true;

  // Esquema explícito → whitelist
  const lower = raw.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) return true;
  if (lower.startsWith('mailto:')) return true;

  return false;
}
