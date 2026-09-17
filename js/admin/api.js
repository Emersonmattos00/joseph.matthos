/* ============================================================
   admin/api.js — Wrapper de fetch para o admin
   ------------------------------------------------------------
   Todas as chamadas vão para /api/admin?action=xxx.
   O wrapper injeta credenciais (cookie de sessão), envia JSON,
   trata erro de rede e JSON inválido.
   ============================================================ */

const BASE = '/api/admin';

export async function apiFetch(actionOrPath, options = {}) {
  // Aceita:
  //   apiFetch('content', { method: 'GET' })
  //   apiFetch('?action=content', { method: 'GET' })
  //   apiFetch('/api/admin?action=content', { method: 'GET' })
  const url = buildUrl(actionOrPath);

  const { method = 'GET', body, headers = {} } = options;

  const init = {
    method,
    credentials: 'same-origin',
    headers: { ...headers }
  };

  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const e = new Error('Falha de rede');
    e.code = 'NETWORK';
    e.cause = err;
    throw e;
  }

  let data = null;
  const text = await response.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, error: 'Resposta inválida do servidor.' };
  }

  if (!response.ok) {
    const e = new Error((data && data.error) || `HTTP ${response.status}`);
    e.status = response.status;
    e.code = (data && data.code) || null;
    e.data = data;
    throw e;
  }

  return data || {};
}

// ─────────────────────────────────────────────────────────────
// URL builder
// ─────────────────────────────────────────────────────────────
function buildUrl(input) {
  if (!input) return BASE;

  // Já é uma URL completa
  if (typeof input === 'string' && input.startsWith('/api/')) {
    return input;
  }

  // Já tem query string
  if (typeof input === 'string' && input.startsWith('?')) {
    return `${BASE}${input}`;
  }

  // Ação simples → vira ?action=xxx
  return `${BASE}?action=${encodeURIComponent(String(input))}`;
}