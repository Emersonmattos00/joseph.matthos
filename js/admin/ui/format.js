/* ============================================================
   js/admin/ui/format.js
   Formatação compartilhada do painel administrativo
   ============================================================ */

const BRL_FORMATTER = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL'
});

export function formatCents(cents) {
  if (cents === null || cents === undefined || cents === '') {
    return 'R$ 0,00';
  }

  const value = Number(cents);

  if (!Number.isFinite(value)) {
    return 'R$ 0,00';
  }

  return BRL_FORMATTER.format(value / 100).replace(/\u00A0/g, ' ');
}

export function formatMoney(value) {
  if (value === null || value === undefined || value === '') {
    return 'R$ 0,00';
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 'R$ 0,00';
  }

  return BRL_FORMATTER.format(number).replace(/\u00A0/g, ' ');
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }

    return date;
  }

  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return null;
  }

  return date;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

export function formatDate(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return DATE_FORMATTER.format(date);
}

const DATETIME_FORMATTER = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

export function formatDateTime(value) {
  const date = parseDate(value);
  if (!date) return '—';
  return DATETIME_FORMATTER.format(date);
}

export function formatRelative(value) {
  const date = parseDate(value);
  if (!date) return '—';

  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(Math.abs(diffMs) / 60000);

  if (diffMs < 0) {
    if (diffMin < 1) return 'em instantes';
    if (diffMin < 60) return `em ${diffMin} min`;

    const hours = Math.floor(diffMin / 60);
    if (hours < 24) return `em ${hours} h`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `em ${days} d`;

    return formatDate(date);
  }

  if (diffMin < 1) return 'agora';
  if (diffMin < 60) return `${diffMin} min atrás`;

  const hours = Math.floor(diffMin / 60);
  if (hours < 24) return `${hours} h atrás`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d atrás`;

  return formatDate(date);
}

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    char => HTML_ESCAPE_MAP[char]
  );
}

export function escAttr(value) {
  return String(value ?? '').replace(
    /[&<>"'`\r\n\t]/g,
    char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '`': '&#96;',
      '\r': '&#13;',
      '\n': '&#10;',
      '\t': '&#9;'
    })[char]
  );
}
