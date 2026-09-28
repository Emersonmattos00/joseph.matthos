/* ============================================================
   js/admin/api.js — Wrapper de fetch para o painel admin
   ------------------------------------------------------------
   ⚠️  CONTRATO — leia antes de adicionar código

   ✅ USE esta camada para TODA comunicação com /api/admin.
      Não importa se é GET, POST, PATCH ou DELETE.
      Não importa se é leitura ou escrita.

   ❌ NÃO adicione:
      - fetch('/api/admin?...') direto em outro arquivo
      - Axios / jQuery / XMLHttpRequest direto
      - `apiFetch` em código do site público (só o admin usa)

   ✅ PODE usar fetch direto (fora desta camada) APENAS para:
      - /api/public      (playlists-api.js — não exige sessão)
      - /api/auth        (auth do site público — não é admin)
      - /api/stream      (player — não é admin)
      - /api/payments    (checkout — não é admin)
      - URLs externas    (Supabase Storage, MP, etc)

   🔧 Quando adicionar uma action nova:
      1. Adicione o helper semântico aqui
      2. Use o helper no código que precisa
      3. NUNCA chame apiFetch('x', ...) direto do editor

   Uso básico:
     apiFetch('users', { method: 'GET' })
     apiFetch('sales', { query: { days: 30 } })
     apiFetch('content', { method: 'PUT', body: { data, baseVersion } })

   Helpers semânticos:
     listAlbums() / createAlbum() / updateAlbum() / deleteAlbum()
     listTracks() / createTrack() / updateTrack() / deleteTrack() / reorderTracks()
     requestUploadSign() / confirmUpload()
     getDownloadUrl() / getDownloadAlbum()

   🔧 CONTRATO COM O BACKEND
   ------------------------------------------------------------
   O `api/admin.js` mapeia os actions assim:

     action=albums  → GET  lista, POST cria
     action=album   → GET  detalhe, PATCH atualiza, DELETE exclui
     action=tracks  → GET  lista (query: albumId), POST cria
     action=track   → PATCH atualiza (query: id), DELETE exclui

   ⚠️  `album` e `track` são SINGULARES (operam sobre um item).
       `albums` e `tracks` são PLURAIS (operam sobre coleção).

   🔧 TIMEOUT
   ------------------------------------------------------------
   Todas as requisições têm timeout de 30s (TIMEOUT_DEFAULT_MS).
   O caller pode sobrescrever via `timeoutMs`.

   Erros estruturados:
     err.code === 'ABORTED'       → caller cancelou (via signal)
     err.code === 'TIMEOUT'       → tempo esgotado
     err.code === 'NETWORK_ERROR' → falha de rede

   ⚠️  NÃO adicione retry automático. PATCH/POST não são
       idempotentes. Cada módulo já tem botão "Tentar novamente".
   ============================================================ */

const API_BASE = '/api/admin';
const TIMEOUT_DEFAULT_MS = 30000;

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
 * @param {object} [options.query]      — pares chave/valor para query string
 * @param {object} [options.body]       — objeto → JSON.stringify
 * @param {object} [options.headers]    — headers adicionais
 * @param {AbortSignal} [options.signal] — sinal externo (cancelamento)
 * @param {number} [options.timeoutMs=30000] — timeout em ms
 */
export async function apiFetch(action, options = {}) {
  const {
    method = 'GET',
    query = null,
    body = null,
    headers = {},
    signal,
    timeoutMs = TIMEOUT_DEFAULT_MS
  } = options;

  const url = buildUrl(action, query);

  const finalHeaders = { ...headers };
  let finalBody = null;

  if (body !== null && body !== undefined) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }

  // ── Compõe timeout com signal externo (se houver)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: finalBody,
      credentials: 'same-origin',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timeout);

    const isExternalAbort = signal && signal.aborted;
    const isTimeout = err?.name === 'AbortError' && !isExternalAbort;

    const networkErr = new Error(
      isExternalAbort ? 'Requisição cancelada.'
      : isTimeout ? 'Tempo esgotado. Tente novamente.'
      : 'Falha de conexão com o servidor.'
    );
    networkErr.status = 0;
    networkErr.code = isExternalAbort ? 'ABORTED'
                    : isTimeout ? 'TIMEOUT'
                    : 'NETWORK_ERROR';
    networkErr.cause = err;
    throw networkErr;
  } finally {
    clearTimeout(timeout);
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
 *
 * Exemplo:
 *   // Após upload do áudio completo
 *   await updateTrack(42, { full_path: '1699_abc.mp3' });
 *
 *   // Após upload da prévia
 *   await updateTrack(42, { preview_path: '1699_def.mp3' });
 *
 * @param {number|string} trackId
 * @param {object} patch
 * @returns {Promise<{ ok: true, track: object }>}
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
// Helpers semânticos — DOWNLOADS (admin)
// ─────────────────────────────────────────────────────────────

/**
 * Retorna URL assinada para baixar uma faixa (áudio completo).
 * A URL expira em 1 hora e força download via Content-Disposition.
 *
 * @param {number|string} trackId
 * @returns {Promise<{ ok: true, url: string, filename: string, expiresIn: number }>}
 */
export function getDownloadUrl(trackId) {
  return apiFetch('download-url', {
    method: 'GET',
    query: { id: trackId }
  });
}

/**
 * Retorna URLs assinadas para todas as faixas de um álbum.
 * Cada URL expira em 1 hora. O frontend itera e baixa uma a uma.
 *
 * @param {string} albumId
 * @returns {Promise<{ ok: true, albumId: string, expiresIn: number, tracks: Array }>}
 */
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
