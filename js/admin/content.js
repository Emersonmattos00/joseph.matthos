/* ============================================================
   admin/content.js — Conteúdo do site (GET/PUT)
   ------------------------------------------------------------
   - GET: tenta API, propaga 401/403, cai para DEFAULT_CONTENT
     só em falha de rede/5xx
   - PUT: envia baseVersion (controle de conflito otimista),
     preserva status/code do erro, marca "clean" ao salvar
   ============================================================ */

import { apiFetch } from './api.js';
import { DEFAULT_CONTENT } from '../config.js';
import { markClean } from './state.js';

const MAX_PAYLOAD_BYTES = 2_000_000;

// ─────────────────────────────────────────────────────────────
// GET
// ─────────────────────────────────────────────────────────────
export async function loadContent() {
  try {
    const result = await apiFetch('content', { method: 'GET' });

    if (result && result.ok) {
      const data =
        result.data && typeof result.data === 'object'
          ? result.data
          : {};
      return {
        data,
        version: Number(result.version) || 0,
        updatedAt: result.updatedAt || null
      };
    }

    // Servidor respondeu sem ok (não deveria acontecer com apiFetch)
    throw new Error(result?.error || 'Resposta inválida do servidor.');
  } catch (err) {
    // 401/403: sessão inválida → propaga para o caller decidir
    if (err && (err.status === 401 || err.status === 403)) {
      throw err;
    }

    // Rede/5xx: fallback seguro para o conteúdo padrão
    console.warn(
      '[content] API indisponível, usando DEFAULT_CONTENT:',
      err?.message || err
    );
    return {
      data: JSON.parse(JSON.stringify(DEFAULT_CONTENT)),
      version: 0,
      updatedAt: null
    };
  }
}

// ─────────────────────────────────────────────────────────────
// PUT
// ─────────────────────────────────────────────────────────────
export async function saveContent(data, options = {}) {
  if (!data || typeof data !== 'object') {
    throw new Error('Conteúdo inválido.');
  }

  // Check local de tamanho (evita round-trip desnecessário)
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    const err = new Error('Conteúdo muito grande. Reduza imagens ou remova itens.');
    err.status = 413;
    err.code = 'PAYLOAD_TOO_LARGE';
    throw err;
  }

  // Versão base para controle de concorrência otimista
  const baseVersion = Number.isFinite(options.baseVersion)
    ? Number(options.baseVersion)
    : undefined;

  let result;
  try {
    result = await apiFetch('content', {
      method: 'PUT',
      body: { data, baseVersion }
    });
  } catch (err) {
    // 409: conflito de versão
    if (err && err.status === 409) {
      const conflict = new Error(
        'O conteúdo foi alterado por outro administrador. Recarregue e tente novamente.'
      );
      conflict.status = 409;
      conflict.code = 'VERSION_CONFLICT';
      conflict.data = err.data;
      throw conflict;
    }
    throw err;
  }

  if (!result || !result.ok) {
    const e = new Error(result?.error || 'Falha ao salvar.');
    e.status = result?.status || 0;
    e.code = result?.code || null;
    throw e;
  }

  // Sucesso: limpa flag "dirty"
  markClean();

  return {
    version: Number(result.version) || 0,
    updatedAt: result.updatedAt || null
  };
}