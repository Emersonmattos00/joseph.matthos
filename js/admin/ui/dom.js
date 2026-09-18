/* ============================================================
   js/admin/ui/dom.js
   ------------------------------------------------------------
   Helpers DOM utilizados pelo painel administrativo.

   - getByPath / setByPath : acesso e mutação segura de objetos
   - esc                   : escape de HTML

   Reexporta safeExternalUrl para compatibilidade com módulos
   que importam de '../ui/dom.js' (ex: socials.js).
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// REEXPORTS de utils.js
// ------------------------------------------------------------
// O editor de redes sociais (socials.js) importa safeExternalUrl
// de '../ui/dom.js'. Esta linha mantém esse contrato sem duplicar
// a implementação (que vive em utils.js).
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
// ESCAPE HTML
// ─────────────────────────────────────────────────────────────
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
}
