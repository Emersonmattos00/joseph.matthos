javascript
/* ============================================================
   js/admin/ui/dom.js
   ------------------------------------------------------------
   Helpers DOM utilizados pelo painel administrativo.
   ============================================================ */

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
