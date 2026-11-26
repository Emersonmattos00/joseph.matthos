/* ============================================================
   js/admin/editors/albums.js — v10.2 (Audit-Ready)
   ============================================================
   v10 + auditoria completa:
   1. Validação de domínio robusta (subdomínio legítimo)
   2. Sem fallback para URL assinada sem type
   3. Validação de assinatura mágica de áudio (byte headers)
   4. Eventos do áudio filtrados por sequência ativa
   5. opId monotônico (não Date.now)
   6. Drag & drop serializado por álbum + validação
   7. Player fecha ao fechar modal de teste
   8. Prev/next com comportamento explícito
   9. Capa em <img> (não background-image)
   10. Hints para backend em operações não-transacionais
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
let _opCounter = 0;
const _trackOrderQueue = new Map(); // albumId -> Promise chain

function nextOpId() {
  return `op-${++_opCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────
// Player singleton
// ─────────────────────────────────────────────────────────────
const Player = {
  el: null,
  bar: null,
  current: null,
  versions: { preview: false, full: false },
  seq: 0,
  _activeSeq: 0, // filtra eventos de operações antigas
  seeking: false,
  stallTimer: null,
  pendingRestore: null,
  state: 'idle' // idle | loading | playing | paused | error | ended
};

// ─────────────────────────────────────────────────────────────
// Ícones SVG (Spotify)
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

// Validação robusta de domínio (subdomínio legítimo ou exato)
function isAllowedMediaUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_MEDIA_HOSTS.some(host =>
      u.hostname === host || u.hostname.endsWith(`.${host}`)
    );
  } catch { return false; }
}

// Comparação de bytes (helper para assinatura mágica)
function bytesEq(arr, off, seq) {
  for (let i = 0; i < seq.length; i++) {
    if (arr[off + i] !== seq[i]) return false;
  }
  return true;
}

function validateDuration(str) {
  if (!str || typeof str !== 'string' || !str.trim()) return true;
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(str.trim());
  if (!m) return false;
  const mm = Number(m[1]);
  return mm <= 180;
}

// Validação robusta de arquivo: extensão + MIME + tamanho + assinatura mágica
async function validateAudioFile(file) {
  if (!file) return 'Selecione um arquivo.';
  if (file.size === 0) return 'Arquivo vazio.';
  if (file.size > MAX_AUDIO_FILE_SIZE) {
    return `Arquivo muito grande (${(file.size / 1048576).toFixed(1)} MB, máx ${MAX_AUDIO_FILE_SIZE / 1048576} MB).`;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!ALLOWED_AUDIO_EXTS.includes(ext)) {
    return `Extensão .${ext} não suportada. Use: ${ALLOWED_AUDIO_EXTS.join(', ')}.`;
  }
  if (file.type && !ALLOWED_AUDIO_TYPES.includes(file.type) && !file.type.startsWith('audio/')) {
    return `Tipo de arquivo inválido: ${file.type}.`;
  }

  // Assinatura mágica (primeiros 12 bytes)
  try {
    const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const sigs = {
      mp3:  () => (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) || bytesEq(header, 0, [0x49, 0x44, 0x33]),
      m4a:  () => bytesEq(header, 4, [0x66, 0x74, 0x79, 0x70]),
      ogg:  () => bytesEq(header, 0, [0x4F, 0x67, 0x67, 0x53]),
      flac: () => bytesEq(header, 0, [0x66, 0x4C, 0x61, 0x43]),
      wav:  () => bytesEq(header, 0, [0x52, 0x49, 0x46, 0x46]) && bytesEq(header, 8, [0x57, 0x41, 0x56, 0x45]),
      webm: () => bytesEq(header, 0, [0x1A, 0x45, 0xDF, 0xA3])
    };
    const extSig = sigs[ext];
    if (extSig && !extSig()) {
      return `O conteúdo do arquivo .${ext} não corresponde à assinatura esperada.`;
    }
  } catch (e) {
    console.warn('[upload] não foi possível ler header:', e);
    // Backend fará validação definitiva
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

// parseLyricsInput — ordem estrita (tempos distintos e crescentes)
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
    if (!Number.isFinite(time) || time < 0 || !text || time <= previousTime) return null;
    previousTime = time;
    result.push({ time, text });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
// Resolver URL de áudio
// Preview: pública. Full: URL assinada (sem fallback).
// ─────────────────────────────────────────────────────────────
async function getAdminAudioUrl(track, version) {
  const pathField = version === 'preview'
    ? (track.previewPath || track.preview_path)
    : (track.fullPath || track.full_path);

  if (!pathField) {
    throw new Error(version === 'preview' ? 'Prévia não cadastrada.' : 'Áudio completo não cadastrado.');
  }

  if (version === 'preview') {
    if (/^https?:\/\//i.test(pathField)) {
      if (!isAllowedMediaUrl(pathField)) throw new Error('Domínio da prévia não autorizado.');
      return pathField;
    }
    const normalized = pathField.replace(/^\/+/, '');
    const url = `${R2_PUBLIC_BASE}/${normalized}`;
    if (!isAllowedMediaUrl(url)) throw new Error('URL de prévia inválida.');
    return url;
  }

  // Full: URL assinada obrigatória (sem fallback)
  const res = await apiFetch('download-url', {
    method: 'GET',
    query: { id: String(track.id), type: 'full' }
  });
  if (!res?.ok || !res.url) {
    throw new Error(res?.error || 'Áudio completo indisponível. Verifique o bucket privado.');
  }
  if (!isAllowedMediaUrl(res.url)) {
    throw new Error('URL assinada de domínio não autorizado.');
  }
  return res.url;
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
// Bind — botões de álbum
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

      const opId = nextOpId();
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
// Bind — botões de faixa (P/F verificam versão atual)
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
        if (requestedVersion && requestedVersion !== currentVersion) {
          await switchVersion(requestedVersion);
          return;
        }
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

      const opId = nextOpId();
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
// Helper: verifica se evento pertence à seq ativa
// ─────────────────────────────────────────────────────────────
function isSeqCurrent() { return Player._activeSeq === Player.seq; }

// ─────────────────────────────────────────────────────────────
// Player — construção (eventos atrelados à seq ativa)
// ─────────────────────────────────────────────────────────────
function ensurePlayer() {
  if (Player.el) return;

  const a = new Audio();
  a.preload = 'auto';

  a.addEventListener('timeupdate',     () => { if (!isSeqCurrent()) return; syncProgress(); });
  a.addEventListener('loadedmetadata', () => { if (!isSeqCurrent()) return; onLoadedMetadata(); });
  a.addEventListener('durationchange', () => { if (!isSeqCurrent()) return; syncProgress(); });
  a.addEventListener('play',           () => { if (!isSeqCurrent()) return; setPlayerState('playing'); });
  a.addEventListener('pause',          () => {
    if (!isSeqCurrent()) return;
    if (Player.state === 'playing') setPlayerState('paused');
  });
  a.addEventListener('ended',          () => { if (!isSeqCurrent()) return; onEnded(); });
  a.addEventListener('waiting',        () => { if (!isSeqCurrent()) return; setPlayerState('loading'); });
  a.addEventListener('stalled',        () => {
    if (!isSeqCurrent()) return;
    console.warn('[player] stalled em', a.currentSrc);
    setSub('Conexão lenta…');
  });
  a.addEventListener('canplay',        () => {
    if (!isSeqCurrent()) return;
    clearTimeout(Player.stallTimer);
    if (Player.el && !Player.el.paused && Player.state === 'loading') setPlayerState('playing');
  });
  a.addEventListener('abort', () => console.info('[player] abortado'));
  a.addEventListener('error', () => { if (!isSeqCurrent()) return; onAudioError(); });

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
// Reprodução — captura posição ANTES de limpar
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

  const previous = Player.current;
  const previousTime = Player.el ? Player.el.currentTime : 0;
  const previousVersion = previous?.version;
  const isSameTrack = previous
    && String(previous.trackId) === String(trackId)
    && String(previous.albumId) === String(albumId);

  const seq = ++Player.seq;
  Player._activeSeq = seq;

  try {
    const url = await getAdminAudioUrl(track, version);
    console.info('[player] carregando:', url, '(v' + version + ')');

    if (seq !== Player.seq) return;

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

    if (isSameTrack && previousVersion !== version && previousTime > 1) {
      Player.pendingRestore = previousTime;
    } else {
      Player.pendingRestore = null;
    }

    // Capa em <img> (correção #9)
    const album = State.albums.find((a) => String(a.id) === String(albumId));
    const coverUrl = album?.coverUrl || album?.cover_image;
    const coverEl = Player.bar.querySelector('.sp-cover');
    if (coverUrl && /^https?:\/\//i.test(coverUrl) && isAllowedMediaUrl(coverUrl)) {
      coverEl.innerHTML = `<img src="${escAttr(coverUrl)}" alt="Capa de ${escAttr(album?.title || 'faixa')}">`;
    } else {
      coverEl.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" opacity=".5"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 14.5A4.5 4.5 0 1 1 16.5 12 4.51 4.51 0 0 1 12 16.5zm0-6.5a2 2 0 1 0 2 2 2 2 0 0 0-2-2z"/></svg>';
    }

    updateBarMeta();
    Player.bar.hidden = false;
    setPlayerState('loading');

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

// Navegação prev/next — comportamento explícito (correção #8)
async function playPrevNext(delta) {
  if (!Player.current) return;
  const tracks = State.tracks.get(Player.current.albumId);
  if (!Array.isArray(tracks) || !tracks.length) return;

  const idx = tracks.findIndex(t => String(t.id) === String(Player.current.trackId));
  if (idx < 0) return;

  const targetIdx = idx + delta;

  if (targetIdx < 0) {
    // Primeira faixa → reinicia
    if (Player.el) Player.el.currentTime = 0;
    return;
  }
  if (targetIdx >= tracks.length) {
    // Última faixa → deixa tocar até o fim
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

// Recuperação completa (correção #4 — limpa tudo)
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
    const prevBtn = Player.bar.querySelector('[data-action="prev"]');
    const nextBtn = Player.bar.querySelector('[data-action="next"]');
    if (prevBtn) prevBtn.disabled = false;
    if (nextBtn) nextBtn.disabled = false;
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

  // Desabilita prev na primeira, next na última
  const tracks = State.tracks.get(Player.current.albumId);
  const list = Array.isArray(tracks) ? tracks : [];
  const idx = list.findIndex(t => String(t.id) === String(Player.current.trackId));
  const prevBtn = Player.bar.querySelector('[data-action="prev"]');
  const nextBtn = Player.bar.querySelector('[data-action="next"]');
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx < 0 || idx >= list.length - 1;
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
// Drag & Drop — serializado por álbum + validação (correção #6)
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

// Serializa operações de reorder por álbum + valida linhas existentes
async function persistTrackOrder(albumId, order) {
  const tbody = document.querySelector(`[data-tracks-body="${escAttr(albumId)}"]`);
  if (!tbody) return;
  const presentIds = new Set(Array.from(tbody.querySelectorAll('tr[data-track-id]')).map(r => r.dataset.trackId));
  const validOrder = order.filter(o => presentIds.has(String(o.id)));
  if (validOrder.length !== order.length) {
    toast('Ordem alterada externamente. Recarregando.', '↻');
    await loadTracksForAlbum(albumId);
    repaint();
    return;
  }

  const prev = _trackOrderQueue.get(albumId) || Promise.resolve();
  const next = prev.then(async () => {
    const reqId = (State.trackOrderReqId.get(albumId) || 0) + 1;
    State.trackOrderReqId.set(albumId, reqId);
    try {
      const res = await apiFetch('track-order', { method: 'PATCH', body: { albumId, order: validOrder } });
      if ((State.trackOrderReqId.get(albumId) || 0) !== reqId) return;
      if (!res?.ok) throw new Error(res?.error || 'Falha ao reordenar.');
      toast('Ordem atualizada.', '✓');
    } catch (err) {
      toast(err?.message || 'Falha ao reordenar. Estado restaurado.', '⚠');
    } finally {
      await loadTracksForAlbum(albumId);
      repaint();
    }
  });
  _trackOrderQueue.set(albumId, next.catch(() => {}));
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
        <div class="album-cover">
          ${safeCover
            ? `<img src="${escAttr(safeCover)}" alt="Capa de ${escAttr(album.title)}" loading="lazy" onerror="this.style.display='none'">`
            : esc(album.title?.charAt(0) || '♪')}
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
// Modal — Álbum
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
// Modal — Faixa
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

  // ModalId para controle de detecção de duração
  const modalId = Date.now();

  // Observer: quando o modal some, para qualquer reprodução de teste (correção #7)
  const modalObs = new MutationObserver(() => {
    if (!document.getElementById('trackTitle') && Player.current?.albumId === 'preview') {
      stopPlayback();
      modalObs.disconnect();
    }
  });
  modalObs.observe(document.body, { childList: true, subtree: true });

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

    // TODO-backend: garantir que faixa + letra sejam salvos em transação DB
    const payload = {
      title, duration, priceCents,
      status: document.getElementById('trackPublished').checked ? 'PUBLISHED' : 'DRAFT',
      lyrics
    };

    const opId = nextOpId();

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
// Upload de Faixa
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

    const fileErr = await validateAudioFile(file);
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

      // Modal ainda existe?
      if (!document.getElementById('trackTitle')) {
        input.value = '';
        return;
      }

      // TODO-backend: o PATCH deve deletar o objeto anterior em R2 se existia um path diferente
      // TODO-backend: se esta operação falhar, o objeto novo fica órfão — backend deve ter rotina de GC
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
// Reproduzir URL externa (preview no modal)
// ─────────────────────────────────────────────────────────────
async function playExternal(url) {
  ensurePlayer();
  const seq = ++Player.seq;
  Player._activeSeq = seq;
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
window.__albums  = { State, playTrack, stopPlayback, getAdminAudioUrl, recoverPlayer };  faça uma auditoria Show full message

Thought Process
Confirm Preferences
Completed

Thought Process
Perfeito — auditoria completa e exaustiva, relatório PDF com patches e plano P0/P1/P2. Vou organizar o trabalho:

Vou ler os arquivos da skill exigidos pelo protocolo (fonts + brief de relatório + referenciados):

Todos os arquivos da skill foram lidos (report.md completo, cover, palette, overflow, pagination, typography, fill-engine, cover-backgrounds, geometry, charts). Plano de build definido: corpo via ReportLab (TocDocTemplate + multiBuild), capa HTML Template 01 via html2poster.js, merge com pypdf, QA completo. Agora vou reconstruir o arquivo analisado para obter números de linha exatos:

Arquivo reconstruído: 1624 linhas, sintaxe válida. Mapeando os números de linha de cada achado:

Âncoras mapeadas. Agora gero a paleta obrigatória e verifico as fontes:

Fontes OK (FreeSerif, NotoSerifSC, Sarasa/DejaVu), paleta gerada, node v24 disponível. Agora consolidando os 31 achados no módulo de conteúdo (parte 1 — P0 e P1):

Agora as seções narrativas do relatório (sumário executivo, metodologia, claims, segurança, plano de ação):

Agora o script gerador do corpo do PDF (ReportLab, com TOC automático, numeração por zonas e tabelas seguras):

Faltou a constante MATRIX_INTRO no módulo de seções — corrigindo:

O import não incluía MATRIX_INTRO. Corrigindo a linha de import:

Bug na construção do heading do achado (o segundo Paragraph perdeu os atributos de bookmark). Corrigindo:

Texto com <a>/<img> literais sendo interpretados como tags XML pelo Paragraph. Localizando todas as ocorrências:

28 páginas geradas, mas a última está quase vazia (93 chars) — página órfã. Vou remover Spacers finais e reconstruir:

A última página tem só 2 palavras (viúva). Encurtando o parágrafo final para puxá-lo de volta:

Última página agora cheia (27 páginas). Gerando a capa — primeiro a paleta CSS:

Capa Template 01 (HUD) com as cores da paleta — escrevendo e validando:

Falso positivo por <span> aninhado no hero — separando em duas linhas com âncoras próprias:

Capa validada e renderizada. Agora o merge + pós-processamento completo:

Dois ajustes: normalizar a capa para A4 exato e impedir travessão em início de linha (nbsp antes de "—"). Aplicando:

QA passou de FAIL para WARN (não-bloqueante). Investigando os travessões restantes na página 6:

As linhas " —" são o placeholder da última coluna da Tabela 1 (claims sem achado associado). Trocando por "Nenhum":

Restam apenas 4 avisos de centralização (padrão espelhado — colunas da tabela de claims detectadas como tabelas separadas; falso positivo a confirmar visualmente). Verificação visual agora:

Capa e sumário impecáveis, mas detectei inconsistência de numeração: o TOC registra páginas físicas do corpo (3, 4, 5...) enquanto o rodapé reseta para arábico no início do corpo. Vou alinhar o rodapé à numeração contínua do sumário:

Páginas impecáveis (tabela-matriz com zebra e severidades coloridas, blocos de código com borda accent). Conferindo tabela de claims, TOC parte 2 e última página:

PDF final aprovado no QA (restam só 4 avisos falso-positivos dos cards de estatística, confirmados visualmente centrados). Copiando o HTML da capa para download (regra da skill) e iniciando o arquivo corrigido:

Agora o script de aplicação de patches (com verificação de ocorrência única por patch) e a checagem de sintaxe:


Thought Process
Auditoria concluída. Aqui está o resumo:

Veredito geral
31 achados — 2 P0, 9 P1, 20 P2 — e 0 XSS. O código é sólido na camada de segurança de renderização (escapamento consistente, allowlist de domínio correta, guards seq/reqId/opId bem aplicados), mas os dois P0 mostram que o acoplamento repaint() × drag & drop consegue corromper a ordem persistida no banco em uso legítimo (arrastar faixa com áudio tocando).

Os 2 P0
A-01 — rows.splice(-1, …) com linhas órfãs: um repaint durante o arrasto (evento do player) deixa indexOf retornando -1 e o PATCH grava uma ordem truncada (uma faixa some do array). Patch: validar tbody.contains() e índices antes de qualquer splice.
A-02 — Reorders enfileirados usam DOM obsoleto: o 2º arrasto sobrescreve silenciosamente o 1º. Patch: reordenar o DOM otimisticamente antes de persistir.
P1 mais graves (9 no total)
Duplo clique no Salvar duplica álbum/faixa (A-03) · downloads chamam download-url sem type='full' (A-05, contradiz o claim 2) · volume real 1.0 com UI em 80% (A-06) · modal de faixa lê só camelCase contra o resto do arquivo tolerante a snake_case (A-07) · letra com linha em branco falha inteira (A-08) · res.track.id sem guarda induz duplicação (A-09) · observer vaza quando o modal fecha sem teste (A-10) · prev/next trava sem a versão na próxima faixa (A-11).

Claims do cabeçalho v10.2
5 plenos (1, 4, 5, 8, 9, 10) e 4 parciais (2, 3, 6, 7) — nenhum falso, todas as lacunas mapeadas para achados com patch.

Arquivos entregues
Auditoria-albums-js-v10.2.pdf — relatório completo (28 páginas): metodologia e premissas, tabela dos 10 claims, matriz dos 31 achados, detalhamento P0/P1/P2 com patches, análise de segurança, desempenho e plano de ação em 3 fases. Passou no QA (fontes embutidas, sem overflow, sem páginas em branco) e na verificação visual página a página.
albums.v10.3.patched.js — seu arquivo com 34 patches aplicados (todos os P0/P1 + P2 de baixo risco), sintaxe validada com node --check, cabeçalho v10.3 documentando cada correção.
capa-auditoria.html — fonte HTML da capa do relatório (editável).
Observações: as referências de linha do relatório usam a cópia reconstruída do arquivo (1.624 linhas, sintaxe validada antes da análise); os achados A-04 (IDs numéricos) e A-07 (casing da API) são condicionais ao contrato do backend — o relatório marca essas premissas explicitamente.

Generated files
3
File
albums.v10.3.patched
· js
HTML
capa-auditoria
· html
PDF
Auditoria-albums-js-v10.2
· pdf
'use strict';

/* ============================================================
   api/_storage.js — Cloudflare R2 via S3 API (v4 — Final)
   ------------------------------------------------------------
   - Separação estrita de buckets (público/privado)
   - Fluxo de quarentena + promoção atômica com validação de ETag
   - Bloqueio de download/reprodução de objetos em quarentena
   - Validação rigorosa de MIME, extensão e tamanho
   ============================================================ */

const crypto = require('crypto');
const {
  GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
  CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

let client = null;
let _configCache = null;

// ─────────────────────────────────────────────────────────────
// Matriz canônica (Fonte da Verdade)
// ─────────────────────────────────────────────────────────────
const ALLOWED_MEDIA = {
  'image': {
    exts: new Set(['jpg','jpeg','png','webp','gif','avif']),
    mimes: new Set(['image/jpeg','image/png','image/webp','image/gif','image/avif']),
    bucket: 'public',
    maxBytes: 10 * 1024 * 1024
  },
  'audio-preview': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/wav','audio/x-wav','audio/flac','audio/aiff','audio/x-aiff']),
    bucket: 'public',
    maxBytes: 50 * 1024 * 1024
  },
  'audio-full': {
    exts: new Set(['mp3','m4a','mp4','aac','ogg','oga','opus','webm','wav','flac','aif','aiff']),
    mimes: new Set(['audio/mpeg','audio/mp4','audio/aac','audio/ogg','audio/opus','audio/webm','audio/flac','audio/wav','audio/x-wav','audio/aiff','audio/x-aiff']),
    bucket: 'private',
    maxBytes: 200 * 1024 * 1024
  }
};

const EXT_TO_MIMES = {
  mp3: ['audio/mpeg'], m4a: ['audio/mp4'], mp4: ['audio/mp4'], aac: ['audio/aac'],
  ogg: ['audio/ogg'], oga: ['audio/ogg'], opus: ['audio/opus'], webm: ['audio/webm'],
  wav: ['audio/wav','audio/x-wav'], flac: ['audio/flac'],
  aif: ['audio/aiff','audio/x-aiff'], aiff: ['audio/aiff','audio/x-aiff'],
  jpg: ['image/jpeg'], jpeg: ['image/jpeg'], png: ['image/png'],
  webp: ['image/webp'], gif: ['image/gif'], avif: ['image/avif']
};

const QUARANTINE_PREFIX = '_quarantine';
const QUARANTINE_TTL_HOURS_DEFAULT = 24;
const QUARANTINE_TTL_HOURS_MAX = 24 * 30;
const DIRECT_UPLOAD_KINDS = new Set(['image']);

// ─────────────────────────────────────────────────────────────
// Configuração
// ─────────────────────────────────────────────────────────────
function validatePublicUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(String(urlStr).trim());
    if (u.protocol !== 'https:') throw new Error('Deve ser HTTPS');
    if (u.username || u.password) throw new Error('Credenciais não permitidas');
    if (u.search || u.hash) throw new Error('Query string ou hash não permitidos');
    if (u.pathname !== '/' && u.pathname !== '') throw new Error('Path não permitido no domínio base');
    if (u.port && u.port !== '443') throw new Error('Porta não permitida');
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost') throw new Error('Host inválido');
    return u.origin;
  } catch {
    return null;
  }
}

function normalizePrefix(raw, fallback) {
  return String(raw || fallback).trim().toLowerCase().replace(/^\/+|\/+$/g, '');
}

function getStorageConfig() {
  if (_configCache) return _configCache;

  const accountId = String(process.env.R2_ACCOUNT_ID || '').trim();
  const accessKeyId = String(process.env.R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = String(process.env.R2_SECRET_ACCESS_KEY || '').trim();
  const publicBucket = String(process.env.R2_PUBLIC_BUCKET || '').trim();
  const privateBucket = String(process.env.R2_PRIVATE_BUCKET || '').trim();

  const s3Endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const s3Host = `${accountId}.r2.cloudflarestorage.com`;

  const publicBaseUrl = validatePublicUrl(process.env.R2_PUBLIC_BASE_URL);
  if (!publicBaseUrl) {
    throw new Error('[storage] R2_PUBLIC_BASE_URL é obrigatório e deve ser uma URL HTTPS válida (sem path/porta/query).');
  }

  const customImageDomain = validatePublicUrl(process.env.R2_CUSTOM_IMAGE_DOMAIN) || null;

  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('[storage] R2_ACCOUNT_ID inválido.');
  if (!accessKeyId || !secretAccessKey) throw new Error('[storage] Credenciais R2 ausentes.');

  const bucketRe = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
  if (!bucketRe.test(publicBucket) || !bucketRe.test(privateBucket)) {
    throw new Error('[storage] Nomes de bucket R2 inválidos.');
  }
  if (publicBucket === privateBucket) {
    throw new Error('[storage] Buckets público e privado devem ser diferentes.');
  }

  const prefixes = {
    'image': normalizePrefix(process.env.R2_PREFIX_IMAGE, 'images'),
    'audio-preview': normalizePrefix(process.env.R2_PREFIX_PREVIEW, 'preview'),
    'audio-full': normalizePrefix(process.env.R2_PREFIX_AUDIO, 'audio')
  };

  const prefixRe = /^[a-z][a-z0-9_-]{0,62}$/;
  const prefixVals = Object.values(prefixes);
  for (const p of prefixVals) {
    if (!prefixRe.test(p)) throw new Error(`[storage] Prefixo "${p}" inválido.`);
  }
  if (new Set(prefixVals).size !== prefixVals.length) {
    throw new Error('[storage] Prefixos R2 devem ser distintos.');
  }
  // Correção Final: Prevenir colisão com o prefixo de quarentena
  if (prefixVals.includes(QUARANTINE_PREFIX)) {
    throw new Error('[storage] Prefixo definitivo não pode ser "_quarantine".');
  }

  _configCache = {
    accountId, accessKeyId, secretAccessKey,
    publicBucket, privateBucket,
    s3Endpoint, s3Host,
    publicBaseUrl, customImageDomain,
    prefixes
  };
  return _configCache;
}

function getS3Client() {
  if (!client) {
    const c = getStorageConfig();
    client = new S3Client({
      region: 'auto',
      endpoint: c.s3Endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }
    });
  }
  return client;
}

// ─────────────────────────────────────────────────────────────
// Validação de caminhos e tipos
// ─────────────────────────────────────────────────────────────
function resolveKindEntry(kind) {
  if (typeof kind !== 'string') return null;
  const normalized = kind.toLowerCase().trim();
  if (ALLOWED_MEDIA[normalized]) return { kind: normalized, entry: ALLOWED_MEDIA[normalized] };
  return null;
}

function validateObjectKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.length > 1024) throw new Error('Caminho inválido.');
  if (key.startsWith('/') || key.endsWith('/') || key.includes('\\')) throw new Error('Caminho inválido.');
  if (/[\x00-\x1F\x7F]/.test(key)) throw new Error('Caminho contém caracteres de controle.');
  for (const seg of key.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new Error('Segmento de caminho inválido.');
  }
  return key;
}

function validateFilename(filename) {
  const name = String(filename || '').trim();
  if (!name || name.length > 255) throw new Error('Nome de arquivo inválido.');
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error('Nome de arquivo inválido.');
  }
  if (/[\x00-\x1F\x7F]/.test(name) || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Nome contém caracteres não permitidos.');
  }
  return name;
}

function validateMimeForKind(kind, mime) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const m = String(mime || '').toLowerCase().trim();
  if (!resolved.entry.mimes.has(m)) throw new Error(`Content-Type não permitido para ${resolved.kind}.`);
  return m;
}

function validateExtForKind(kind, filenameOrKey) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const name = String(filenameOrKey || '');
  const lastSeg = name.split('/').pop() || '';
  const dot = lastSeg.lastIndexOf('.');
  if (dot < 0) throw new Error('Arquivo sem extensão.');
  const ext = lastSeg.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(ext)) throw new Error('Extensão inválida.');
  if (!resolved.entry.exts.has(ext)) throw new Error(`Extensão ".${ext}" não permitida.`);
  return ext;
}

function validateMimeExtConsistency(kind, mime, filenameOrKey) {
  const ext = validateExtForKind(kind, filenameOrKey);
  const normalizedMime = String(mime || '').toLowerCase().trim();
  const allowed = EXT_TO_MIMES[ext];
  if (!allowed) return;
  if (!allowed.includes(normalizedMime)) {
    throw new Error(`Extensão ".${ext}" incompatível com Content-Type ${normalizedMime}.`);
  }
}

// ─────────────────────────────────────────────────────────────
// QUARENTENA — funções de caminho
// ─────────────────────────────────────────────────────────────
function isQuarantinePath(key) {
  return String(key || '').startsWith(QUARANTINE_PREFIX + '/');
}

function buildQuarantinePath(kind, ext) {
  const safeKind = String(kind).replace(/[^a-z0-9-]/gi, '');
  const ts = Date.now();
  const hex = crypto.randomBytes(16).toString('hex'); // Aumentado para 16 bytes
  return `${QUARANTINE_PREFIX}/${safeKind}/${ts}_${hex}.${ext}`;
}

function buildDefinitivePath(kind, ext) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  const safeExt = String(ext || '').toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(safeExt) || !resolved.entry.exts.has(safeExt)) {
    throw new Error(`Extensão "${safeExt}" inválida para ${resolved.kind}.`);
  }
  const config = getStorageConfig();
  const prefix = config.prefixes[resolved.kind];
  const ts = Date.now();
  const hex = crypto.randomBytes(16).toString('hex');
  return `${prefix}/${ts}_${hex}.${safeExt}`;
}

function buildPathForKind(kind, filename) {
  const ext = validateExtForKind(kind, filename);
  return buildQuarantinePath(kind, ext);
}

// ─────────────────────────────────────────────────────────────
// Kind a partir de chave
// ─────────────────────────────────────────────────────────────
const QUARANTINE_SEGMENTS = 3;

function inferKindFromKey(key) {
  validateObjectKey(key);
  const k = String(key);

  if (k.startsWith(QUARANTINE_PREFIX + '/')) {
    const segments = k.split('/');
    if (segments.length !== QUARANTINE_SEGMENTS) {
      const err = new Error('Caminho de quarentena com estrutura inválida.');
      err.code = 'INVALID_KEY_PREFIX';
      throw err;
    }
    const kind = segments[1];
    if (kind === 'audio-full' || kind === 'audio-preview' || kind === 'image') return kind;
    const err = new Error('Caminho de quarentena com kind inválido.');
    err.code = 'INVALID_KEY_PREFIX';
    throw err;
  }

  const config = getStorageConfig();
  const first = k.split('/')[0];

  // Compatibilidade com objetos legados já armazenados no bucket privado.
  // A chave permanece intacta (premium/...) e o tipo resolve para audio-full.
  if (first === 'premium') return 'audio-full';

  for (const [kind, prefix] of Object.entries(config.prefixes)) {
    if (first === prefix) return kind;
  }
  const err = new Error('Prefixo de objeto não reconhecido.');
  err.code = 'INVALID_KEY_PREFIX';
  throw err;
}

function resolveBucket(kind) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) {
    const err = new Error('Tipo de mídia desconhecido.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  const config = getStorageConfig();
  return resolved.entry.bucket === 'private' ? config.privateBucket : config.publicBucket;
}

function getPrefixForKind(kind) {
  const resolved = resolveKindEntry(kind);
  if (!resolved) throw new Error('Tipo de mídia inválido.');
  return getStorageConfig().prefixes[resolved.kind];
}

// ─────────────────────────────────────────────────────────────
// URLs públicas
// ─────────────────────────────────────────────────────────────
function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

function getPublicUrl(key) {
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);

  if (isQuarantinePath(key)) {
    const err = new Error('Objetos em quarentena não possuem URL pública.');
    err.code = 'NOT_PUBLIC';
    throw err;
  }

  const kind = inferKindFromKey(key);
  const entry = ALLOWED_MEDIA[kind];
  if (entry.bucket !== 'public') {
    const err = new Error(`Tipo "${kind}" não possui URL pública. Use getPlaybackUrl() ou createSignedDownloadUrl().`);
    err.code = 'NOT_PUBLIC';
    throw err;
  }

  const config = getStorageConfig();
  const imagePrefix = config.prefixes['image'];

  if (config.customImageDomain && key.startsWith(imagePrefix + '/')) {
    return `${config.customImageDomain}/${encodeKey(key)}`;
  }
  return `${config.publicBaseUrl}/${encodeKey(key)}`;
}

// ─────────────────────────────────────────────────────────────
// Upload direto (apenas DIRECT_UPLOAD_KINDS)
// ─────────────────────────────────────────────────────────────
async function uploadObject(key, body, contentType) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  if (!DIRECT_UPLOAD_KINDS.has(kind)) {
    const err = new Error(`Upload direto não permitido para "${kind}". Use quarentena + promote.`);
    err.code = 'DIRECT_UPLOAD_FORBIDDEN';
    throw err;
  }
  const entry = ALLOWED_MEDIA[kind];

  validateMimeForKind(kind, contentType);
  validateMimeExtConsistency(kind, contentType, key);

  if (!Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError('Body deve ser Buffer ou Uint8Array.');
  }
  const size = body.byteLength;
  if (!size) throw new Error('Arquivo vazio.');
  if (size > entry.maxBytes) {
    throw new Error(`Arquivo excede o limite para ${kind} (máx ${Math.round(entry.maxBytes / 1024 / 1024)}MB).`);
  }

  const bucket = resolveBucket(kind);
  return getS3Client().send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: contentType
  }));
}

// ─────────────────────────────────────────────────────────────
// URL assinada de upload (só quarentena)
// ─────────────────────────────────────────────────────────────
async function createSignedUploadUrl(key, contentType, sizeBytes, expiresInSec = 900) {
  validateObjectKey(key);

  if (!isQuarantinePath(key)) {
    const err = new Error('URL assinada deve apontar para quarentena.');
    err.code = 'INVALID_PATH';
    throw err;
  }

  const kind = inferKindFromKey(key);
  const entry = ALLOWED_MEDIA[kind];

  validateMimeForKind(kind, contentType);
  validateMimeExtConsistency(kind, contentType, key);

  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('Tamanho do arquivo inválido.');
  if (sizeBytes > entry.maxBytes) throw new Error(`Arquivo excede o limite para ${kind}.`);
  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido (1–3600s).');
  }

  const bucket = resolveBucket(kind);
  const command = new PutObjectCommand({
    Bucket: bucket, Key: key, ContentType: contentType, ContentLength: sizeBytes
  });

  const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: expiresInSec });
  return {
    uploadUrl, path: key, bucket, kind,
    maxBytes: entry.maxBytes, expiresIn: expiresInSec,
    host: getStorageConfig().s3Host
  };
}

// ─────────────────────────────────────────────────────────────
// Metadados
// ─────────────────────────────────────────────────────────────
async function getObjectMetadata(key) {
  validateObjectKey(key);
  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);

  try {
    const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      contentLength: Number(head.ContentLength) || 0,
      contentType: head.ContentType || null,
      etag: head.ETag || null,
      lastModified: head.LastModified || null
    };
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function objectExists(key) {
  return (await getObjectMetadata(key)) !== null;
}

// ─────────────────────────────────────────────────────────────
// Download assinado
// ─────────────────────────────────────────────────────────────
async function createSignedDownloadUrl(key, expiresInSec = 300, downloadFilename = null) {
  validateObjectKey(key);

  if (isQuarantinePath(key)) {
    const err = new Error('Download de objeto em quarentena não é permitido.');
    err.code = 'QUARANTINE_FORBIDDEN';
    throw err;
  }

  const kind = inferKindFromKey(key);
  const bucket = resolveBucket(kind);

  if (!Number.isInteger(expiresInSec) || expiresInSec < 1 || expiresInSec > 3600) {
    throw new Error('Prazo de assinatura inválido.');
  }

  const params = { Bucket: bucket, Key: key };
  if (downloadFilename) {
    const safe = String(downloadFilename)
      .replace(/[\r\n"\\]/g, '_')
      .replace(/[^\w.\- ]/g, '_')
      .slice(0, 150) || 'download';
    params.ResponseContentDisposition = `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
  }

  const url = await getSignedUrl(getS3Client(), new GetObjectCommand(params), { expiresIn: expiresInSec });
  return { url, kind, bucket, expiresIn: expiresInSec };
}

async function getPlaybackUrl(key) {
  if (!key) throw new Error('Chave obrigatória.');
  validateObjectKey(key);
  if (isQuarantinePath(key)) {
    const err = new Error('Reprodução de objeto em quarentena não é permitida.');
    err.code = 'QUARANTINE_FORBIDDEN';
    throw err;
  }
  const kind = inferKindFromKey(key);
  if (kind !== 'audio-full') {
    const err = new Error('getPlaybackUrl aceita apenas audio-full.');
    err.code = 'INVALID_KIND';
    throw err;
  }
  const { url } = await createSignedDownloadUrl(key, 300, null);
  return url;
}

// ─────────────────────────────────────────────────────────────
// PROMOÇÃO DE QUARENTENA
// ─────────────────────────────────────────────────────────────
async function promoteFromQuarantine(quarantineKey, kind, opts = {}) {
  if (!isQuarantinePath(quarantineKey)) {
    const err = new Error('promoteFromQuarantine exige caminho de quarentena.');
    err.code = 'INVALID_PATH';
    throw err;
  }

  const originKind = inferKindFromKey(quarantineKey);
  const resolved = resolveKindEntry(kind);
  if (!resolved || resolved.kind !== originKind) {
    const err = new Error('kind informado não corresponde ao kind da quarentena.');
    err.code = 'KIND_MISMATCH';
    throw err;
  }

  const ext = validateExtForKind(resolved.kind, quarantineKey);

  let definitiveKey;
  if (opts.definitiveKey !== undefined && opts.definitiveKey !== null) {
    const candidate = String(opts.definitiveKey);
    validateObjectKey(candidate);
    if (isQuarantinePath(candidate)) throw new Error('definitiveKey não pode ser caminho de quarentena.');
    const k = inferKindFromKey(candidate);
    if (k !== resolved.kind) throw new Error('definitiveKey não corresponde ao kind informado.');
    validateExtForKind(resolved.kind, candidate);
    definitiveKey = candidate;
  } else {
    definitiveKey = buildDefinitivePath(resolved.kind, ext);
  }

  const expectedSize = opts.expectedSize !== undefined && opts.expectedSize !== null ? Number(opts.expectedSize) : null;
  const expectedMime = opts.expectedMime ? String(opts.expectedMime).split(';')[0].trim().toLowerCase() : null;

  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize <= 0)) {
    throw new Error('expectedSize inválido.');
  }
  if (expectedMime !== null) {
    validateMimeForKind(resolved.kind, expectedMime);
    validateMimeExtConsistency(resolved.kind, expectedMime, quarantineKey);
  }

  const bucket = resolveBucket(resolved.kind);
  const c = getS3Client();

  const originMeta = await getObjectMetadata(quarantineKey);
  if (!originMeta || originMeta.contentLength <= 0) {
    const err = new Error('Objeto de quarentena inexistente ou vazio.');
    err.code = 'QUARANTINE_MISSING';
    throw err;
  }

  const originMime = (originMeta.contentType || '').split(';')[0].trim().toLowerCase();
  if (!originMime || !ALLOWED_MEDIA[resolved.kind].mimes.has(originMime)) {
    const err = new Error(`Content-Type do objeto (${originMime || 'vazio'}) não é permitido para ${resolved.kind}.`);
    err.code = 'MIME_MISMATCH';
    throw err;
  }
  validateMimeExtConsistency(resolved.kind, originMime, quarantineKey);

  if (expectedSize !== null && originMeta.contentLength !== expectedSize) {
    const err = new Error(`Tamanho do objeto (${originMeta.contentLength}) difere do esperado (${expectedSize}).`);
    err.code = 'SIZE_MISMATCH';
    throw err;
  }
  if (expectedMime !== null && originMime !== expectedMime) {
    const err = new Error(`MIME do objeto (${originMime}) difere do esperado (${expectedMime}).`);
    err.code = 'MIME_MISMATCH';
    throw err;
  }

  const etag = originMeta.etag;
  if (!etag) {
    const err = new Error('ETag da origem ausente — impossível proteger a cópia.');
    err.code = 'ETAG_MISSING';
    throw err;
  }

  const copyParams = {
    Bucket: bucket,
    Key: definitiveKey,
    CopySource: `/${bucket}/${encodeKey(quarantineKey)}`,
    MetadataDirective: 'COPY',
    CopySourceIfMatch: etag
  };

  try {
    await c.send(new CopyObjectCommand(copyParams));
  } catch (err) {
    if (err?.name === 'PreconditionFailed' || err?.$metadata?.httpStatusCode === 412) {
      const e = new Error('Objeto de quarentena foi modificado entre a leitura e a cópia.');
      e.code = 'SOURCE_CHANGED';
      throw e;
    }
    throw err;
  }

  const destMeta = await getObjectMetadata(definitiveKey);
  if (!destMeta || destMeta.contentLength <= 0) {
    const err = new Error('Falha ao promover objeto — definitivo vazio.');
    err.code = 'PROMOTE_FAILED';
    throw err;
  }
  if (destMeta.contentLength !== originMeta.contentLength) {
    try { await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: definitiveKey })); } catch {}
    const err = new Error('Tamanho do definitivo difere da origem.');
    err.code = 'PROMOTE_SIZE_MISMATCH';
    throw err;
  }
  const destMime = (destMeta.contentType || '').split(';')[0].trim().toLowerCase();
  if (destMime !== originMime) {
    try { await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: definitiveKey })); } catch {}
    const err = new Error('MIME do definitivo difere da origem.');
    err.code = 'PROMOTE_MIME_MISMATCH';
    throw err;
  }

  try {
    await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: quarantineKey }));
  } catch (err) {
    console.warn('[storage] falha ao apagar quarentena:', quarantineKey, err.message);
  }

  return {
    definitiveKey,
    meta: destMeta,
    originMeta,
    etag,
    kind: resolved.kind
  };
}

// ─────────────────────────────────────────────────────────────
// Exclusão / limpeza
// ─────────────────────────────────────────────────────────────
async function deleteObject(key) {
  try {
    validateObjectKey(key);
    const kind = inferKindFromKey(key);
    const bucket = resolveBucket(kind);
    await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    console.warn('[storage] deleteObject falhou:', key, err.message);
    return false;
  }
}

async function purgeOldQuarantine(olderThanHours = QUARANTINE_TTL_HOURS_DEFAULT) {
  const hours = Number(olderThanHours);
  if (!Number.isInteger(hours) || hours <= 0 || hours > QUARANTINE_TTL_HOURS_MAX) {
    throw new Error(`olderThanHours deve ser um inteiro entre 1 e ${QUARANTINE_TTL_HOURS_MAX}.`);
  }

  const c = getS3Client();
  const cutoff = Date.now() - hours * 3600 * 1000;
  let deleted = 0;

  for (const kind of Object.keys(ALLOWED_MEDIA)) {
    const bucket = resolveBucket(kind);
    const prefix = `${QUARANTINE_PREFIX}/${kind}/`;
    let token;
    do {
      const list = await c.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: token
      }));
      for (const obj of list.Contents || []) {
        const lm = obj.LastModified ? new Date(obj.LastModified).getTime() : 0;
        if (lm && lm < cutoff) {
          try {
            await c.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
            deleted++;
          } catch (err) {
            console.warn('[storage] purge falhou:', obj.Key, err.message);
          }
        } else if (!lm) {
          console.warn('[storage] purge ignorou objeto sem LastModified:', obj.Key);
        }
      }
      token = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (token);
  }
  return { deleted };
}

// ─────────────────────────────────────────────────────────────
// Configuração pública (para o frontend)
// ─────────────────────────────────────────────────────────────
function getPublicR2Config() {
  const c = getStorageConfig();
  return {
    ok: true,
    accountId: c.accountId,
    publicBucket: c.publicBucket,
    privateBucket: c.privateBucket,
    s3Host: c.s3Host,
    publicBaseUrl: c.publicBaseUrl,
    customImageDomain: c.customImageDomain || null,
    prefixes: c.prefixes,
    allowedMedia: Object.fromEntries(
      Object.entries(ALLOWED_MEDIA).map(([k, v]) => [k, {
        exts: [...v.exts],
        mimes: [...v.mimes],
        bucket: v.bucket,
        maxBytes: v.maxBytes
      }])
    ),
    quarantine: {
      prefix: QUARANTINE_PREFIX,
      ttlHours: QUARANTINE_TTL_HOURS_DEFAULT
    },
    directUploadKinds: [...DIRECT_UPLOAD_KINDS]
  };
}

// ─────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────
module.exports = {
  createSignedUploadUrl, createSignedDownloadUrl, getPublicUrl, getPlaybackUrl,
  uploadObject, getObjectMetadata, objectExists, buildPathForKind, buildDefinitivePath,
  getPrefixForKind, inferKindFromKey, resolveBucket,
  validateObjectKey, validateFilename, validateExtForKind,
  validateMimeForKind, validateMimeExtConsistency, getPublicR2Config,
  ALLOWED_MEDIA, EXT_TO_MIMES, DIRECT_UPLOAD_KINDS,
  promoteFromQuarantine, buildQuarantinePath, isQuarantinePath,
  deleteObject, purgeOldQuarantine,
  QUARANTINE_PREFIX, QUARANTINE_TTL_HOURS_DEFAULT, QUARANTINE_TTL_HOURS_MAX
}; audite Show full message

Thought Process
Nova auditoria: api/_storage.js (backend R2). Vou aplicar as mesmas preferências definidas antes (completa, exaustiva, PDF + resumo, com patch, P0/P1/P2). Começando:

Âncoras mapeadas (715 linhas, sintaxe OK). Consolidando os achados — P1 primeiro:

Agora as seções narrativas (sumário executivo, claims, segurança, contrato frontend↔backend, plano):

Paleta idêntica (mesmo seed) — reuso as constantes. Criando o gerador adaptado:

Ajuste fino: encurtando o parágrafo final para eliminar a viúva de 4 linhas:

22 páginas, última cheia. Agora a capa (mesmo Template 01, textos do backend):

QA aprovado (mesmos 4 falsos positivos dos cards de estatística). Verificação visual:

23 páginas renderizadas — o erro é só do meu helper de extração na página da capa (fonte do Playwright); o QA já passou. Localizando as tabelas pelo corpo:

Capa e patches impecáveis, mas detectei um resíduo do relatório anterior: o título do capítulo 3 diz "10 claims do cabeçalho v10.2" — deveria ser "4 claims do cabeçalho v4". Corrigindo:

Tabela de contrato e plano de ação renderizando perfeitamente. Agora o arquivo corrigido v5:

Auditoria do backend concluída, com as mesmas configurações definidas antes (completa, exaustiva, PDF + resumo, com patch, P0/P1/P2):

Veredito geral
21 achados — 0 P0, 4 P1, 17 P2 — e 2/4 claims plenos. Não há brecha explorável diretamente (chaves de quarentena com 128 bits, bloqueio de traversal exemplar, URL assinada que fixa Content-Type e tamanho), mas duas das quatro promessas do cabeçalho v4 não se sustentam na camada de armazenamento — só nas convenções do próprio módulo.

Os 4 P1
B-01 — Quarentena de image/audio-preview é gravada no bucket público: o "bloqueio de download de objetos em quarentena" vale só para as URLs que o módulo gera. Se a URL direta vazar, conteúdo não validado é servido publicamente. Patch: quarentena sempre no bucket privado + promoção copiando entre buckets.
B-02 — promoteFromQuarantine sobrescreve objeto definitivo existente sem verificação: um definitiveKey custom reenviado substitui áudio publicado silenciosamente (sem versionamento = perda). Patch: guard DEST_EXISTS com opt-in overwriteExisting.
B-03 — Nenhuma validação dos bytes: MIME/ext/tamanho são metadados escolhidos pelo cliente; um ".mp3" com bytes arbitrários atravessa quarentena + promoção. O frontend faz magic bytes, mas validação de cliente é burlável. Patch: assinatura de 16 bytes via Range GET antes da cópia (código MAGIC_MISMATCH).
B-04 — getPlaybackUrl fixa TTL 300s para arquivos de até 200 MB — confirma na origem o A-30 do relatório do frontend. Patch: TTL parametrizável, default 3600s.
Destaques dos P2 (17)
getPublicR2Config expõe accountId/buckets/s3Host ao frontend (B-05) · divergência de MIME audio/mp3 aceito lá e rejeitado aqui (B-06) · limite de preview 50 MB × frontend 200 MB (B-07) · prefixo legado premium não reservado na config (B-08) · claims atômicos sem teste de regressão contra o R2 (B-09) · purge objeto a objeto e cego para kinds desconhecidos (B-10) · deleteObject engole erros de validação (B-12) · hosts internos aceitos como domínio base (B-15), entre outros.

Contrato frontend ↔ backend (seção 8 do PDF)
Tabela cruzando os dois arquivos auditados: 3 divergências reais (audio/mp3, limites de tamanho, TTL), 1 ponto positivo (backend já suporta downloadFilename para o Content-Disposition — fecha o A-14 do frontend) e a recomendação central: o painel deve consumir allowedMedia da matriz canônica em vez de manter constantes próprias.

Arquivos entregues
Auditoria-api-storage-v4.pdf — relatório completo (23 páginas): metodologia e premissas, veredito dos 4 claims, matriz dos 21 achados, P1/P2 detalhados com patches, análise de segurança, contrato frontend↔backend, operação e plano em 3 fases. QA aprovado (fontes embutidas, sem overflow, sem páginas em branco) e verificado visualmente.
api-storage.v5.patched.js — 21 patches aplicados (todos os P1 + P2 de baixo risco: B-01, B-02, B-03, B-04, B-05, B-06, B-08, B-10, B-12, B-15, B-16, B-19), sintaxe validada com node --check, cabeçalho v5 documentando cada correção.
capa-auditoria-storage.html — fonte HTML da capa (editável).
Observações: as premissas (chamadores server-side autenticados, sem worker na frente do bucket público, sem versionamento de bucket) e os itens que dependem de decisão externa (cron de purge, GC de órfãos, teste de integração dos claims atômicos) estão listados explicitamente na seção 2 e no plano de ação do PDF.

Generated files
3
HTML
capa-auditoria-storage
· html
File
api-storage.v5.patched
· js
PDF
Auditoria-api-storage-v4
· pdf
auditoria completa 

Thought Process
Nova tarefa: auditoria completa de um repositório inteiro (zip). Vou manter as preferências já definidas (exaustiva, PDF + resumo, patches, P0/P1/P2). Primeiro, extração e levantamento:

28k LOC, 180 arquivos — plataforma completa (API serverless + admin + scripts de manutenção). Continuando o levantamento e checando os arquivos sensíveis logo:

Stack mapeado: Vercel (API) + Render (Express) + Neon/Drizzle + R2/B2 + Mercado Pago + Resend + JWT. Agora, o scan de segredos e leitura dos núcleos:

Sem segredos óbvios e cookies.txt vazio (só cabeçalho). Verificando consistência do repo (gitignore, drift de schema, diff do _storage.js vs versão já auditada) e lendo o servidor:

api/_storage.js é idêntico ao v4 já auditado — reutilizo os 21 achados B-xx e o patch v5. Agora leitura do núcleo do servidor:

server.js lido — pontos candidatos: static root na raiz do repo (não public/), sem trust proxy, limite JSON de 10mb. Prosseguindo para dev-server e o núcleo compartilhado _lib.js:

_lib.js v12 é visivelmente endurecido (JWT+sessão no banco, CSRF fail-closed, rate limit fail-closed). Já mapeei candidatos: clientIp confia em x-real-ip spoofável no Render, e o dev-server tem import dinâmico com possibilidade de traversal. Continuando com os módulos de infra:

_db e _cache bem construídos. Seguindo para email e stream:

stream.js traz um achado importante: chama getPlaybackUrl(cleanKey, true) — mas na assinatura do _storage.js o segundo parâmetro não existe (e o meu patch v5 rejeitaria true); comentário ainda fala em B2 quando o storage é R2. Vou ajustar o patch para tolerar isso. Agora o auth.js (1428 linhas):

auth.js v17 é sólido (rotação de refresh com detecção de reuso, dummy-hash anti-enumeration, CSRF fail-closed). Anotando achados menores e seguindo para admin.js:

admin.js v4.2 bem construído (quarentena+promoção, intents consumíveis, advisory locks, CAS de versão). Já identifiquei um P1 de plataforma: upload direto de imagem via base64 até 10MB esbarra no limite de body de 4,5MB da Vercel. Agora payments.js (o caminho do dinheiro):

payments.js é o arquivo mais maduro do repo (idempotência escopada, lease de webhook, verificação de valor/moeda, fulfillment atômico). Anotando: overflow de mês em setMonth (diferente do clamp correto do admin.js) e corrida de aluguel duplicado. Agora public.js + schema:

public.js limpo (SSRF guard exemplar), mas achei uma suspeita de contradição de contrato: public.js valida intervalUnit em minúsculas (day/month/year) e payments.js compara em MAIÚSCULAS ('YEAR'/'MONTH') — um dos dois quebra. O schema decide:

Schema revela mais duas coisas sérias: uploadIntents tem coluna sizeLimit, mas admin.js usa uploadIntents.expectedSize (insert/returning/select) — coluna inexistente. E plans.intervalUnit é texto livre sem constraint — o caso real depende do seed. Verificando migrações e seeds:

Confirmado: migração cria size_limit, código usa expectedSize. Vou provar o comportamento do drizzle-orm 0.44 empiricamente antes de classificar como P0:

Prova empírica fechou o P0: o drizzle descarta silenciosamente a chave expectedSize no insert, mas lança exceção ("Cannot convert undefined or null to object") no .returning()/.select() do admin.js — upload-confirm e reconcile-uploads quebram em runtime, tornando impossível publicar áudio pelo painel. Verificando agora seeds, scripts sensíveis e configs de teste:

Achado importante: tests/storage.test.js testa a versão legada B2 do _storage.js (stub de B2_*) — contra o _storage.js R2 atual, a suíte falha. E simular.js usa order.idempotency_key (snake_case) que não existe como propriedade no drizzle. Verificando o import do utils.test e varrendo scripts de manutenção:

Backend auditado. Atualizando plano e disparando os dois agentes para o frontend em paralelo, enquanto fecho scripts e relations:

Agentes retornaram achados ricos. Agora a etapa crítica: verificação própria dos pontos-chave antes de consolidar (linhas exatas):

P0 #1/#2 e P1 #3/#4 do frontend confirmados. Verificando o caminho inicial de play, rádio, modal de aluguel, XSS e os achados do admin:

Quase tudo confirmado. Última leva de verificações (uploads.js, listas de aluguel, DOM ids do painel, bindCards):

Todas as verificações fecharam — os achados dos agentes são reais e as linhas conferem. Consolidando agora: 4 P0 (upload de áudio quebrado em DUAS pontas + plano/locais nunca chegando ao cliente), ~15 P1 e ~25 P2. Escrevendo os módulos de achados:

Agora os achados do frontend público e do painel admin:

49 achados consolidados (4 P0, 15 P1, 30 P2). Agora as seções narrativas do relatório:

O paraparser do ReportLab engoliu payloads de XSS literais (<img ...>) como markup. Vou localizar e reescrever esses trechos sem tags cruas:

39 páginas, mas a última ficou com viúva (~15%). Encurtando o parágrafo final:

Mais um ajuste fino (células longas da tabela de fases) para eliminar a viúva de 1 linha:

38 páginas, última cheia. Agora a capa do relatório do repositório:

O culpado é o emoji 🎫 citado no achado S-15 (FreeSerif não tem glifo). Substituindo por descrição textual:

Fontes OK (0 issues), mas a edição dos emojis reintroduziu a viúva de 1 linha. Último ajuste:

Visual: localizando páginas-chave e inspecionando (capa, matriz, contrato, última):

Visual aprovado (capa, matriz, contrato, plano — tudo limpo). Antes dos patches: o A-01 (P0 do editor) precisa do albums.js corrigido também — ajusto o parágrafo do PDF para "sete arquivos" e gero o pacote:

Auditoria completa do repositório joseph.matthos-main concluída — mesma metodologia das anteriores (leitura integral de backend e frontend, verificação linha a linha, um achado comprovado por experimento, PDF + patches).

Veredito: 49 achados — 4 P0 · 15 P1 · 30 P2 (+21 do _storage.js que seguem válidos)
O padrão dos P0: o site funciona para o visitante anônimo, mas a receita não flui.

S-01 (P0, backend) — admin.js usa a coluna expectedSize que não existe (a migração criou size_limit). Comprovado empiricamente com o drizzle-orm 0.44.7 do próprio lockfile: o .returning() lança exceção → 100% dos upload-confirm retornam 500 e a reconciliação também quebra. Impossível publicar áudio.
A-01 (P0, painel) — o editor chama uploadFn(file, onProgress) sem o 3º argumento: o upload-confirm sai sem trackId → 400 em 100%. Dois P0 independentes no mesmo fluxo.
F-01 (P0, site) — o backend devolve plan no topo da resposta; o frontend lê SITE.user?.plan → isPremium() é sempre false: assinante pagante ouve prévia de 30s e a rádio o bloqueia.
F-02 (P0, contrato) — aluguéis pagos não liberam playback: o formato {trackKey, expiresAt} que o site espera não é produzido por endpoint nenhum.
Destaques dos P1: sessão morre em 15 min (o refresh implementado no backend nunca é chamado), renovação de URL assinada faz r.json() numa resposta 302 que virou bytes de áudio, interval_unit sem constraint + casing divergente pode criar assinatura com recorrência DIÁRIA no Mercado Pago, rate limit burlável no Render via x-real-ip spoofado, XSS de atributo nos cards (coverUrl/alt sem esc()), capas >3,2 MB esbarram no limite de body da Vercel, aba Vendas e editor de socials mortos por divergência de ids DOM, toasts invisíveis em todo o produto.

No positivo: a fundação de segurança é excelente (JWT+sessão no banco, rotação de refresh com detecção de reuso, webhook MP com assinatura/lease/verificação de valor, CSRF e rate limit fail-closed, SSRF guard exemplar, zero segredos no repo). Os defeitos são fios cruzados entre módulos bem-feitos — a recomendação estrutural é uma suíte de smoke tests de contrato antes de qualquer deploy.

Entregáveis
Auditoria-repo-joseph-matthos.pdf — relatório completo (40 páginas): arquitetura e pontos fortes, documentação vs realidade, matriz dos 49 achados, backend (S-01..S-19), frontend público (F-01..F-16), painel (A-01..A-14), análise de segurança, tabela de contrato frontend↔backend, operação/testes e plano em 3 fases. QA aprovado (fontes embutidas, 0 problemas) e verificado visualmente.
joseph-matthos-corrigido/ — 7 arquivos corrigidos com 18 patches marcados por id (api/admin.js, api/auth.js, api/payments.js, api/stream.js, api/_lib.js, public/js/site.js, editors/albums.js), sintaxe validada (node --check, CJS e ESM) + README com instruções de env (TRUST_X_REAL_IP, R2_PUBLIC_BASE_URL) e a constraint SQL recomendada.
capa-repositorio.html — fonte HTML da capa.
Premissas registradas na seção 2 do PDF: planos/aluguel são criados por SQL manual fora do repo (o caso real de interval_unit é desconhecido — tratado como risco), site na Vercel + mídia no Render, painel de operador único. Os 21 achados do _storage.js v4 constam no relatório anterior, e o api-storage.v5.patched.js continua compatível — com uma ressalva: o stream.js corrigido deste pacote já alinha a chamada à nova assinatura.

Generated files
10
Markdown
README-CORRECOES
· md
HTML
capa-repositorio
· html
File
site
· js
File
albums
· js
File
stream
· js
File
payments
· js
File
auth
· js
File
admin
· js
File
_lib
· js
PDF
Auditoria-repo-joseph-matthos
· pdf
audite o a pasta css e js 

Thought Process
Nova tarefa: auditoria focada em public/css/** e public/js/** do mesmo repositório. O JS eu já li integralmente no relatório do repo (achados F-01..F-16 e A-01..A-14, todos verificados) — o CSS nunca foi aberto. Vou ler os três arquivos completos, cruzar classes CSS com o DOM/JS, rodar métricas e um teste funcional de overflow/viewport, e consolidar num PDF próprio:

player.html usa /css/player.css + /css/style.css; offline e páginas legais não carregam CSS local. Lendo os três arquivos completos, começando pelo style.css:

style.css primeira metade lida — já vi candidatos: --font-serif idêntica à sans (Google Fonts Inter/Playfair carregadas mas não usadas), navegação mobile desaparece sem substituto (<900px), elementos antigos escondidos com !important, sem :focus-visible. Lendo o restante:

style.css completo — o padrão é claro: um "apêndice de patches" com blocos duplicados em cascata (#discographyContainer 3×, .artist-banner-content com layouts contraditórios, #expandedPlayerModal 100% !important). Lendo player.css e admin.css:

player.css é bem melhor estruturado (:focus-visible, reduced-motion, safe-areas, dvh) — mas redefine :root conflitando com style.css, e tem o mesmo padrão de "bloco de correção v33.4" sobrescrevendo o original. Agora o admin.css:

Os três CSS lidos. Agora métricas e cruzamentos (classes definidas × usadas, variáveis, duplicatas, ordem das folhas no player.html):

Muitos IDs "fantasmas" — preciso distinguir criados dinamicamente (innerHTML) dos realmente ausentes:

O refinamento exagerou (81) — o correto é unir id="..." de template literals + .id=; os 35 do primeiro cruzamento são a lista real. Verificando como o index.html estrutura as seções e fechando o caso do modal.js:

modal.js confirma criação dinâmica (falso fantasma). Verificando quais IDs os scripts criam via property para fechar a lista real:

Descoberta grande: toda a "DISCOGRAFIA — FORÇA TOTAL" do CSS estiliza elementos que não existem (#discografia/#discographyContainer 0 ocorrências) — render dinâmico morto, site roda sobre HTML estático. Últimas verificações antes do teste funcional:

Material fechado. Agora o teste funcional com o browser headless — carregando a skill:

Sem overflow de página (mascarado pelo overflow-x:hidden global), mas body.scrollWidth=382 — há conteúdo cortado de 7px. Descobrindo o culpado e checando console:

Culpado do corte: .artist-avatar 350px — o #artistAvatar { width:350px !important } (L2981) anula a media query responsiva de 120px (L2522/L2561): bug visual real em celular causado pela guerra de !important. Sem erros de console no index. Agora o player.html:

Testes funcionais fechados (index: avatar cortado em 375px; player: OK; 0 erros de console; admin oculto pré-login). Calculando contrastes críticos e montando o relatório:

Contrastes: gold 0.55 = 3.48:1 (falha WCAG), time-info 4.45 marginal. Escrevendo os módulos de achados:

Gerando o corpo do relatório CSS/JS:

O literal <link> no texto virou tag para o ReportLab. Corrigindo:

17 páginas, última OK. Capa + merge + QA:

PDF fechado (fontes OK). Agora o style.css corrigido + validação headless da correção:

Correção validada em browser: avatar 350px→120px, sem clip (bodyW 375 = innerW). README do pacote + visual check do PDF:

Visual aprovado (capa, matriz dos 13 + herdados, achado com patch, capítulo JS). Limpeza e verificação final dos entregáveis:

Auditoria das pastas public/css e public/js concluída — mesma linha das anteriores (leitura integral, métricas automatizadas, verificação em browser headless, PDF + patch).

Veredito: 13 achados — 3 P1 · 10 P2 (+30 de JS herdados do relatório do repo, todos válidos)
O style.css (3.468 linhas) é um arquivo-guerra: 458 !important, 79 seletores duplicados (#discographyContainer .album-grid aparece 13×). Isso produziu um bug visual real, medido em browser:

C-01 (P1) — #artistAvatar { width:350px !important } anula a media query de 120px: em 375px o avatar renderiza 350px e é cortado 7px fora da tela (bounding box right=382px; o overflow-x:hidden global mascara o estouro).
C-02 (P1) — ~600 linhas (17% do CSS) de CSS morto: toda a seção "DISCOGRAFIA — FORÇA TOTAL" estiliza #discografia/#discographyContainer/#filterBar, que têm zero ocorrências no index.html — rastro de um render dinâmico abandonado no meio (o site roda sobre HTML estático).
C-03 (P1) — navegação mobile inexistente: abaixo de 900px o menu some e nada o substitui (sem hambúrguer) — celular sem navegação, busca ou CTA de assinatura.
Destaques P2: Inter/Playfair carregadas para todo visitante mas usadas só no painel (site em Segoe UI, --font-serif idêntica à sans); tokens conflitantes (--danger/--text-dim diferentes entre folhas); contraste 3.48:1 (falha WCAG) nos metadados dourados, sem :focus-visible/reduced-motion no site; player expandido que colapsa a lista de faixas entre 900-1200px (colunas fixas 550px+400px).

JS: além dos 30 achados já entregues, três novos — 27 IDs fantasmas (buscados por getElementById, não existem no HTML nem são criados: #albumModal → modal de álbum com curtir/compartilhar/alugar por faixa morto em cadeia; #newsletterForm → listener sem alvo; #heroTitle/#contato* → conteúdo dinâmico nunca aplicado), 95 classes usadas sem definição, e a confirmação de que o contêiner de toast do painel está pronto e implementado — a correção do feedback é remover uma delegação (JS-03).

No positivo: player.css e admin.css são bem construídos (foco visível, reduced-motion, safe-areas, dvh, zero !important no admin) e o player dedicado passou limpo no teste headless a 375px (sem overflow, sem erros de console).

Entregáveis
Auditoria-css-js.pdf — relatório (18 páginas): escopo/método, pontos fortes, matriz dos 13 + tabela dos 30 herdados, achados com linhas e patches, teste headless, métricas por folha e plano de ação. QA e visual aprovados.
jm-css-corrigido/ — public/css/style.css com 3 correções (C-01 avatar responsivo, C-07 contraste AA + foco global, C-08 colunas elásticas), validadas em browser após a correção (avatar 120px, body.scrollWidth 375 = viewport, sem clip).
capa-css-js.html — fonte HTML da capa.
Os patches de JS continuam no joseph-matthos-corrigido/ da auditoria anterior; decisões de produto (reconectar o render dinâmico × deletar ~600 linhas órfãs; menu mobile) ficam documentadas com wireframe no PDF.

Generated files
4
HTML
capa-css-js
· html
Markdown
README-CORRECOES-CSS
· md
File
style
· css
PDF
Auditoria-css-js
· pdf
Radio.js audite 

Thought Process
Auditoria dedicada ao radio.js (342 linhas). Começando pela leitura integral e o mapa de consumo (quem carrega, quais endpoints chama, como o backend responde):

radio.js lido integralmente. Módulo ES com export — a pergunta central agora é quem o importa, e se as dependências que ele exige (isPremium, collectAllTracks, openModal) e o consumidor da fila (player.js lendo radio_queue) existem:

Achado estrutural já confirmado: player.js tem zero referências a rádio — não lê radio_queue, nem ?radio=true. E o site.js importa o módulo e conecta #navRadioLink. Agora as dependências no site.js (isPremium, openModal), o collectAllTracks, o destino do #radioModal, e a estrutura de fila do player para desenhar o patch de integração:

O mapa revelou a chave do caso: o site.js passa 14 dependências ao initRadio — incluindo setQueue, getQueue, playFromDiscography — e o radio.js só valida e usa 3 (isPremium, collectAllTracks, openModal). Os hooks para injetar a fila no player do site existem e nunca são chamados. Verificando playFromDiscography/nextTrack (para o patch) e se o pacote anterior já corrige o gate premium (F-01):

nextTrack do site não faz loop (audio.pause() no fim) — a promessa "sem parar" do modal não existe em código nenhum. Para desenhar o patch de loop preciso do corpo completo de playFromDiscography (o que ele faz com a fila quando não é fromQueue):

Confirmado: playFromDiscography sem fromQueue reconstrói a fila pelo álbum — o patch deve chamar com {fromQueue:true}. E o site.js corrigido do pacote anterior já resolve o F-01 (SITE.user.plan = json.plan, L325) → o gate premium volta a reconhecer assinantes. Agora escrevo o radio.patched.js com a correção central (injetar a fila no player do site via as deps que já existem, em vez do redirect para um player que ignora tudo) + loop "sem parar" real + toast + guard bfcache:

Patch escrito (355 linhas). Verificando sintaxe (import em Node) e montando o teste funcional com servidor HTTP — primeiro o fluxo atual para documentar o beco sem saída, depois o fluxo corrigido:

Gate confirmado na prática (alert + plansModal empilhados — R-05b). Agora o fluxo premium do módulo atual para documentar o beco sem saída:

Evidência capturada: URL ?radio=true, fila órfã de 3 itens no sessionStorage, audio.src = NENHUM, mini-player "Nenhuma música" — o player dedicado ignora tudo. Agora o teste do módulo corrigido (porta 8902, cópia com o patch):

Patch totalmente validado: fila embaralhada injetada (3 únicos de 4), playFromDiscography(a1,t2,{fromQueue:true}), avanço no meio → false, fim da fila → replay + true ("sem parar" real), sem navegação, sem alert. Teste final do gate com toast e do guard reutilizável:

Diagnóstico: toastUsed:false mas alertStillEmpty:true — notify não caiu em nenhum caminho visível. Re-testando isoladamente para descobrir:

Falso alarme confirmado — o teste isolado mostra toasts:[msg], alerts:[]: o gate usa toast corretamente (o toastUsed:false anterior foi artefato do script de teste). Bateria de testes completa. Consolidando achados e gerando o relatório:

Agora o gerador do corpo, adaptado do da auditoria CSS/JS:

Corpo de 11 páginas OK (última com 1728 chars). Capa + merge + QA:

Camino relativo quebrou no meio — refazendo com caminhos absolutos:

O cwd tinha resetado para /home/z/my-project — capa vazia e merge não rodou. Refazendo tudo com caminhos absolutos:

Capa real (93.9 KB) e merge OK, mas font.check acusa 1 problema — provavelmente o emoji 📻 dentro do código do patch citado no PDF. Verificando e corrigindo:

PDF final 12 páginas, fontes OK. Visual check das páginas-chave:

Visual aprovado (capa, matriz dos 7, tabela funcional). Finalizando: README de aplicação, cópia da capa e limpeza:

Auditoria dedicada ao radio.js concluída — veredito em uma frase: o módulo está bem escrito, mas a integração com o player nunca foi fechada: a rádio não toca em página nenhuma.

Veredito: 7 achados — 2 P1 · 4 P2 · 1 design
R-01 (P1) — openRadioModal valida premium, embaralha o catálogo, salva a fila em sessionStorage e redireciona para /player.html?radio=true (L277) — mas o player.js tem zero referências a rádio (radio_queue/radio_index/?radio=true: 0 ocorrências). Evidência capturada em browser: chega-se ao player com a fila órfã no storage, audio.src vazio e "Nenhuma música" no mini-player. A ironia: o site.js injeta 14 dependências no initRadio — incluindo setQueue/getQueueIndex/playFromDiscography, os hooks exatos para tocar a fila no player do próprio site — e o radio.js usa apenas 3.
R-02 (P1, já mitigado) — o gate premium usa SITE.user?.plan (herda o F-01): assinantes reais recebiam "exclusiva para assinantes Premium" + plansModal. O site.js corrigido do pacote anterior (L325) resolve — verificado.
R-03 (P2) — onRadioTrackEnded é stub que sempre retorna false e o nextTrack do site faz audio.pause() no fim: o "sem parar" do modal não existe em código nenhum. R-04 — o #radioModal completo no index.html nunca é aberto (0 referências). R-05 — 5 alert() nativos; o gate empilha alert + plansModal (reproduzido). R-06 — guard _radioOpening sem reset no sucesso/bfcache: botão morto ao voltar por Back. R-07 (design) — rádio 100% client-side (0 rotas em api/, 0 colunas no schema): decisão válida, registrada.
Correção entregue e validada em browser
O radio.patched.js ativa o "modo inline": injeta a fila via os hooks que o site já fornece, dispara a primeira faixa com playFromDiscography(..., {fromQueue:true}) — sem tocar em player.js —, implementa o loop real ("sem parar"), troca alerts por toast e conserta o guard. Bateria de testes (HTTP local + espiões): fila embaralhada 4→3 únicos injetada sem navegação ✓, avanço no meio → false / fim → replay + true ✓, gate por toast sem alert ✓, reabertura [true, true] ✓, sintaxe via import ESM ✓. API pública intacta.

Entregáveis
Auditoria-radio-js.pdf — 12 páginas: anatomia e pontos fortes do módulo, matriz, achados com linhas e patches, tabela da verificação funcional (5 cenários) e plano de ação. QA e visual aprovados.
radio.patched.js + README-RADIO.md — arquivo corrigido e instruções de aplicação (requer o site.js do pacote anterior para o gate premium).
capa-radio.html — fonte da capa.
Backlog documentado: reconectar/remover o #radioModal morto (decisão de produto) e, se um dia a rádio no player dedicado for desejada, ler radio_queue no bootPlayer — o modo inline dispensa.

Generated files
4
HTML
capa-radio
· html
Markdown
README-RADIO
· md
PDF
Auditoria-radio-js
· pdf
File
radio.patched
· js
Send a Message


Chat controls
File
radio.patched.js
/* ============================================================
   js/radio.js — Rádio Joseph Matthos (CORRIGIDO — v2)
   ------------------------------------------------------------
   Auditoria 26/11/2026 — correções aplicadas sobre o original:
   R-01 (P1): a fila agora é INJETADA no player do site via as
       dependências que o site.js já fornece (setQueue +
       playFromDiscography) em vez de redirecionar para
       /player.html?radio=true — página que não lê nenhuma chave
       de rádio (beco sem saída). Modo legado mantido como
       fallback documentado.
   R-03 (P2): onRadioTrackEnded agora implementado — no fim da
       fila, a rádio REINICIA do começo ("sem parar" real) e
       devolve true para o site não avançar por cima.
   R-05 (P2): feedback via deps.toast (fallback alert); o gate
       premium não empilha mais alert + plansModal.
   R-06 (P2): _radioOpening é resetado em pageshow (bfcache) e
       antes da navegação no modo legado — botão não morre após
       voltar por Back.
   API pública preservada: initRadio, openRadioModal,
   onRadioTrackEnded, syncRadioOnTrackChange, isRadioActive,
   resetRadio. Dependências opcionais aceitas: setQueue,
   playFromDiscography, getQueue, getQueueIndex, setQueueIndex,
   toast.
   ============================================================ */

'use strict';

const RADIO_STORAGE = {
  queue: 'radio_queue',
  index: 'radio_index',
  active: 'radio_active'
};

let _deps = null;
let _radioOpening = false;
let _radioActive = false;
let _inlineMode = false;

/* ============================================================
   STORAGE
   ============================================================ */

function storageGet(key, fallback = null) {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch (error) {
    console.warn('[radio] Falha ao acessar sessionStorage:', error);
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    sessionStorage.setItem(key, String(value));
    return true;
  } catch (error) {
    console.error('[radio] Falha ao salvar sessão:', error);
    return false;
  }
}

function storageRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch (error) {
    console.warn('[radio] Falha ao remover sessão:', error);
  }
}

/* ============================================================
   FEEDBACK (R-05)
   ============================================================ */

function notify(message) {
  if (_deps && typeof _deps.toast === 'function') {
    try {
      _deps.toast(message, '📻');
      return;
    } catch (error) {
      console.warn('[radio] toast falhou, usando alert:', error);
    }
  }
  alert(message);
}

/* ============================================================
   DEPENDÊNCIAS
   ============================================================ */

export function initRadio(deps) {
  if (!deps || typeof deps !== 'object') {
    console.error('[radio] Dependências inválidas.');
    _deps = null;
    return false;
  }

  const required = [
    'isPremium',
    'collectAllTracks',
    'openModal'
  ];

  const missing = required.filter(
    key => typeof deps[key] !== 'function'
  );

  if (missing.length) {
    console.error(
      '[radio] Dependências ausentes:',
      missing.join(', ')
    );

    _deps = null;
    return false;
  }

  _deps = deps;

  // R-01: modo inline — o site fornece os hooks do player próprio.
  _inlineMode =
    typeof deps.setQueue === 'function' &&
    typeof deps.playFromDiscography === 'function';

  _radioActive = storageGet(RADIO_STORAGE.active) === 'true';

  // R-06: voltar por Back (bfcache) restaurava a página com o
  // guard de cliques travado — resetar quando a página reaparece.
  window.addEventListener('pageshow', () => {
    _radioOpening = false;
  });

  if (!_inlineMode) {
    console.warn(
      '[radio] Modo legado: hooks do player (setQueue/playFromDiscography) ' +
      'ausentes — a fila será salva e o navegador redirecionado. ' +
      'Sem consumo do lado do player, a rádio não toca.'
    );
  }

  return true;
}

/* ============================================================
   EMBARALHAMENTO
   ============================================================ */

function shuffleTracks(tracks) {
  const result = tracks.slice();

  if (_deps && typeof _deps.shuffleArray === 'function') {
    const shuffled = _deps.shuffleArray(result.slice());

    if (Array.isArray(shuffled) && shuffled.length === result.length) {
      return shuffled;
    }
  }

  // Fisher-Yates como alternativa.
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

/* ============================================================
   NORMALIZAÇÃO DA FILA
   ============================================================ */

function normalizeTrack(track) {
  if (!track || typeof track !== 'object') {
    return null;
  }

  const trackId = track.trackId ?? track.id;

  if (
    trackId === undefined ||
    trackId === null ||
    String(trackId).trim() === ''
  ) {
    return null;
  }

  const albumId = track.albumId;

  if (
    albumId === undefined ||
    albumId === null ||
    String(albumId).trim() === ''
  ) {
    return null;
  }

  const trackIndex = Number(
    track.trackIndex ?? track.trackNumber
  );

  return {
    albumId: String(albumId),
    trackId: String(trackId),
    trackIndex: Number.isInteger(trackIndex)
      ? trackIndex
      : null
  };
}

/* ============================================================
   ABRIR RÁDIO
   ============================================================ */

export function openRadioModal() {
  if (_radioOpening) return false;

  const deps = _deps;

  if (!deps) {
    console.error('[radio] Rádio não inicializada.');
    return false;
  }

  try {
    _radioOpening = true;

    // Verifica assinatura (R-05: toast em vez de alert duplo).
    const premium = deps.isPremium();

    if (premium !== true) {
      _radioOpening = false;

      notify(
        'A Rádio Joseph Matthos é exclusiva para assinantes Premium.'
      );

      deps.openModal('plansModal');

      return false;
    }

    // Recupera o catálogo.
    const allTracks = deps.collectAllTracks();

    if (!Array.isArray(allTracks) || !allTracks.length) {
      notify(
        'Nenhuma faixa publicada disponível para a rádio.'
      );

      _radioOpening = false;
      return false;
    }

    // Normaliza e elimina faixas inválidas.
    const validTracks = allTracks
      .map(normalizeTrack)
      .filter(Boolean);

    if (!validTracks.length) {
      console.error(
        '[radio] Nenhuma faixa possui identificadores válidos.',
        allTracks
      );

      notify(
        'Não foi possível montar a rádio. O catálogo precisa ser verificado.'
      );

      _radioOpening = false;
      return false;
    }

    // Evita IDs duplicados.
    const uniqueTracks = Array.from(
      new Map(
        validTracks.map(track => [
          track.trackId,
          track
        ])
      ).values()
    );

    // Embaralha.
    const queue = shuffleTracks(uniqueTracks);

    // Confirma a estrutura esperada pelo player.
    const playerQueue = queue.map(track => ({
      albumId: track.albumId,
      trackId: track.trackId,
      trackIndex: track.trackIndex
    }));

    // ── R-01: modo inline — injeta a fila no player do site ──
    if (_inlineMode) {
      deps.setQueue(playerQueue);

      if (typeof deps.setQueueIndex === 'function') {
        deps.setQueueIndex(0);
      }

      _radioActive = true;
      storageSet(RADIO_STORAGE.queue, JSON.stringify(playerQueue));
      storageSet(RADIO_STORAGE.index, '0');
      storageSet(RADIO_STORAGE.active, 'true');

      const first = playerQueue[0];

      // fromQueue:true preserva a fila injetada — sem isso o site
      // reconstruiria a fila pelo álbum (buildQueueForAlbum).
      deps.playFromDiscography(first.albumId, first.trackId, {
        fromQueue: true
      });

      _radioOpening = false;
      return true;
    }

    // ── Modo legado (sem hooks do player) ──
    const savedQueue = storageSet(
      RADIO_STORAGE.queue,
      JSON.stringify(playerQueue)
    );

    const savedIndex = storageSet(
      RADIO_STORAGE.index,
      '0'
    );

    const savedActive = storageSet(
      RADIO_STORAGE.active,
      'true'
    );

    if (!savedQueue || !savedIndex || !savedActive) {
      resetRadio();

      notify(
        'Não foi possível iniciar a rádio. Verifique o armazenamento do navegador.'
      );

      _radioOpening = false;
      return false;
    }

    _radioActive = true;

    // R-06: reset antes de navegar — se o redirecionamento falhar
    // (ou for bloqueado), o botão continua utilizável.
    _radioOpening = false;

    // Redireciona para o player.
    window.location.assign('/player.html?radio=true');

    return true;

  } catch (error) {
    console.error(
      '[radio] Erro ao iniciar rádio:',
      error
    );

    _radioOpening = false;

    notify(
      'Ocorreu um erro ao iniciar a Rádio Joseph Matthos.'
    );

    return false;
  }
}

/* ============================================================
   CONTROLE DE REPRODUÇÃO
   ============================================================ */

export function onRadioTrackEnded() {
  // R-03: continuação real. O site chama isto no 'ended' do áudio:
  //   if (isRadioActive() && onRadioTrackEnded()) return;
  //   nextTrack();
  // No meio da fila devolvemos false (o nextTrack do site avança
  // pela fila injetada). No FIM da fila a rádio reinicia do começo
  // ("sem parar") e devolvemos true para o site não sobrepor.
  if (!_radioActive || !_deps || !_inlineMode) return false;

  const getQueue = _deps.getQueue;
  const getIndex = _deps.getQueueIndex;

  if (typeof getQueue !== 'function' || typeof getIndex !== 'function') {
    return false;
  }

  const queue = getQueue();

  if (!Array.isArray(queue) || !queue.length) return false;

  const index = getIndex();

  if (!Number.isInteger(index) || index < 0) return false;

  if (index < queue.length - 1) return false;

  const first = queue[0];

  if (
    !first ||
    typeof _deps.setQueueIndex !== 'function' ||
    typeof _deps.playFromDiscography !== 'function'
  ) {
    return false;
  }

  try {
    _deps.setQueueIndex(0);
    _deps.playFromDiscography(first.albumId, first.trackId, {
      fromQueue: true
    });
    return true;
  } catch (error) {
    console.error('[radio] Falha ao reiniciar a rádio:', error);
    return false;
  }
}

export function syncRadioOnTrackChange() {
  // A sincronização de índice é controlada pelo player do site.
  return false;
}

/* ============================================================
   ESTADO
   ============================================================ */

export function isRadioActive() {
  const params = new URLSearchParams(
    window.location.search
  );

  if (params.get('radio') === 'true') {
    return true;
  }

  return (
    _radioActive ||
    storageGet(RADIO_STORAGE.active) === 'true'
  );
}

/* ============================================================
   ENCERRAR RÁDIO
   ============================================================ */

export function resetRadio() {
  _radioActive = false;
  _radioOpening = false;

  storageRemove(RADIO_STORAGE.queue);
  storageRemove(RADIO_STORAGE.index);
  storageRemove(RADIO_STORAGE.active);

  return true;
       }
