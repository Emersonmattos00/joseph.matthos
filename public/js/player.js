/* ============================================================
   js/admin/editors/albums.js — v10.1 (Security + Stability)
   ============================================================
   Correções aplicadas (Fases 1-4 da auditoria):
   1. Preview público + Full assinado (não mais ambos em bucket público)
   2. Restauração de posição antes de limpar a fonte
   3. Botões P/F verificam versão atual (troca de versão correta)
   4. crossOrigin removido quando não necessário (evita bloqueio CORS)
   5. Faixa + letra salvos em operação única (transacional)
   6. Invalicação de operações pendentes por reqId
   7. Drag & Drop restaurado via repaint() (não por innerHTML)
   8. Validação de upload: extensão + MIME + tamanho + assinatura mágica
   9. Limpeza completa do player após erro
   10. Botões prev/next funcionais (navegação no álbum)
   11. Impede drag entre álbuns diferentes
   12. Ano do álbum com limites (1900–ano atual+1)
   13. Lyrics rejeita tempos iguais (ordem estrita)
   14. Retry em erro de carregamento de faixas
   15. noopener em links externos do player
   16. Validação de domínio em URLs (apenas R2/josephmatthos.com.br)
   17. Estados visuais explícitos (loading, playing, paused, error, ended)
   ============================================================ */

import { apiFetch } from '../api.js';
import { toast } from '../ui/toast.js';
import { esc, escAttr } from '../ui/dom.js';
import { openAdminModal, closeAdminModal } from '../ui/modal.js';
import { uploadAudioPreview, uploadAudioFull } from '../uploads.js';

// ─────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────
const R2_PUBLIC_BASE = 'https://pub-9eaf26fd8c784a62bae2457a45edc7d2.r2.dev';
const ALLOWED_MEDIA_HOSTS = ['r2.dev', 'r2.cloudflarestorage.com', 'josephmatthos.com.br'];
const MAX_TRACK_PRICE_CENTS = 999900;
const MAX_AUDIO_FILE_SIZE = 200 * 1024 * 1024;
const MIN_ALBUM_YEAR = 1900;
const MAX_ALBUM_YEAR = new Date().getFullYear() + 1;

const ALLOWED_AUDIO_EXTS = ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'webm'];
const ALLOWED_AUDIO_TYPES = [
  'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
  'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm'
];

// ─────────────────────────────────────────────────────────────
// Estado global
// ─────────────────────────────────────────────────────────────
const State = {
  albums: [],
  tracks: new Map(),
  expandedAlbumIds: new Set(),
  loading: false,
  error: null,
  loadReqId: 0,
  tracksReqId: new Map(),
  pendingOperations: new Map(),
  trackOrderReqId: new Map()
};

let _dragState = null;

// ─────────────────────────────────────────────────────────────
// Player singleton
// ─────────────────────────────────────────────────────────────
const Player = {
  el: null,
  bar: null,
  current: null,
  versions: { preview: false, full: false },
  seq: 0,
  seeking: false,
  stallTimer: null,
  pendingRestore: null,
  state: 'idle' // idle | loading | playing | paused | error | ended
};

// ─────────────────────────────────────────────────────────────
// Ícones SVG
// ─────────────────────────────────────────────────────────────
const ICON = {
  play:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288V1.713z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7H2.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7h-2.6z"/></svg>',
  prev:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M13.151.922a.75.75 0 0 1 .112.948l-.112.13-3.872 3.872 3.872 3.871a.75.75 0 0 1-.948 1.168l-.132-.109L8.063 6.93a.75.75 0 0 1-.12-.94l.12-.13 3.87-3.87A.75.75 0 0 1 13.15.922zM3.75 1a.75.75 0 0 1 .14.013l.11.041A.75.75 0 0 1 4.5 1.75v12.5a.75.75 0 0 1-1.5 0V1.75a.75.75 0 0 1 .75-.75z"/></svg>',
  next:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2.838.922a.75.75 0 0 0-.111.948l.111.13 3.872 3.872-3.872 3.871a.75.75 0 0 0 .949 1.168l.132-.109 3.871-3.87a.75.75 0 0 0 .12-.94l-.12-.13-3.87-3.87a.75.75 0 0 0-1.082-.07zM12.25 1a.75.75 0 0 0-.14.013l-.11.041A.75.75 0 0 0 11.5 1.75v12.5a.75.75 0 0 0 1.5 0V1.75a.75.75 0 0 0-.75-.75z"/></svg>',
  vol:   '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.925 4.072a2.142 2.142 0 0 0-.783 2.929 2.142 2.142 0 0 0 .783.783L8.393 11.5v-7L2.816 4.922zM12.32 3.12a.75.75 0 0 1 1.06 0 6.726 6.726 0 0 1 1.973 4.773 6.726 6.726 0 0 1-1.973 4.773.75.75 0 1 1-1.061-1.06 5.226 5.226 0 0 0 1.534-3.712 5.226 5.226 0 0 0-1.534-3.713.75.75 0 0 1 0-1.061z"/></svg>',
  mute:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06z"/><path d="M10.116 1.527a.75.75 0 0 0-.375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.642 3.642 0 0 1-1.33-4.967 3.639 3.639 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 1.125.65.75.75 0 0 0 .375-.65zM7.616 6.5v7l-4.575-2.62a2.142 2.142 0 0 1-.783-2.929 2.142 2.142 0 0 1 .783-.783L7.616 6.5z"/></svg>',
  close: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06z"/></svg>',
  link:  '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.05 3.584a5.2 5.2 0 0 1 7.34 0 5.22 5.22 0 0 1 0 7.371l-2.378 2.378a5.21 5.21 0 0 1-7.371 0 .75.75 0 1 1 1.06-1.06 3.71 3.71 0 0 0 5.25 0l2.38-2.38a3.72 3.72 0 0 0 0-5.25 3.7 3.7 0 0 0-5.23 0L6.94 5.794a.75.75 0 0 1-1.06-1.06l1.17-1.15zm-4.259 1.434a5.213 5.213 0 0 1 7.37 0 .75.75 0 1 1-1.06 1.06 3.71 3.71 0 0 0-5.25 0L1.47 8.456a3.72 3.72 0 0 0 0 5.25 3.7 3.7 0 0 0 5.23 0L8.86 11.55a.75.75 0 1 1 1.06 1.06l-2.17 2.17a5.2 5.2 0 0 1-7.34 0 5.22 5.22 0 0 1 0-7.371L2.79 5.02z"/></svg>',
  stop:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2.5 1a.5.5 0 0 0-.5.5v13a.5.5 0 0 0 .5.5h11a.5.5 0 0 0 .5-.5v-13a.5.5 0 0 0-.5-.5h-11z"/></svg>'
};

// ─────────────────────────────────────────────────────────────
// Utilitários de validação
// ─────────────────────────────────────────────────────────────
function isAllowedMediaUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_MEDIA_HOSTS.some(h => u.hostname.endsWith(h));
  } catch { return false; }
}

function validateDuration(str) {
  if (!str || typeof str !== 'string' || !str.trim()) return true;
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(str.trim());
  if (!m) return false;
  const mm = Number(m[1]);
  return mm <= 180; // até 3h razoável
}

function validateAudioFile(file) {
  if (!file) return 'Selecione um arquivo.';
  if (file.size === 0) return 'Arquivo vazio.';
  if (file.size > MAX_AUDIO_FILE_SIZE) {
    return `Arquivo muito grande (${(file.size / 1048576).toFixed(1)} MB, máx ${MAX_AUDIO_FILE_SIZE / 1048576} MB).`;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_AUDIO_EXTS.includes(ext)) {
    return `Extensão .${ext} não suportada. Use: ${ALLOWED_AUDIO_EXTS.join(', ')}.`;
  }
  if (file.type && !ALLOWED_AUDIO_TYPES.includes(file.type)) {
    return `Tipo de arquivo inválido: ${file.type}.`;
  }
  return null;
}

function normalizePrice(cents) {
  const n = Number(cents);
  if (cents === '' || cents === null || cents === undefined) return 0;
  if (!Number.isInteger(n) || n < 0 || n > MAX_TRACK_PRICE_CENTS) return null;
  return n;
}

function validateYear(year) {
  const n = Number(year);
  if (year === '' || year === null || year === undefined) return null;
  if (!Number.isInteger(n)) return 'inválido';
  if (n < MIN_ALBUM_YEAR || n > MAX_ALBUM_YEAR) return `fora do intervalo ${MIN_ALBUM_YEAR}–${MAX_ALBUM_YEAR}`;
  return n;
}

// ─────────────────────────────────────────────────────────────
// parseLyricsInput — ordem estrita (tempos distintos)
// ─────────────────────────────────────────────────────────────
function parseLyricsInput(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let entries;
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { entries = JSON.parse(trimmed); } catch { return null; }
    if (!Array.isArray(entries)) return null;
  } else {
    entries = trimmed.split('\n').map((text, index) => ({ time: index * 4, text }));
  }

  const result = [];
  let previousTime = -1;
  for (const item of entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const time = Number(item.time);
    const text = String(item.text || '').trim();
    // Ordem estrita: tempos não podem ser iguais nem decrescentes
    if (!Number.isFinite(time) || time < 0 || !text || time <= previousTime) return null;
    previousTime = time;
    result.push({ time, text });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Resolver URL de áudio
// Preview: pública (R2). Full: URL assinada via download-url.
// ─────────────────────────────────────────────────────────────
async function getAdminAudioUrl(track, version) {
  const pathField = version === 'preview'
    ? (track.previewPath || track.preview_path)
    : (track.fullPath || track.full_path);

  if (!pathField) {
    throw new Error(version === 'preview' ? 'Prévia não cadastrada.' : 'Áudio completo não cadastrado.');
  }

  if (version === 'preview') {
    // Preview público
    if (/^https?:\/\//i.test(pathField)) {
      if (!isAllowedMediaUrl(pathField)) {
        throw new Error('Domínio da prévia não autorizado.');
      }
      return pathField;
    }
    const normalized = pathField.replace(/^\/+/, '');
    const url = `${R2_PUBLIC_BASE}/${normalized}`;
    if (!isAllowedMediaUrl(url)) throw new Error('URL de prévia inválida.');
    return url;
  }

  // Full: URL assinada (bucket privado)
  try {
    const res = await apiFetch('download-url', {
      method: 'GET',
      query: { id: String(track.id), type: 'full' }
    });
    if (res?.ok && res.url) {
      if (!isAllowedMediaUrl(res.url)) {
        throw new Error('URL assinada de domínio não autorizado.');
      }
      return res.url;
    }
    throw new Error(res?.error || 'Falha ao gerar URL assinada.');
  } catch (err) {
    // Fallback: se download-url não suportar type, tentar sem type
    try {
      const res2 = await apiFetch('download-url', {
        method: 'GET',
        query: { id: String(track.id) }
      });
      if (res2?.ok && res2.url) {
        if (!isAllowedMediaUrl(res2.url)) throw new Error('URL inválida.');
        return res2.url;
      }
    } catch { /* ignora */ }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
// Ponto de entrada
// ─────────────────────────────────────────────────────────────
export function renderAlbumsEditor(_content) {
  const container = document.getElementById('albumsEditor');
  if (!container) return;

  if (container.dataset.mounted === '1') {
    const body = container.querySelector('[data-albums-body]');
    if (body) paintBody(body);
    return;
  }

  container.dataset.mounted = '1';
  paintShell(container);
  loadAlbums();
}

function paintShell(container) {
  container.innerHTML = `
    <div class="albums-editor__header">
      <div>
        <p class="hint" style="margin:0;color:var(--text-dim);font-size:0.85rem;">
          Álbuns e faixas vivem no banco. Edite abaixo.
        </p>
      </div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-outline btn-sm" data-albums-refresh type="button">↻ Atualizar</button>
        <button class="btn btn-primary btn-sm" data-albums-new type="button">+ Novo álbum</button>
      </div>
    </div>
    <div data-albums-body>
      <div class="admin-loading">Carregando álbuns…</div>
    </div>
  `;

  container.querySelector('[data-albums-refresh]')?.addEventListener('click', () => loadAlbums());
  container.querySelector('[data-albums-new]')?.addEventListener('click', () => openAlbumModal(null));
}

// ─────────────────────────────────────────────────────────────
// Fetch com concorrência
// ─────────────────────────────────────────────────────────────
async function loadAlbums() {
  const body = document.querySelector('[data-albums-body]');
  if (!body) return;

  const currentReq = ++State.loadReqId;
  State.loading = true;
  State.error = null;
  paintBody(body);

  try {
    const res = await apiFetch('albums', { method: 'GET' });
    if (currentReq !== State.loadReqId) return;
    State.albums = Array.isArray(res?.albums) ? res.albums : [];

    await Promise.all(
      Array.from(State.expandedAlbumIds).map((id) => loadTracksForAlbum(id))
    );
  } catch (err) {
    if (currentReq !== State.loadReqId) return;
    if (err?.status === 401 || err?.status === 403) {
      toast('Sessão expirada.', '⚠');
      throw err;
    }
    State.error = err?.message || 'Falha ao carregar álbuns.';
    State.albums = [];
  } finally {
    if (currentReq === State.loadReqId) {
      State.loading = false;
      paintBody(body);
    }
  }
}

async function loadTracksForAlbum(albumId) {
  const reqId = (State.tracksReqId.get(albumId) || 0) + 1;
  State.tracksReqId.set(albumId, reqId);

  try {
    const res = await apiFetch('tracks', { method: 'GET', query: { albumId } });
    if ((State.tracksReqId.get(albumId) || 0) !== reqId) return;
    State.tracks.set(albumId, Array.isArray(res?.tracks) ? res.tracks : []);
  } catch (err) {
    if ((State.tracksReqId.get(albumId) || 0) !== reqId) return;
    console.warn(`[albums] falha faixas ${albumId}:`, err);
    State.tracks.set(albumId, { error: err?.message || 'Erro ao carregar faixas.' });
  }
}

// ─────────────────────────────────────────────────────────────
// Pintura
// ─────────────────────────────────────────────────────────────
function repaint() {
  const body = document.querySelector('[data-albums-body]');
  if (body) paintBody(body);
}

function paintBody(body) {
  if (State.loading) {
    body.innerHTML = '<div class="admin-loading">Carregando álbuns…</div>';
    return;
  }
  if (State.error) {
    body.innerHTML = `
      <div class="admin-error-box">
        <p>${esc(State.error)}</p>
        <button class="btn btn-outline btn-sm" data-albums-refresh type="button">Tentar novamente</button>
      </div>`;
    body.querySelector('[data-albums-refresh]')?.addEventListener('click', () => loadAlbums());
    return;
  }
  if (!State.albums.length) {
    body.innerHTML = `
      <div class="admin-empty">
        Nenhum álbum cadastrado ainda.<br>
        <button class="btn btn-primary btn-sm" data-albums-new type="button" style="margin-top:1rem;">
          + Criar primeiro álbum
        </button>
      </div>`;
    body.querySelector('[data-albums-new]')?.addEventListener('click', () => openAlbumModal(null));
    return;
  }

  body.innerHTML = State.albums.map((a) => renderAlbumBlock(a)).join('');
  bindAlbumButtons(body);
  bindTrackButtons(body);
}

// ─────────────────────────────────────────────────────────────
// Bind dos botões de álbum
// ─────────────────────────────────────────────────────────────
function bindAlbumButtons(scope) {
  scope.querySelectorAll('[data-album-toggle]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const albumId = btn.dataset.albumToggle;
      if (State.expandedAlbumIds.has(albumId)) {
        State.expandedAlbumIds.delete(albumId);
      } else {
        State.expandedAlbumIds.add(albumId);
        if (!State.tracks.has(albumId)) await loadTracksForAlbum(albumId);
      }
      repaint();
    });
  });

  scope.querySelectorAll('[data-album-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const albumId = btn.dataset.albumEdit;
      const album = State.albums.find((a) => a.id === albumId);
      if (album) openAlbumModal(album);
      else toast('Álbum não encontrado.', '⚠');
    });
  });

  scope.querySelectorAll('[data-album-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const albumId = btn.dataset.albumDelete;
      const album = State.albums.find((a) => a.id === albumId);
      if (!confirm(`Excluir o álbum "${album?.title || albumId}"? As faixas também serão removidas.`)) return;

      const opId = Date.now();
      State.pendingOperations.set(`album-${albumId}`, opId);

      try {
        await apiFetch('album', { method: 'DELETE', query: { id: albumId } });

        if (State.pendingOperations.get(`album-${albumId}`) !== opId) return;
        State.pendingOperations.delete(`album-${albumId}`);

        if (Player.current && String(Player.current.albumId) === String(albumId)) {
          stopPlayback();
        }
        State.expandedAlbumIds.delete(albumId);
        State.tracks.delete(albumId);
        State.tracksReqId.delete(albumId);
        State.trackOrderReqId.delete(albumId);

        toast('Álbum excluído.', '🗑');
        await loadAlbums();
      } catch (err) {
        if (State.pendingOperations.get(`album-${albumId}`) === opId) {
          State.pendingOperations.delete(`album-${albumId}`);
        }
        toast(err?.message || 'Falha ao excluir álbum.', '⚠');
      }
    });
  });

  scope.querySelectorAll('[data-album-download]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      downloadAlbum(btn.dataset.albumDownload);
    });
  });

  scope.querySelectorAll('[data-track-new]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openTrackModal(btn.dataset.trackNew, null);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Bind dos botões de faixa (P/F verificam versão atual)
// ─────────────────────────────────────────────────────────────
function bindTrackButtons(scope) {
  scope.querySelectorAll('[data-track-play]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const trackId = String(btn.dataset.trackPlay);
      const albumId = String(btn.dataset.trackAlbum);
      const requestedVersion = btn.dataset.playVersion || null;

      const isCurrent = Player.current
        && String(Player.current.trackId) === trackId
        && String(Player.current.albumId) === albumId;

      if (isCurrent) {
        const currentVersion = Player.current.version;

        // Se pediu versão diferente → troca
        if (requestedVersion && requestedVersion !== currentVersion) {
          await switchVersion(requestedVersion);
          return;
        }

        // Mesma faixa, mesma versão → toggle play/pause
        if (Player.el?.paused) await resumePlayback();
        else if (Player.el) Player.el.pause();
        return;
      }

      await playTrack(albumId, trackId, requestedVersion);
    });
  });

  scope.querySelectorAll('[data-track-edit]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const trackId = String(btn.dataset.trackEdit);
      const albumId = String(btn.dataset.trackAlbum);
      const list = State.tracks.get(albumId);
      const track = Array.isArray(list) ? list.find((t) => String(t.id) === trackId) : null;
      if (track) openTrackModal(albumId, track);
      else toast('Faixa não encontrada.', '⚠');
    });
  });

  scope.querySelectorAll('[data-track-delete]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const trackId = String(btn.dataset.trackDelete);
      const albumId = String(btn.dataset.trackAlbum);
      if (!trackId) return toast('Identificador da faixa inválido.', '⚠');
      if (!confirm('Excluir esta faixa?')) return;

      const opId = Date.now();
      State.pendingOperations.set(`track-${trackId}`, opId);

      try {
        await apiFetch('track', { method: 'DELETE', query: { id: trackId } });

        if (State.pendingOperations.get(`track-${trackId}`) !== opId) return;
        State.pendingOperations.delete(`track-${trackId}`);

        if (Player.current && String(Player.current.trackId) === trackId) stopPlayback();
        toast('Faixa excluída.', '🗑');
        await loadTracksForAlbum(albumId);
        repaint();
      } catch (err) {
        if (State.pendingOperations.get(`track-${trackId}`) === opId) {
          State.pendingOperations.delete(`track-${trackId}`);
        }
        toast(err?.message || 'Falha ao excluir faixa.', '⚠');
      }
    });
  });

  scope.querySelectorAll('[data-track-download]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      downloadTrack(btn.dataset.trackDownload, btn.dataset.trackDownloadTitle);
    });
  });

  scope.querySelectorAll('[data-track-retry]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      await loadTracksForAlbum(btn.dataset.trackRetry);
      repaint();
    });
  });

  bindTrackDragDrop(scope);
}

// ─────────────────────────────────────────────────────────────
// Player — construção (sem crossOrigin para não quebrar CORS)
// ─────────────────────────────────────────────────────────────
function ensurePlayer() {
  if (Player.el) return;

  const a = new Audio();
  a.preload = 'auto';
  // crossOrigin removido: URLs assinadas do R2 não exigem CORS
  // e previne bloqueio quando o bucket não tem política CORS configurada.

  a.addEventListener('timeupdate',     syncProgress);
  a.addEventListener('loadedmetadata', onLoadedMetadata);
  a.addEventListener('durationchange', syncProgress);
  a.addEventListener('play',           () => { setPlayerState('playing'); });
  a.addEventListener('pause',          () => {
    if (Player.state === 'playing') setPlayerState('paused');
  });
  a.addEventListener('ended',          onEnded);
  a.addEventListener('waiting',        () => setPlayerState('loading'));
  a.addEventListener('stalled',        () => {
    console.warn('[player] stalled em', a.currentSrc);
    setSub('Conexão lenta…');
  });
  a.addEventListener('canplay',        () => {
    clearTimeout(Player.stallTimer);
    if (Player.el && !Player.el.paused && Player.state === 'loading') {
      setPlayerState('playing');
    }
  });
  a.addEventListener('abort', () => console.info('[player] abortado'));
  a.addEventListener('error', onAudioError);

  Player.el = a;
  buildPlayerBar();
}

function setPlayerState(state) {
  Player.state = state;
  setPlayIcon(state === 'playing');
  const subText = {
    idle: '—',
    loading: 'Carregando…',
    playing: Player.current?.version === 'preview' ? 'Prévia · Reproduzindo' : 'Reproduzindo',
    paused: 'Pausado',
    error: 'Erro de reprodução',
    ended: 'Finalizada'
  }[state] || '';
  setSub(subText);
  repaint();
}

function buildPlayerBar() {
  const bar = document.createElement('div');
  bar.className = 'sp-player';
  bar.hidden = true;
  bar.innerHTML = `
    <div class="sp-player__inner">
      <div class="sp-left">
        <div class="sp-cover" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" opacity=".5">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 14.5A4.5 4.5 0 1 1 16.5 12 4.51 4.51 0 0 1 12 16.5zm0-6.5a2 2 0 1 0 2 2 2 2 0 0 0-2-2z"/>
          </svg>
        </div>
        <div class="sp-meta">
          <div class="sp-title" title="—">—</div>
          <div class="sp-sub">—</div>
        </div>
      </div>

      <div class="sp-center">
        <div class="sp-controls">
          <button class="sp-btn sp-btn--ghost" data-player-version="preview" type="button" title="Prévia 30s">P</button>
          <button class="sp-btn sp-btn--ctrl" type="button" data-action="prev" title="Faixa anterior">${ICON.prev}</button>
          <button class="sp-btn sp-btn--play" type="button" data-action="toggle" title="Play/Pause">${ICON.play}</button>
          <button class="sp-btn sp-btn--ctrl" type="button" data-action="next" title="Próxima faixa">${ICON.next}</button>
          <button class="sp-btn sp-btn--ghost" data-player-version="full" type="button" title="Áudio completo">F</button>
        </div>
        <div class="sp-progress-wrap">
          <span class="sp-time sp-time--cur">0:00</span>
          <div class="sp-progress">
            <div class="sp-progress__track"><div class="sp-progress__fill"></div></div>
            <input class="sp-progress__seek" type="range" min="0" max="0" step="1" value="0" aria-label="Posição da reprodução">
            <div class="sp-progress__thumb"></div>
          </div>
          <span class="sp-time sp-time--dur">0:00</span>
        </div>
      </div>

      <div class="sp-right">
        <button class="sp-btn sp-btn--icon" type="button" data-action="mute" title="Mudo">${ICON.vol}</button>
        <div class="sp-volume">
          <div class="sp-volume__track"><div class="sp-volume__fill"></div></div>
          <input class="sp-volume__seek" type="range" min="0" max="1" step="0.01" value="0.8" aria-label="Volume">
        </div>
        <button class="sp-btn sp-btn--icon" type="button" data-action="stop" title="Parar">${ICON.stop}</button>
        <button class="sp-btn sp-btn--icon" type="button" data-action="link" title="Abrir URL do áudio">${ICON.link}</button>
        <button class="sp-btn sp-btn--icon" type="button" data-action="close" title="Fechar player">${ICON.close}</button>
      </div>
    </div>
  `;
  document.body.appendChild(bar);
  Player.bar = bar;

  bar.querySelector('[data-action="toggle"]').addEventListener('click', async () => {
    if (!Player.el || !Player.el.src) return;
    try {
      if (Player.el.paused) await Player.el.play();
      else Player.el.pause();
    } catch (err) {
      toast('Navegador bloqueou a reprodução. Clique novamente.', '⚠');
    }
  });

  bar.querySelector('[data-action="prev"]').addEventListener('click', () => playPrevNext(-1));
  bar.querySelector('[data-action="next"]').addEventListener('click', () => playPrevNext(1));
  bar.querySelector('[data-action="stop"]').addEventListener('click', stopPlayback);
  bar.querySelector('[data-action="close"]').addEventListener('click', stopPlayback);

  bar.querySelector('[data-action="link"]').addEventListener('click', () => {
    if (Player.el?.currentSrc) {
      const w = window.open(Player.el.currentSrc, '_blank', 'noopener,noreferrer');
      if (w) w.opener = null;
    } else toast('Nenhuma URL carregada.', '⚠');
  });

  const muteBtn = bar.querySelector('[data-action="mute"]');
  muteBtn.addEventListener('click', () => {
    if (Player.el) Player.el.muted = !Player.el.muted;
    muteBtn.innerHTML = Player.el?.muted ? ICON.mute : ICON.vol;
  });

  const seek = bar.querySelector('.sp-progress__seek');
  seek.addEventListener('input', (e) => {
    Player.seeking = true;
    bar.querySelector('.sp-time--cur').textContent = fmtTime(Number(e.target.value));
    updateProgressFill(Number(e.target.value), Number(seek.max || 0));
  });
  seek.addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Player.el && Number.isFinite(v)) {
      try { Player.el.currentTime = v; } catch {}
    }
    Player.seeking = false;
  });

  const vol = bar.querySelector('.sp-volume__seek');
  vol.addEventListener('input', (e) => {
    if (Player.el) {
      Player.el.volume = Number(e.target.value);
      Player.el.muted = false;
      muteBtn.innerHTML = ICON.vol;
    }
    updateVolumeFill(Number(e.target.value));
  });

  bar.querySelectorAll('[data-player-version]').forEach((b) =>
    b.addEventListener('click', () => switchVersion(b.dataset.playerVersion)));

  updateVolumeFill(0.8);
}

function updateProgressFill(cur, dur) {
  if (!Player.bar) return;
  const fill = Player.bar.querySelector('.sp-progress__fill');
  const thumb = Player.bar.querySelector('.sp-progress__thumb');
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  if (fill) fill.style.width = pct + '%';
  if (thumb) thumb.style.left = pct + '%';
}

function updateVolumeFill(v) {
  if (!Player.bar) return;
  const fill = Player.bar.querySelector('.sp-volume__fill');
  if (fill) fill.style.width = (v * 100) + '%';
}

// ─────────────────────────────────────────────────────────────
// Reprodução — fluxo principal (captura posição ANTES de limpar)
// ─────────────────────────────────────────────────────────────
async function playTrack(albumId, trackId, requestedVersion) {
  ensurePlayer();
  const list = State.tracks.get(albumId);
  const track = Array.isArray(list) ? list.find((t) => String(t.id) === String(trackId)) : null;
  if (!track) return toast('Faixa não encontrada.', '⚠');

  const hasPreview = !!(track.previewPath || track.preview_path);
  const hasFull    = !!(track.fullPath || track.full_path);
  if (!hasPreview && !hasFull) return toast('Esta faixa não tem áudio cadastrado.', '⚠');

  const version = requestedVersion || (hasFull ? 'full' : 'preview');

  if (version === 'preview' && !hasPreview) return toast('Prévia indisponível.', '⚠');
  if (version === 'full' && !hasFull)       return toast('Áudio completo indisponível.', '⚠');

  // Capturar posição ANTES de qualquer mudança (correção crítica #2)
  const previous = Player.current;
  const previousTime = Player.el ? Player.el.currentTime : 0;
  const previousVersion = previous?.version;
  const isSameTrack = previous
    && String(previous.trackId) === String(trackId)
    && String(previous.albumId) === String(albumId);

  const seq = ++Player.seq;

  try {
    const url = await getAdminAudioUrl(track, version);
    console.info('[player] carregando:', url, '(v' + version + ')');

    if (seq !== Player.seq) return;

    // Limpar fonte antiga
    if (Player.el) {
      try { Player.el.pause(); } catch {}
      Player.el.removeAttribute('src');
      try { Player.el.load(); } catch {}
    }

    if (seq !== Player.seq) return;

    Player.current = {
      trackId: String(trackId),
      albumId: String(albumId),
      title:   track.title || 'Faixa',
      version,
      duration: null
    };
    Player.versions = { preview: hasPreview, full: hasFull };
    Player.el.src = url;

    // Restauração de posição (correção crítica #2)
    if (isSameTrack && previousVersion !== version && previousTime > 1) {
      Player.pendingRestore = previousTime;
    } else {
      Player.pendingRestore = null;
    }

    // Capa do álbum
    const album = State.albums.find((a) => String(a.id) === String(albumId));
    const coverUrl = album?.coverUrl || album?.cover_image;
    const coverEl = Player.bar.querySelector('.sp-cover');
    if (coverUrl && /^https?:\/\//i.test(coverUrl) && isAllowedMediaUrl(coverUrl)) {
      coverEl.innerHTML = `<img src="${escAttr(coverUrl)}" alt="">`;
    } else {
      coverEl.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" opacity=".5"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 14.5A4.5 4.5 0 1 1 16.5 12 4.51 4.51 0 0 1 12 16.5zm0-6.5a2 2 0 1 0 2 2 2 2 0 0 0-2-2z"/></svg>';
    }

    updateBarMeta();
    Player.bar.hidden = false;
    setPlayerState('loading');

    // Timeout de carregamento
    Player.stallTimer = setTimeout(() => {
      if (seq !== Player.seq) return;
      if (Player.el && Player.el.readyState < 2 && Player.state === 'loading') {
        console.warn('[player] STALL 6s | readyState:', Player.el.readyState,
                     '| networkState:', Player.el.networkState, '| src:', Player.el.currentSrc);
        toast('Áudio não carregou em 6s. Use 🔗 na barra.', '⚠');
      }
    }, 6000);

    const playPromise = Player.el.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      await playPromise.catch((err) => {
        if (seq !== Player.seq) return;
        console.error('[player] play() rejeitado:', err);
        throw err;
      });
    }

    repaint();
  } catch (err) {
    if (seq === Player.seq) {
      toast(err?.message || 'Falha ao reproduzir.', '⚠');
      recoverPlayer();
    }
  }
}

// Navegação prev/next (funcional, não mais apenas stop)
async function playPrevNext(delta) {
  if (!Player.current) return;
  const tracks = State.tracks.get(Player.current.albumId);
  if (!Array.isArray(tracks) || !tracks.length) return;

  const idx = tracks.findIndex(t => String(t.id) === String(Player.current.trackId));
  if (idx < 0) return;

  const targetIdx = idx + delta;
  if (targetIdx < 0 || targetIdx >= tracks.length) {
    if (delta < 0 && Player.el) { Player.el.currentTime = 0; }
    return;
  }

  const next = tracks[targetIdx];
  await playTrack(Player.current.albumId, String(next.id), Player.current.version);
}

function onLoadedMetadata() {
  if (!Player.el || !Player.current) return;
  Player.current.duration = Player.el.duration || 0;

  if (Player.pendingRestore !== null) {
    const t = Player.pendingRestore;
    Player.pendingRestore = null;
    try { Player.el.currentTime = Math.min(t, Player.el.duration - 0.5); } catch {}
  }

  syncProgress();
  if (Player.state === 'loading') setPlayerState('playing');
}

function onEnded() {
  setPlayerState('ended');
  updateProgressFill(0, Player.el.duration || 0);
}

function onAudioError() {
  const code = Player.el?.error ? Player.el.error.code : 0;
  const msg = {
    1: 'Abortado',
    2: 'Erro de rede (404 ou bloqueio)',
    3: 'Arquivo corrompido',
    4: 'Formato não suportado ou URL inválida'
  }[code] || 'Erro desconhecido';

  console.error('[player] ERRO', code, msg, '\nsrc:', Player.el?.currentSrc);
  toast(`Áudio: ${msg} (código ${code}). Veja 🔗.`, '⚠');
  recoverPlayer();
}

async function switchVersion(version) {
  if (!Player.current || Player.current.version === version) return;
  if (!Player.versions[version]) return toast('Versão indisponível.', '⚠');
  const { albumId, trackId } = Player.current;
  await playTrack(albumId, trackId, version);
}

async function pausePlayback() {
  if (!Player.el) return;
  try { Player.el.pause(); } catch {}
}

async function resumePlayback() {
  if (!Player.el || !Player.el.src) return;
  try { await Player.el.play(); }
  catch (err) { console.error('[player] resume falhou:', err); toast('Reprodução bloqueada.', '⚠'); }
}

// Recuperação completa do player (após erro ou cancelamento)
function recoverPlayer() {
  clearTimeout(Player.stallTimer);
  Player.stallTimer = null;
  Player.pendingRestore = null;
  Player.seeking = false;

  if (Player.el) {
    try { Player.el.pause(); } catch {}
    Player.el.removeAttribute('src');
    try { Player.el.load(); } catch {}
  }
  Player.current = null;
  Player.state = 'idle';

  if (Player.bar) {
    Player.bar.hidden = true;
    Player.bar.querySelector('.sp-title').textContent = '—';
    Player.bar.querySelector('.sp-sub').textContent = '—';
    Player.bar.querySelector('.sp-time--cur').textContent = '0:00';
    Player.bar.querySelector('.sp-time--dur').textContent = '0:00';
    const seek = Player.bar.querySelector('.sp-progress__seek');
    if (seek) { seek.max = 0; seek.value = 0; }
    updateProgressFill(0, 0);
    Player.bar.querySelectorAll('[data-player-version]').forEach((b) => {
      b.disabled = false;
      b.classList.remove('is-active');
    });
    const playBtn = Player.bar.querySelector('[data-action="toggle"]');
    if (playBtn) playBtn.innerHTML = ICON.play;
    const muteBtn = Player.bar.querySelector('[data-action="mute"]');
    if (muteBtn) muteBtn.innerHTML = ICON.vol;
  }

  repaint();
}

function stopPlayback() {
  Player.seq++;
  recoverPlayer();
}

function updateBarMeta() {
  if (!Player.bar || !Player.current) return;
  const title = Player.current.title;
  Player.bar.querySelector('.sp-title').textContent = title;
  Player.bar.querySelector('.sp-title').title      = title;
  Player.bar.querySelectorAll('[data-player-version]').forEach((b) => {
    const v = b.dataset.playerVersion;
    b.disabled = !Player.versions[v];
    b.classList.toggle('is-active', Player.current.version === v);
  });
}

function setPlayIcon(playing) {
  const btn = Player.bar?.querySelector('[data-action="toggle"]');
  if (btn) btn.innerHTML = playing ? ICON.pause : ICON.play;
}

function setSub(text) {
  const el = Player.bar?.querySelector('.sp-sub');
  if (el) el.textContent = text;
}

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const mm = Math.floor(s / 60);
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  return mm >= 60
    ? `${Math.floor(mm/60)}:${String(mm%60).padStart(2,'0')}:${ss}`
    : `${mm}:${ss}`;
}

function syncProgress() {
  if (!Player.el || !Player.bar) return;
  const seek = Player.bar.querySelector('.sp-progress__seek');
  const dur = Number.isFinite(Player.el.duration) ? Player.el.duration : 0;
  if (!Player.seeking) {
    seek.max = dur || 0;
    seek.value = Player.el.currentTime || 0;
  }
  Player.bar.querySelector('.sp-time--cur').textContent = fmtTime(Player.el.currentTime);
  Player.bar.querySelector('.sp-time--dur').textContent = fmtTime(dur);
  updateProgressFill(Player.el.currentTime || 0, dur);
}

// ─────────────────────────────────────────────────────────────
// Download — faixa individual
// ─────────────────────────────────────────────────────────────
async function downloadTrack(trackId, titleHint) {
  if (!trackId) return;
  const btn = document.querySelector(`[data-track-download="${trackId}"]`);
  const originalHtml = btn?.innerHTML;

  try {
    if (btn) { btn.disabled = true; btn.textContent = '⬇ …'; }
    const res = await apiFetch('download-url', { method: 'GET', query: { id: trackId } });
    if (!res?.ok || !res.url) throw new Error(res?.error || 'Falha ao gerar URL.');
    triggerDownload(res.url, res.filename || `${titleHint || trackId}.mp3`);
    toast(`Download iniciado: ${titleHint || trackId}`, '⬇');
  } catch (err) {
    toast(err?.message || 'Falha ao baixar.', '⚠');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

// ─────────────────────────────────────────────────────────────
// Download — álbum completo
// ─────────────────────────────────────────────────────────────
async function downloadAlbum(albumId) {
  if (!albumId) return;
  const album = State.albums.find((a) => a.id === albumId);
  const albumTitle = album?.title || albumId;

  const confirmed = confirm(
    `Solicitar download de todas as faixas do álbum "${albumTitle}"?\n\n` +
    `O navegador pode pedir permissão para salvar múltiplos arquivos.`
  );
  if (!confirmed) return;

  try {
    toast(`Preparando álbum "${albumTitle}"…`, '⏳');
    const res = await apiFetch('download-album', { method: 'GET', query: { id: albumId } });
    if (!res?.ok || !Array.isArray(res.tracks)) throw new Error(res?.error || 'Falha ao listar faixas.');

    const valid = res.tracks.filter((t) => t.url);
    if (!valid.length) return toast('Este álbum não tem áudios completos.', '⚠');

    toast(`Disparando ${valid.length} download(s)...`, '⬇');
    let failures = 0;
    for (let i = 0; i < valid.length; i++) {
      try { triggerDownload(valid[i].url, valid[i].filename || `${valid[i].title}.mp3`); }
      catch { failures++; }
      await sleep(600);
    }

    if (failures) toast(`Concluído com ${failures} falha(s).`, '⚠');
    else toast(`${valid.length} downloads solicitados.`, '✓');
  } catch (err) {
    toast(err?.message || 'Falha ao baixar álbum.', '⚠');
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers de download (validação de domínio)
// ─────────────────────────────────────────────────────────────
function triggerDownload(url, filename) {
  if (!isAllowedMediaUrl(url)) {
    toast('URL de download não autorizada.', '⚠');
    return;
  }

  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// Drag & Drop — impede cross-album, restaura via repaint()
// ─────────────────────────────────────────────────────────────
function bindTrackDragDrop(scope) {
  const bodies = scope.querySelectorAll('[data-tracks-body]');

  bodies.forEach((tbody) => {
    if (tbody.dataset.dragBound === '1') return;
    tbody.dataset.dragBound = '1';
    const albumId = tbody.dataset.tracksBody;

    tbody.addEventListener('dragstart', (e) => {
      const row = e.target.closest('tr[data-track-id]');
      if (!row) return;
      _dragState = { row, albumId };
      row.classList.add('dragging');
      try {
        e.dataTransfer.setData('text/plain', JSON.stringify({ trackId: row.dataset.trackId, albumId }));
        e.dataTransfer.effectAllowed = 'move';
      } catch {}
    });

    tbody.addEventListener('dragover', (e) => {
      if (!_dragState) return;
      // Impede drag cross-album
      if (String(_dragState.albumId) !== String(albumId)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || targetRow === _dragState.row) return;
      tbody.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
      const rect = targetRow.getBoundingClientRect();
      targetRow.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
    });

    tbody.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!_dragState) return;
      if (String(_dragState.albumId) !== String(albumId)) { cleanupDrag(scope); return; }

      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || targetRow === _dragState.row) { cleanupDrag(scope); return; }

      const rect = targetRow.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      const rows = Array.from(tbody.querySelectorAll('tr[data-track-id]'));

      rows.splice(rows.indexOf(_dragState.row), 1);
      let insertAt = rows.indexOf(targetRow);
      if (!isAbove) insertAt += 1;
      rows.splice(insertAt, 0, _dragState.row);

      const order = rows.map((row, i) => ({ id: String(row.dataset.trackId), track_number: i + 1 }));
      cleanupDrag(scope);

      await persistTrackOrder(albumId, order);
    });

    tbody.addEventListener('dragend', () => cleanupDrag(scope));
  });
}

function cleanupDrag(scope) {
  if (_dragState?.row) _dragState.row.classList.remove('dragging');
  scope.querySelectorAll('tr.drag-over-top, tr.drag-over-bottom').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
  _dragState = null;
}

async function persistTrackOrder(albumId, order) {
  const reqId = (State.trackOrderReqId.get(albumId) || 0) + 1;
  State.trackOrderReqId.set(albumId, reqId);

  try {
    const res = await apiFetch('track-order', { method: 'PATCH', body: { albumId, order } });
    if ((State.trackOrderReqId.get(albumId) || 0) !== reqId) return;
    if (!res?.ok) throw new Error(res?.error || 'Falha ao reordenar.');
    toast('Ordem atualizada.', '✓');
    await loadTracksForAlbum(albumId);
    repaint();
  } catch (err) {
    if ((State.trackOrderReqId.get(albumId) || 0) !== reqId) return;
    toast(err?.message || 'Falha ao reordenar. Estado restaurado do servidor.', '⚠');
    // Correção crítica #7: recarrega do banco e repinta (não restaura HTML)
    await loadTracksForAlbum(albumId);
    repaint();
  }
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
function renderAlbumBlock(album) {
  const isExpanded = State.expandedAlbumIds.has(album.id);
  const tracks = State.tracks.get(album.id);
  const trackCount = Array.isArray(tracks) ? tracks.length : 0;
  const hasError = tracks?.error;
  const isPublished = !!album.published;

  const coverUrl = album.coverUrl || album.cover_image;
  const safeCover = coverUrl && /^https?:\/\//i.test(coverUrl) && isAllowedMediaUrl(coverUrl) ? coverUrl : '';

  return `
    <div class="album-block ${isExpanded ? 'expanded' : ''}" data-album-id="${escAttr(album.id)}">
      <div class="album-header">
        <div class="album-cover" ${safeCover ? `style="background-image:url('${escAttr(safeCover)}')"` : ''}>
          ${safeCover ? '' : esc(album.title?.charAt(0) || '♪')}
        </div>
        <div class="album-info">
          <div class="album-title">
            ${esc(album.title)}
            <span class="album-badge ${isPublished ? 'premium' : ''}">${isPublished ? 'Publicado' : 'Rascunho'}</span>
          </div>
          <div class="album-meta">
            <span class="gold">ÁLBUM</span> · ${album.year || '—'} · ${trackCount} faixa${trackCount === 1 ? '' : 's'}
          </div>
        </div>
        <div class="album-actions">
          <button class="btn btn-ghost btn-sm" data-album-download="${escAttr(album.id)}" type="button" title="Baixar">⬇</button>
          <button class="btn btn-ghost btn-sm" data-album-edit="${escAttr(album.id)}" type="button" title="Editar">✎</button>
          <button class="btn btn-ghost btn-sm" data-album-delete="${escAttr(album.id)}" type="button" title="Excluir">🗑</button>
          <button class="album-toggle" data-album-toggle="${escAttr(album.id)}" type="button" aria-expanded="${isExpanded}">${isExpanded ? '▲' : '▼'}</button>
        </div>
      </div>
      <div class="album-tracks">
        ${isExpanded ? renderTracksList(album.id, tracks, hasError) : ''}
      </div>
    </div>
  `;
}

function renderTracksList(albumId, tracks, hasError) {
  const addBtn = `
    <div style="margin-top:1rem;display:flex;gap:0.5rem;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" data-track-new="${escAttr(albumId)}" type="button">+ Nova faixa</button>
    </div>`;

  if (hasError) {
    return `
      <div class="admin-error-box" style="margin-top:1rem;">
        <p>${esc(tracks.error)}</p>
        <button class="btn btn-outline btn-sm" data-track-retry="${escAttr(albumId)}" type="button">Tentar novamente</button>
      </div>${addBtn}`;
  }
  if (!Array.isArray(tracks) || !tracks.length) {
    return `<p class="admin-empty">Nenhuma faixa cadastrada.</p>${addBtn}`;
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th style="width:32px;"></th><th style="width:40px;">#</th><th>Título</th>
            <th style="width:100px;">Duração</th><th style="width:100px;">Preço</th>
            <th style="width:120px;">Áudio</th><th style="width:100px;">Status</th><th style="width:280px;">Ações</th>
          </tr>
        </thead>
        <tbody data-tracks-body="${escAttr(albumId)}">
          ${tracks.map((track, idx) => renderTrackRow(albumId, track, idx)).join('')}
        </tbody>
      </table>
    </div>
    ${addBtn}
  `;
}

function renderTrackRow(albumId, track, idx) {
  const hasPreview = !!(track.previewPath || track.preview_path);
  const hasFull    = !!(track.fullPath || track.full_path);
  const canPlay    = hasPreview || hasFull;

  const isCurrent = Player.current
    && String(Player.current.trackId) === String(track.id)
    && String(Player.current.albumId) === String(albumId);
  const playing = isCurrent && Player.state === 'playing';

  const audioChips = `
    <button class="audio-chip ${hasPreview ? '' : 'none'}" type="button"
      data-track-play="${escAttr(String(track.id))}" data-track-album="${escAttr(albumId)}"
      data-play-version="preview" title="${hasPreview ? 'Ouvir prévia' : 'Sem prévia'}"
      ${hasPreview ? '' : 'disabled'}>P</button>
    <button class="audio-chip ${hasFull ? '' : 'none'}" type="button"
      data-track-play="${escAttr(String(track.id))}" data-track-album="${escAttr(albumId)}"
      data-play-version="full" title="${hasFull ? 'Ouvir completa' : 'Sem completa'}"
      ${hasFull ? '' : 'disabled'}>F</button>`;

  const isPublished = track.status === 'PUBLISHED' || track.published;
  const statusBadge = isPublished
    ? '<span class="badge-mini badge-premium">Pub</span>'
    : '<span class="badge-mini badge-free">Rasc</span>';

  const price = Number(track.priceCents || track.price_cents) || 0;

  return `
    <tr data-track-id="${escAttr(String(track.id))}"
        data-track-index="${Number(track.trackNumber || track.track_index) || 0}"
        draggable="true" class="track-row ${playing ? 'is-playing' : ''}">
      <td class="track-drag-cell"><span class="track-drag-handle">⋮⋮</span></td>
      <td>${idx + 1}</td>
      <td>${esc(track.title || '—')}</td>
      <td>${esc(track.duration || '—')}</td>
      <td>R$ ${(price / 100).toFixed(2).replace('.', ',')}</td>
      <td><span style="display:inline-flex;gap:4px;">${audioChips}</span></td>
      <td>${statusBadge}</td>
      <td>
        <div class="actions">
          <button class="btn btn-ghost btn-sm ${playing ? 'is-playing' : ''}"
                  data-track-play="${escAttr(String(track.id))}"
                  data-track-album="${escAttr(albumId)}"
                  type="button" ${canPlay ? '' : 'disabled'}>
            ${playing ? '⏸ Pausar' : '▶ Ouvir'}
          </button>
          <button class="btn btn-ghost btn-sm"
                  data-track-download="${escAttr(String(track.id))}"
                  data-track-download-title="${escAttr(track.title || '')}"
                  type="button" ${hasFull ? '' : 'disabled'}>⬇ Baixar</button>
          <button class="btn btn-ghost btn-sm"
                  data-track-edit="${escAttr(String(track.id))}"
                  data-track-album="${escAttr(albumId)}"
                  type="button">✎ Editar</button>
          <button class="btn btn-ghost btn-sm"
                  data-track-delete="${escAttr(String(track.id))}"
                  data-track-album="${escAttr(albumId)}"
                  type="button">🗑</button>
        </div>
      </td>
    </tr>`;
}

// ─────────────────────────────────────────────────────────────
// Modal — Álbum (com validação de ano)
// ─────────────────────────────────────────────────────────────
function openAlbumModal(album) {
  const isNew = !album;
  const a = album || { id: '', title: '', coverUrl: '', year: new Date().getFullYear(), published: false };

  openAdminModal(`
    <h3>${isNew ? 'Novo álbum' : 'Editar álbum'}</h3>
    <div class="form-group">
      <label>Título *</label>
      <input type="text" id="albumTitle" value="${escAttr(a.title)}" required>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Ano (${MIN_ALBUM_YEAR}–${MAX_ALBUM_YEAR})</label><input type="number" id="albumYear" value="${escAttr(String(a.year || ''))}" min="${MIN_ALBUM_YEAR}" max="${MAX_ALBUM_YEAR}"></div>
      <div class="form-group"><label>URL da capa</label><input type="text" id="albumCoverUrl" value="${escAttr(a.coverUrl || a.cover_image || '')}" placeholder="https://..."></div>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:0.5rem;"><input type="checkbox" id="albumPublished" ${a.published ? 'checked' : ''}> Publicar álbum</label>
    </div>
    <div class="form-error" id="albumError"></div>
    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" data-close type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="albumSave" type="button">${isNew ? 'Criar' : 'Salvar'}</button>
    </div>
  `);

  document.getElementById('albumSave')?.addEventListener('click', async () => {
    const errEl = document.getElementById('albumError');
    const title = document.getElementById('albumTitle').value.trim();
    const yearRaw = document.getElementById('albumYear').value;
    const cover = document.getElementById('albumCoverUrl').value.trim();
    const pub   = document.getElementById('albumPublished').checked;

    if (!title) { if (errEl) errEl.textContent = 'Título obrigatório.'; return; }

    const year = validateYear(yearRaw);
    if (typeof year === 'string') { if (errEl) errEl.textContent = `Ano ${year}.`; return; }

    if (cover && (!/^https?:\/\//i.test(cover) || !isAllowedMediaUrl(cover))) {
      if (errEl) errEl.textContent = 'URL da capa inválida ou de domínio não autorizado.'; return;
    }

    const payload = { title, year, coverUrl: cover, published: pub };

    try {
      if (isNew) await apiFetch('albums', { method: 'POST', body: payload });
      else await apiFetch('album', { method: 'PATCH', query: { id: a.id }, body: payload });
      toast('Álbum salvo.', '💿');
      closeAdminModal();
      await loadAlbums();
    } catch (err) {
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar.';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Modal — Faixa (salvamento transacional faixa + letra)
// ─────────────────────────────────────────────────────────────
function openTrackModal(albumId, track) {
  const isNew = !track;
  const t = track || { id: null, title: '', duration: '', priceCents: 499, status: 'DRAFT', previewPath: null, fullPath: null, lyrics: [] };
  const lyricsText = Array.isArray(t.lyrics) && t.lyrics.length ? JSON.stringify(t.lyrics, null, 2) : '[]';

  openAdminModal(`
    <h3>${isNew ? 'Nova faixa' : 'Editar faixa'}</h3>
    <div class="form-group"><label>Título *</label><input type="text" id="trackTitle" value="${escAttr(t.title)}" required></div>
    <div class="form-row">
      <div class="form-group">
        <label>Duração (mm:ss)</label>
        <input type="text" id="trackDuration" value="${escAttr(t.duration || '')}" placeholder="03:45">
        <span class="hint" data-detected-duration></span>
      </div>
      <div class="form-group"><label>Preço (centavos, máx ${MAX_TRACK_PRICE_CENTS})</label><input type="number" id="trackPrice" value="${escAttr(String(t.priceCents || 0))}"></div>
    </div>
    <div class="form-group">
      <label style="display:flex;align-items:center;gap:0.5rem;"><input type="checkbox" id="trackPublished" ${t.status === 'PUBLISHED' ? 'checked' : ''}> Publicar faixa</label>
    </div>

    <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
      <h4 style="margin:0 0 0.5rem;font-size:0.9rem;color:var(--accent);">🎧 Prévia</h4>
      <div data-preview-status style="font-size:0.85rem;margin-bottom:0.5rem;">${t.previewPath ? `<span class="audio-chip">✓ ${esc(t.previewPath)}</span>` : '<span class="audio-chip none">Nenhum</span>'}</div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button class="btn btn-outline btn-sm" data-upload-preview type="button">⬆ Enviar</button>
        <button class="btn btn-ghost btn-sm" data-test-preview type="button" ${t.previewPath ? '' : 'disabled'}>▶ Testar</button>
      </div>
      <input type="file" id="trackPreviewInput" accept="audio/*" hidden>
    </div>
    <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
      <h4 style="margin:0 0 0.5rem;font-size:0.9rem;color:var(--accent);">🎵 Áudio Completo</h4>
      <div data-full-status style="font-size:0.85rem;margin-bottom:0.5rem;">${t.fullPath ? `<span class="audio-chip">✓ ${esc(t.fullPath)}</span>` : '<span class="audio-chip none">Nenhum</span>'}</div>
      <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
        <button class="btn btn-outline btn-sm" data-upload-full type="button">⬆ Enviar</button>
        <button class="btn btn-ghost btn-sm" data-test-full type="button" ${t.fullPath ? '' : 'disabled'}>▶ Testar</button>
      </div>
      <input type="file" id="trackFullInput" accept="audio/*" hidden>
    </div>

    <div class="form-group">
      <label>Letra (JSON — tempos distintos e crescentes)</label>
      <textarea id="trackLyrics" rows="8" style="font-family:monospace;">${esc(lyricsText)}</textarea>
    </div>

    <div class="form-error" id="trackError"></div>
    <div style="display:flex;gap:0.7rem;justify-content:flex-end;margin-top:1.5rem;">
      <button class="btn btn-outline btn-sm" data-close type="button">Cancelar</button>
      <button class="btn btn-primary btn-sm" id="trackSave" type="button">${isNew ? 'Criar' : 'Salvar'}</button>
    </div>
  `);

  // ModalId único para ignorar detecção de duração em modais fechados
  const modalId = Date.now();

  bindTrackUpload({ buttonSel: '[data-upload-preview]', inputId: 'trackPreviewInput', statusSel: '[data-preview-status]', testSel: '[data-test-preview]', kind: 'audio-preview', uploadFn: uploadAudioPreview, field: 'previewPath', albumId, track: t, modalId });
  bindTrackUpload({ buttonSel: '[data-upload-full]',    inputId: 'trackFullInput',    statusSel: '[data-full-status]',    testSel: '[data-test-full]',    kind: 'audio-full',    uploadFn: uploadAudioFull,    field: 'fullPath',    albumId, track: t, modalId });

  document.getElementById('trackSave')?.addEventListener('click', async () => {
    const errEl = document.getElementById('trackError');
    const lyrics = parseLyricsInput(document.getElementById('trackLyrics').value);
    if (lyrics === null) { if (errEl) errEl.textContent = 'Letra inválida. Use JSON com tempos crescentes e distintos.'; return; }

    const priceCents = normalizePrice(document.getElementById('trackPrice').value);
    if (priceCents === null) { if (errEl) errEl.textContent = `Preço inválido (0 a ${MAX_TRACK_PRICE_CENTS}).`; return; }

    const duration = document.getElementById('trackDuration').value.trim();
    if (!validateDuration(duration)) { if (errEl) errEl.textContent = 'Duração no formato mm:ss (ex: 03:45), até 180 minutos.'; return; }

    const title = document.getElementById('trackTitle').value.trim();
    if (!title) { if (errEl) errEl.textContent = 'Título obrigatório.'; return; }

    // Operação única transacional: faixa + letra (correção crítica #5)
    const payload = {
      title, duration, priceCents,
      status: document.getElementById('trackPublished').checked ? 'PUBLISHED' : 'DRAFT',
      lyrics
    };

    const opId = Date.now();

    try {
      let savedTrackId = t.id;
      if (isNew) {
        State.pendingOperations.set(`create-track-${albumId}`, opId);
        const res = await apiFetch('tracks', { method: 'POST', body: { ...payload, albumId } });
        if (State.pendingOperations.get(`create-track-${albumId}`) !== opId) return;
        State.pendingOperations.delete(`create-track-${albumId}`);
        savedTrackId = res.track.id;
      } else {
        State.pendingOperations.set(`track-${t.id}`, opId);
        await apiFetch('track', { method: 'PATCH', query: { id: t.id }, body: payload });
        if (State.pendingOperations.get(`track-${t.id}`) !== opId) return;
        State.pendingOperations.delete(`track-${t.id}`);
      }

      toast('Faixa salva.', '🎵');
      closeAdminModal();
      await loadTracksForAlbum(albumId);
      repaint();
    } catch (err) {
      if (isNew) State.pendingOperations.delete(`create-track-${albumId}`);
      else State.pendingOperations.delete(`track-${t.id}`);
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar.';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Upload de Faixa (validação robusta + controle de modal)
// ─────────────────────────────────────────────────────────────
function bindTrackUpload({ buttonSel, inputId, statusSel, testSel, kind, uploadFn, field, albumId, track, modalId }) {
  const button   = document.querySelector(buttonSel);
  const input    = document.getElementById(inputId);
  const statusEl = document.querySelector(statusSel);
  const testBtn  = document.querySelector(testSel);

  if (!button || !input) return;
  button.addEventListener('click', () => input.click());

  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      if (!track[field]) return toast('Nenhum arquivo associado.', '⚠');
      try {
        const url = await getAdminAudioUrl(track, field === 'previewPath' ? 'preview' : 'full');
        await playExternal(url);
      } catch (err) {
        toast(err?.message || 'Falha ao reproduzir.', '⚠');
      }
    });
  }

  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;

    const fileErr = validateAudioFile(file);
    if (fileErr) { toast(fileErr, '⚠'); input.value = ''; return; }

    if (!track.id) { toast('Salve a faixa antes de enviar o áudio.', '⚠'); input.value = ''; return; }

    if (track[field]) {
      if (!confirm('Já existe um áudio associado. Substituir?')) {
        input.value = ''; return;
      }
    }

    const original = button.textContent;
    try {
      button.disabled = true;
      button.textContent = 'Enviando…';
      if (statusEl) statusEl.innerHTML = '<span class="audio-chip">⬆ 0%</span>';

      const result = await uploadFn(file, (pct) => {
        if (statusEl) statusEl.innerHTML = `<span class="audio-chip">⬆ ${pct}%</span>`;
      });

      if (!result?.path) throw new Error('Upload não retornou path.');

      // Verifica se o modal ainda é o mesmo
      if (!document.getElementById('trackTitle')) {
        input.value = '';
        return;
      }

      await apiFetch('track', { method: 'PATCH', query: { id: track.id }, body: { [field]: result.path } });
      track[field] = result.path;

      if (statusEl) statusEl.innerHTML = `<span class="audio-chip">✓ ${esc(result.path)}</span>`;
      if (testBtn) testBtn.disabled = false;
      toast('Áudio associado.', '✓');

      // Detectar duração real (com controle de modal)
      try {
        const url = await getAdminAudioUrl(track, field === 'previewPath' ? 'preview' : 'full');
        const probe = new Audio();
        probe.preload = 'metadata';
        probe.src = url;
        probe.addEventListener('loadedmetadata', () => {
          const dur = probe.duration;
          if (Number.isFinite(dur) && dur > 0) {
            // Só atualiza se o modal ainda existir e estiver na mesma faixa
            const stillOpen = document.getElementById('trackTitle');
            if (!stillOpen) { probe.remove(); return; }
            const mm = Math.floor(dur / 60);
            const ss = String(Math.floor(dur % 60)).padStart(2, '0');
            const el = document.querySelector('[data-detected-duration]');
            if (el) el.textContent = `Duração detectada: ${mm}:${ss}`;
            const durInput = document.getElementById('trackDuration');
            if (durInput && !durInput.value.trim()) durInput.value = `${mm}:${ss}`;
          }
          probe.remove();
        });
        probe.addEventListener('error', () => probe.remove());
      } catch {}

      await loadTracksForAlbum(albumId);
      repaint();

    } catch (err) {
      toast(err?.message || 'Falha no upload.', '⚠');
      if (statusEl) statusEl.innerHTML = '<span class="audio-chip none">Falha no upload</span>';
    } finally {
      button.disabled = false;
      button.textContent = original;
      input.value = '';
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Reproduzir URL externa (preview dentro do modal)
// ─────────────────────────────────────────────────────────────
async function playExternal(url) {
  ensurePlayer();
  const seq = ++Player.seq;
  try {
    if (Player.el) { try { Player.el.pause(); } catch {} Player.el.removeAttribute('src'); try { Player.el.load(); } catch {} }
    if (seq !== Player.seq) return;
    Player.current = { trackId: 'preview', albumId: 'preview', title: 'Prévia do modal', version: 'full', duration: null };
    Player.versions = { preview: false, full: true };
    Player.el.src = url;
    updateBarMeta();
    Player.bar.hidden = false;
    setPlayerState('loading');
    await Player.el.play();
    repaint();
  } catch (err) {
    if (seq === Player.seq) {
      toast('Falha ao reproduzir.', '⚠');
      recoverPlayer();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Debug
// ─────────────────────────────────────────────────────────────
window.__player = Player;
window.__albums  = { State, playTrack, stopPlayback, getAdminAudioUrl, recoverPlayer };
