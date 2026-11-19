/* ============================================================
   js/admin/api.js — v2.6 (Wrapper de fetch para o painel admin)
   ------------------------------------------------------------
   Correções da auditoria:
   1. Exportação de `isPlainObject` para uso no `uploads.js`
   2. Validação estrita de `options` (rejeita arrays/null)
   3. Try-catch na criação de `Headers` para mensagens claras
   4. Validação de que `JSON.stringify` retorna uma string
   5. Respostas 200 OK não-JSON retornam `{ text }` em vez de `{ error }`
   ============================================================ */

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const API_BASE = '/api/admin';

export function buildUrl(action, query) {
  if (typeof action !== 'string' || !action.trim()) {
    throw new TypeError('Action inválida. Deve ser uma string não vazia.');
  }

  const params = new URLSearchParams();
  params.set('action', action.trim());

  if (query !== null && query !== undefined) {
    if (!isPlainObject(query)) {
      throw new TypeError('Query deve ser um objeto simples (plain object).');
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params.set(key, String(value));
      } else {
        throw new TypeError(`Valor da query '${key}' deve ser um primitivo (string, number ou boolean).`);
      }
    }
  }

  return `${API_BASE}?${params.toString()}`;
}

export async function apiFetch(action, options = {}) {
  // Correção 1 & 2: Validação estrita de options
  if (!isPlainObject(options)) {
    throw new TypeError('Options deve ser um objeto simples.');
  }

  const {
    method = 'GET',
    query = null,
    body = null,
    headers = {},
    signal
  } = options;

  const normalizedMethod = String(method).toUpperCase();
  const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

  if (!allowedMethods.has(normalizedMethod)) {
    throw new TypeError(`Método HTTP não permitido: ${normalizedMethod}`);
  }

  if ((normalizedMethod === 'GET' || normalizedMethod === 'HEAD') && body !== null && body !== undefined) {
    throw new TypeError(`Método ${normalizedMethod} não suporta body.`);
  }

  const url = buildUrl(action, query);
  
  // Correção 3: Try-catch na criação de Headers
  let finalHeaders;
  try {
    finalHeaders = new Headers(headers || {});
  } catch (err) {
    throw new TypeError(`Cabeçalhos inválidos: ${err.message}`);
  }

  let finalBody = null;
  if (body !== null && body !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
    
    // Correção 4: Validação do resultado da serialização
    const serialized = JSON.stringify(body);
    if (typeof serialized !== 'string') {
      throw new TypeError('Body não pode ser serializado como JSON.');
    }
    finalBody = serialized;
  }

  let response;
  try {
    response = await fetch(url, {
      method: normalizedMethod,
      headers: finalHeaders,
      body: finalBody,
      credentials: 'same-origin',
      signal
    });
  } catch (err) {
    const networkErr = new Error(
      err?.name === 'AbortError' ? 'Requisição cancelada.' : 'Falha de conexão com o servidor.'
    );
    if (err?.name === 'AbortError') networkErr.name = 'AbortError';
    networkErr.status = 0;
    networkErr.code = err?.name === 'AbortError' ? 'ABORTED' : 'NETWORK_ERROR';
    networkErr.cause = err;
    throw networkErr;
  }

  let data = null;
  let parseError = null;
  const contentType = response.headers.get('content-type') || '';
  const isJson = /(?:application\/json|application\/[^;]+\+json)/i.test(contentType);

  if (isJson) {
    try {
      data = await response.json();
    } catch (err) {
      parseError = err;
    }
  } else {
    try {
      const text = await response.text();
      data = text ? { text } : null; // Correção 5: Não usar a chave 'error' em respostas 200 OK
    } catch {
      data = null;
    }
  }

  if (response.ok) {
    if (parseError) {
      throw new Error(`Resposta JSON inválida do servidor: ${parseError.message}`);
    }
    return data !== null ? data : { ok: true };
  }

  const err = new Error(data?.error || data?.text || data?.message || `Erro ${response.status}`);
  err.status = response.status;
  err.code = data?.code || null;
  err.data = data;
  throw err;
}

// Helpers semânticos (mantidos inalterados)
export function listAlbums() { return apiFetch('albums', { method: 'GET' }); }
export function createAlbum(payload) { return apiFetch('albums', { method: 'POST', body: payload }); }
export function getAlbum(albumId) { return apiFetch('album', { method: 'GET', query: { id: albumId } }); }
export function updateAlbum(albumId, patch) { return apiFetch('album', { method: 'PATCH', query: { id: albumId }, body: patch }); }
export function deleteAlbum(albumId, force = false) {
  const query = { id: albumId };
  if (force) query.force = 'true';
  return apiFetch('album', { method: 'DELETE', query });
}

export function listTracks(albumId) { return apiFetch('tracks', { method: 'GET', query: { albumId } }); }
export function createTrack(payload) { return apiFetch('tracks', { method: 'POST', body: payload }); }
export function updateTrack(trackId, patch) { return apiFetch('track', { method: 'PATCH', query: { id: trackId }, body: patch }); }
export function deleteTrack(trackId) { return apiFetch('track', { method: 'DELETE', query: { id: trackId } }); }
export function reorderTracks(order) { return apiFetch('track-order', { method: 'PATCH', body: { order } }); }

export function requestUploadSign(payload) { return apiFetch('upload-sign', { method: 'POST', body: payload }); }
export function confirmUpload(payload) { return apiFetch('upload-confirm', { method: 'POST', body: payload }); }

export function getDownloadUrl(trackId) { return apiFetch('download-url', { method: 'GET', query: { id: trackId } }); }
export function getDownloadAlbum(albumId) { return apiFetch('download-album', { method: 'GET', query: { id: albumId } }); }

export default apiFetch;
