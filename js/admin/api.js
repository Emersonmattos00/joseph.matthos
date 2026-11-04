/* ============================================================
   js/admin/api.js — Wrapper de fetch para o painel admin
   ------------------------------------------------------------
   - Aceita `action` + `query` (objeto) → monta URL corretamente
   - Aceita `body` (JSON) → Content-Type automático
   - Preserva status, code e data em erros
   - Propaga 401/403/429/503 para o caller
   - Envia credentials: same-origin

   🔧 CONTRATO COM O BACKEND
   ------------------------------------------------------------
   O `api/admin.js` mapeia os actions assim:

     action=albums  → GET  lista, POST cria
     action=album   → GET  detalhe, PATCH atualiza, DELETE exclui
     action=tracks  → GET  lista (query: albumId), POST cria
     action=track   → PATCH atualiza (query: id), DELETE exclui
     action=track-order → PATCH reordena

   ⚠️  `album` e `track` são SINGULARES (operam sobre um item).
       `albums` e `tracks` são PLURAIS (operam sobre coleção).
   ============================================================ */

const API_BASE = '/api/admin';

// ─────────────────────────────────────────────────────────────
// Monta a URL final com action + query string
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Wrapper de fetch
// ─────────────────────────────────────────────────────────────
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
    const networkErr = new Error(
      err?.name === 'AbortError'
        ? 'Requisição cancelada.'
        : 'Falha de conexão com o servidor.'
    );
    networkErr.status = 0;
    networkErr.code = err?.name === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR';
    networkErr.cause = err;
    throw networkErr;
  }

  let data = null;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    try {
      const text = await response.text();
      data = text ? { error: text.slice(0, 200) } : null;
    } catch {
      data = null;
    }
  }

  if (response.ok) {
    return data || { ok: true };
  }

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
// Helpers semânticos — ÁLBUNS
// ─────────────────────────────────────────────────────────────

export function listAlbums() {
  return apiFetch('albums', { method: 'GET' });
}

export function createAlbum(payload) {
  return apiFetch('albums', { method: 'POST', body: payload });
}

export function getAlbum(albumId) {
  return apiFetch('album', {
    method: 'GET',
    query: { id: albumId }
  });
}

export function updateAlbum(albumId, patch) {
  return apiFetch('album', {
    method: 'PATCH',
    query: { id: albumId },
    body: patch
  });
}

export function deleteAlbum(albumId, force = false) {
  const query = { id: albumId };
  if (force) query.force = 'true';

  return apiFetch('album', { method: 'DELETE', query });
}

// ─────────────────────────────────────────────────────────────
// Helpers semânticos — FAIXAS
// ─────────────────────────────────────────────────────────────

export function listTracks(albumId) {
  return apiFetch('tracks', {
    method: 'GET',
    query: { albumId }
  });
}

export function createTrack(payload) {
  return apiFetch('tracks', { method: 'POST', body: payload });
}

export function updateTrack(trackId, patch) {
  return apiFetch('track', {
    method: 'PATCH',
    query: { id: trackId },
    body: patch
  });
}

export function deleteTrack(trackId) {
  return apiFetch('track', {
    method: 'DELETE',
    query: { id: trackId }
  });
}

/**
 * Reordena faixas de um álbum.
 * ★ CORREÇÃO: O backend espera `track_number`, não `track_index`.
 *
 * @param {Array<{ id: string, track_number: number }>} order
 */
export function reorderTracks(order) {
  return apiFetch('track-order', {
    method: 'PATCH',
    body: { order }
  });
}

// ─────────────────────────────────────────────────────────────
// Helpers semânticos — UPLOAD
// ─────────────────────────────────────────────────────────────

/**
 * Pede uma URL assinada de PUT para o Backblaze B2.
 * ★ CORREÇÃO: atualizada a documentação (era Supabase).
 *
 * @param {object} payload — { kind, filename, contentType, size }
 * @returns {Promise<{ ok: true, uploadUrl: string, token: string, path: string, bucket: string }>}
 */
export function requestUploadSign(payload) {
  return apiFetch('upload-sign', { method: 'POST', body: payload });
}

/**
 * Confirma que o arquivo foi enviado ao Storage.
 * Opcionalmente associa o path a uma faixa (albumId + trackIndex).
 *
 * @param {object} payload — { kind, path, albumId?, trackIndex? }
 * @returns {Promise<{ ok: true, path: string, bucket: string, url: string|null }>}
 */
export function confirmUpload(payload) {
  return apiFetch('upload-confirm', { method: 'POST', body: payload });
}

// ─────────────────────────────────────────────────────────────
// Helpers semânticos — DOWNLOADS (admin)
// ─────────────────────────────────────────────────────────────

export function getDownloadUrl(trackId) {
  return apiFetch('download-url', {
    method: 'GET',
    query: { id: trackId }
  });
}

export function getDownloadAlbum(albumId) {
  return apiFetch('download-album', {
    method: 'GET',
    query: { id: albumId }
  });
}

// ─────────────────────────────────────────────────────────────
// Compatibilidade: export default também
// ─────────────────────────────────────────────────────────────
export default apiFetch;