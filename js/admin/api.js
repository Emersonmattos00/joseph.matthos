/* ============================================================
   admin/api.js — Wrapper de fetch para o painel admin
   ------------------------------------------------------------
   - Aceita `action` + `query` (objeto) → monta URL corretamente
   - Aceita `body` (JSON) → Content-Type automático
   - Preserva status, code e data em erros
   - Propaga 401/403/429/503 para o caller
   - Envia credentials: same-origin
   ------------------------------------------------------------
   Uso:
     apiFetch('users', { method: 'GET' })
     apiFetch('sales', { query: { days: 30 } })
     apiFetch('content', { method: 'PUT', body: { data, baseVersion } })
   ============================================================ */

const API_BASE = '/api/admin';

/**
 * Monta a URL final com action + query string.
 * @param {string} action — ex: 'users', 'sales', 'content'
 * @param {object} [query] — pares chave/valor (ignora null/undefined)
 */
function buildUrl(action, query) {
  const params = new URLSearchParams();
  params.set('action', action);

  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      params.set(key, String(value));
    }
  }

  return `${API_BASE}?${params.toString()}`;
}

/**
 * Wrapper de fetch.
 * @param {string} action
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.query] — pares chave/valor para query string
 * @param {object} [options.body]  — objeto → JSON.stringify
 * @param {object} [options.headers] — headers adicionais
 * @param {AbortSignal} [options.signal]
 */
export async function apiFetch(action, options = {}) {
  const {
    method = 'GET',
    query = null,
    body = null,
    headers = {},
    signal
  } = options;

  const url = buildUrl(action, query);

  const finalHeaders = { ...headers };
  let finalBody = null;

  if (body !== null && body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: finalBody,
      credentials: 'same-origin',
      signal
    });
  } catch (err) {
    // Falha de rede/DNS/abort
    const networkErr = new Error(
      err?.name === 'AbortError'
        ? 'Requisição cancelada.'
        : 'Falha de conexão com o servidor.'
    );
    networkErr.status = 0;
    networkErr.code = 'NETWORK_ERROR';
    networkErr.cause = err;
    throw networkErr;
  }

  // Tenta parsear JSON (mesmo em erro, para extrair {error, code})
  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    // Tenta texto (útil para debug de erros HTML)
    try {
      const text = await response.text();
      data = text ? { error: text.slice(0, 200) } : null;
    } catch {
      data = null;
    }
  }

  // Sucesso
  if (response.ok) {
    return data || { ok: true };
  }

  // Erro HTTP — preserva status, code e data
  const err = new Error(
    data?.error ||
    data?.message ||
    `Erro ${response.status}`
  );
  err.status = response.status;
  err.code = data?.code || null;
  err.data = data;
  throw err;
}

// ─────────────────────────────────────────────────────────────
// Compatibilidade: export default também
// ─────────────────────────────────────────────────────────────
export default apiFetch;
