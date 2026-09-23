/* ============================================================
   js/admin/api.js — Wrapper de fetch para o painel admin
   ------------------------------------------------------------
   - Aceita `action` + `query` (objeto) → monta URL corretamente
   - Aceita `body` (JSON) → Content-Type automático
   - Preserva status, code e data em erros
   - Propaga 401/403/429/503 para o caller
   - Envia credentials: same-origin

   Uso básico:
     apiFetch('users', { method: 'GET' })
     apiFetch('sales', { query: { days: 30 } })
     apiFetch('content', { method: 'PUT', body: { data, baseVersion } })

   Helpers semânticos (açúcar por cima do apiFetch):
     updateTrack(trackId, patch)
     deleteTrack(trackId)
     createTrack(payload)
     listTracks(albumId)
     updateAlbum(albumId, patch)
     deleteAlbum(albumId, force)
     createAlbum(payload)
     listAlbums()

   🔧 CONTRATO COM O BACKEND
   ------------------------------------------------------------
   O `api/admin.js` mapeia os actions assim:

     action=albums  → GET  lista, POST cria
     action=album   → GET  detalhe, PATCH atualiza, DELETE exclui
     action=tracks  → GET  lista (query: albumId), POST cria
     action=track   → PATCH atualiza (query: id), DELETE exclui

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
/**
 * @param {string} action
 * @param {object} [options]
 * @param {string} [options.method='GET']
 * @param {object} [options.query]   — pares chave/valor para query string
 * @param {object} [options.body]    — objeto → JSON.stringify
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
// Helpers semânticos — ÁLBUNS
// ─────────────────────────────────────────────────────────────

/**
 * Lista todos os álbuns.
 * @returns {Promise<{ ok: true, albums: Array }>}
 */
export function listAlbums() {
  return apiFetch('albums', { method: 'GET' });
}

/**
 * Cria um novo álbum.
 * @param {object} payload — { id, title, artist, year, type, ... }
 * @returns {Promise<{ ok: true, album: object }>}
 */
export function createAlbum(payload) {
  return apiFetch('albums', { method: 'POST', body: payload });
}

/**
 * Busca um álbum específico.
 * @param {string} albumId
 */
export function getAlbum(albumId) {
  return apiFetch('album', {
    method: 'GET',
    query: { id: albumId }
  });
}

/**
 * Atualiza um álbum.
 * @param {string} albumId
 * @param {object} patch
 */
export function updateAlbum(albumId, patch) {
  return apiFetch('album', {
    method: 'PATCH',
    query: { id: albumId },
    body: patch
  });
}

/**
 * Exclui um álbum.
 * @param {string} albumId
 * @param {boolean} [force=false] — se true, exclui faixas primeiro
 */
export function deleteAlbum(albumId, force = false) {
  const query = { id: albumId };
  if (force) query.force = 'true';

  return apiFetch('album', { method: 'DELETE', query });
}

// ─────────────────────────────────────────────────────────────
// Helpers semânticos — FAIXAS
// ─────────────────────────────────────────────────────────────

/**
 * Lista as faixas de um álbum.
 * @param {string} albumId
 * @returns {Promise<{ ok: true, tracks: Array }>}
 */
export function listTracks(albumId) {
  return apiFetch('tracks', {
    method: 'GET',
    query: { albumId }
  });
}

/**
 * Cria uma nova faixa.
 * @param {object} payload — { album_id, title, duration, ... }
 * @returns {Promise<{ ok: true, track: object }>}
 */
export function createTrack(payload) {
  return apiFetch('tracks', { method: 'POST', body: payload });
}

/**
 * Atualiza uma faixa.
 * Este é o helper que o editor de álbuns usa para associar
 * `preview_path` e `full_path` após o upload.
 *
 * @param {number|string} trackId
 * @param {object} patch — { title?, duration?, preview_path?, full_path?, ... }
 * @returns {Promise<{ ok: true, track: object }>}
 *
 * @example
 *   // Após upload do áudio completo
 *   await updateTrack(42, { full_path: '1699_abc.mp3' });
 *
 *   // Após upload da prévia
 *   await updateTrack(42, { preview_path: '1699_def.mp3' });
 */
export function updateTrack(trackId, patch) {
  return apiFetch('track', {
    method: 'PATCH',
    query: { id: trackId },
    body: patch
  });
}

/**
 * Exclui uma faixa.
 * @param {number|string} trackId
 */
export function deleteTrack(trackId) {
  return apiFetch('track', {
    method: 'DELETE',
    query: { id: trackId }
  });
}

/**
 * Reordena faixas de um álbum.
 * @param {Array<{ id: number, track_index: number }>} order
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
 * Pede uma URL assinada de PUT para o Supabase Storage.
 * O browser faz o PUT direto, sem passar pela Vercel.
 *
 * @param {object} payload — { kind, filename, contentType, size }
 * @returns {Promise<{ ok: true, uploadUrl: string, path: string, bucket: string, expiresIn: number }>}
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
// Compatibilidade: export default também
// ─────────────────────────────────────────────────────────────
export default apiFetch;
