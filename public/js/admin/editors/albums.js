/* ============================================================
   js/admin/editors/albums.js — v10.4 (Audit-Ready + MP-03: player único)
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
   ============================================================
   v10.3 — patches da auditoria de 2026-11-26 aplicados:
   A-01/A-02 drag&drop seguro + DOM otimista · A-03 anti-duplo-clique
   A-04 ids de álbum normalizados · A-05 type=full nos downloads
   A-06 volume inicial 0.8 · A-07 normalizeTrack (snake→camel)
   A-08 letras com linhas em branco · A-09 guarda res.track.id
   A-10 observer desconecta sempre · A-11 fallback de versão prev/next
   A-12 sem URLs assinadas em logs · A-13 debug global sob flag
   A-16 assinatura AAC · A-17 reset versions · A-18 capa sem handler inline
   A-19 lookup por dataset · A-20 guarda de remount · A-22 sem rethrow 401
   A-24 probe com timeout · A-26 código morto removido
   ============================================================
   MP-03 (2026-11-28): o player de teste (sp-player) foi REMOVIDO.
   Os chips P/F e o botão ▶ Ouvir tocam no miniplayer persistente
   (AdminMiniPlayer). O modal de faixa usa áudio próprio (sem barra).
   ============================================================
   UP-04 (2026-11-28) — discografia funcional:
   - Duração derivada de durationSeconds (antes sempre "—").
   - Preço exibido vem de rental_products (backend anexa priceCents).
   ============================================================ */

import { apiFetch } from '../api.js';
import { toast } from '../ui/toast.js';
import { esc, escAttr } from '../ui/dom.js';
import { AdminMiniPlayer } from '../miniplayer.js'; // MP-01/MP-03/MP-03/MP-03/MP-03
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
  if (file.type && !ALLOWED_AUDIO_TYPES.includes(file.type)) { // A-16: MIME estrito
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
      webm: () => bytesEq(header, 0, [0x1A, 0x45, 0xDF, 0xA3]),
      aac:  () => bytesEq(header, 0, [0x41, 0x44, 0x49, 0x46])        // A-16: ADIF
            || (header[0] === 0xFF && (header[1] & 0xF0) === 0xF0)   // A-16: ADTS
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
    entries = trimmed.split('\n') // A-08: linhas em branco não invalidam a letra
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((text, index) => ({ time: index * 4, text }));
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
    : (track.fullPath || track.full_path || track.streamKey || track.stream_key); // DL-01

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

  const existingBody = container.querySelector('[data-albums-body]');
  if (container.dataset.mounted === '1' && existingBody) { // A-20
    paintBody(existingBody);
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
    State.albums = (Array.isArray(res?.albums) ? res.albums : []) // A-04
      .map((a) => ({ ...a, id: String(a.id) }));

    await Promise.all(
      Array.from(State.expandedAlbumIds).map((id) => loadTracksForAlbum(id))
    );
  } catch (err) {
    if (currentReq !== State.loadReqId) return;
    if (err?.status === 401 || err?.status === 403) {
      toast('Sessão expirada.', '⚠');
      return; // A-22: chamadores de clique não tratam rejection
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

// A-07 + UP-04: normaliza snake_case/camelCase, ids e DERIVA a duração
// (o backend guarda durationSeconds; a UI usa mm:ss — antes mostrava "—")
function secondsToDuration(s) {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) return '';
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function normalizeTrack(t) {
  if (!t || typeof t !== 'object') return t;
  return {
    ...t,
    id: String(t.id),
    previewPath: t.previewPath ?? t.preview_path ?? null,
    fullPath:    t.fullPath    ?? t.full_path    ?? null,
    streamKey:   t.streamKey   ?? t.stream_key   ?? null,
    priceCents:  t.priceCents  ?? t.price_cents  ?? 0,
    trackNumber: t.trackNumber ?? t.track_index ?? 0,
    duration: (typeof t.duration === 'string' && t.duration.trim())
      ? t.duration
      : secondsToDuration(t.durationSeconds ?? t.duration_seconds)
  };
}

async function loadTracksForAlbum(albumId) {
  const key = String(albumId); // A-04: chave sempre string
  const reqId = (State.tracksReqId.get(key) || 0) + 1;
  State.tracksReqId.set(key, reqId);

  try {
    const res = await apiFetch('tracks', { method: 'GET', query: { albumId: key } });
    if ((State.tracksReqId.get(key) || 0) !== reqId) return;
    State.tracks.set(key, (Array.isArray(res?.tracks) ? res.tracks : []).map(normalizeTrack));
  } catch (err) {
    if ((State.tracksReqId.get(key) || 0) !== reqId) return;
    console.warn(`[albums] falha faixas ${albumId}:`, err);
    State.tracks.set(key, { error: err?.message || 'Erro ao carregar faixas.' });
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

        const mpAlbum = AdminMiniPlayer.current(); // MP-03
        if (mpAlbum && String(mpAlbum.albumId) === String(albumId)) AdminMiniPlayer.close();
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

  scope.querySelectorAll('[data-album-queue]').forEach((btn) => { // MP-01
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      queueAlbum(btn.dataset.albumQueue, null);
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
  scope.querySelectorAll('[data-track-play]').forEach((btn) => { // MP-03: miniplayer
    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      const trackId = String(btn.dataset.trackPlay);
      const albumId = String(btn.dataset.trackAlbum);
      const requestedVersion = btn.dataset.playVersion || null;

      const cur = AdminMiniPlayer.current();
      if (cur && String(cur.id) === trackId && String(cur.albumId) === String(albumId)) {
        if (requestedVersion && requestedVersion !== cur.version) {
          AdminMiniPlayer.setVersion(requestedVersion);
          return;
        }
        AdminMiniPlayer.toggle(); // mesmo chip de novo = pausar/retomar
        return;
      }
      await queueAlbum(albumId, trackId, requestedVersion);
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

        const mpTrack = AdminMiniPlayer.current(); // MP-03
        if (mpTrack && String(mpTrack.id) === String(trackId)) AdminMiniPlayer.close();
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

  scope.querySelectorAll('[data-track-queue]').forEach((btn) => { // MP-01
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      queueAlbum(btn.dataset.trackAlbum, btn.dataset.trackQueue);
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
// MP-03 — Prévia do modal de faixas (áudio próprio; sem barra antiga)
// ─────────────────────────────────────────────────────────────
let _modalAudio = null;

function stopModalAudio() {
  if (_modalAudio) {
    try { _modalAudio.pause(); _modalAudio.removeAttribute('src'); try { _modalAudio.load(); } catch {} } catch {}
  }
}

// Miniplayer assumiu → para o áudio do modal (só um som por vez)
document.addEventListener('admin-miniplayer:start', stopModalAudio);

async function playExternal(url) {
  try {
    AdminMiniPlayer.pause(); // modal assumiu → miniplayer pausa
    if (!_modalAudio) { _modalAudio = new Audio(); _modalAudio.preload = 'auto'; }
    _modalAudio.pause();
    _modalAudio.src = url;
    await _modalAudio.play();
  } catch {
    toast('Falha ao reproduzir.', '⚠');
  }
}

// MP-03: repinta os chips P/F e botões ▶ Ouvir quando o miniplayer muda
document.addEventListener('admin-miniplayer:state', () => { try { repaint(); } catch {} });

// ─────────────────────────────────────────────────────────────
// Download — faixa individual
// ─────────────────────────────────────────────────────────────
async function downloadTrack(trackId, titleHint) {
  if (!trackId) return;
  const btn = Array.from(document.querySelectorAll('[data-track-download]'))
    .find((b) => b.dataset.trackDownload === String(trackId)); // A-19
  const originalHtml = btn?.innerHTML;

  try {
    if (btn) { btn.disabled = true; btn.textContent = '⬇ …'; }
    const res = await apiFetch('download-url', { // A-05: exige a versão completa
      method: 'GET', query: { id: String(trackId), type: 'full' }
    });
    if (!res?.ok || !res.url) throw new Error(res?.error || 'Falha ao gerar URL.');
    const ok = await triggerDownload(res.url, res.filename || `${titleHint || trackId}.mp3`); // UP-04: blob
    if (ok) toast(`Download iniciado: ${titleHint || trackId}`, '⬇');
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
    const res = await apiFetch('download-album', { // A-05: contrato explícito
      method: 'GET', query: { id: String(albumId), type: 'full' }
    });
    if (!res?.ok || !Array.isArray(res.tracks)) throw new Error(res?.error || 'Falha ao listar faixas.');

    const valid = res.tracks.filter((t) => t.url);
    if (!valid.length) return toast('Este álbum não tem áudios completos.', '⚠');

    toast(`Disparando ${valid.length} download(s)...`, '⬇');
    let failures = 0;
    for (let i = 0; i < valid.length; i++) {
      const ok = await triggerDownload(valid[i].url, valid[i].filename || `${valid[i].title}.mp3`);
      if (!ok) failures++;
      await sleep(600);
    }

    if (failures) toast(`Concluído com ${failures} falha(s).`, '⚠');
    else toast(`${valid.length} downloads solicitados.`, '✓');
  } catch (err) {
    toast(err?.message || 'Falha ao baixar álbum.', '⚠');
  }
}

// UP-04: download via blob — o atributo `download` do <a> é IGNORADO pelo
// navegador quando a URL é cross-origin (URLs assinadas do R2), e o clique
// NAVIGAVA para o áudio em vez de salvar o arquivo. Com blob o download
// funciona para qualquer destino permitido.
async function triggerDownload(url, filename) {
  if (!isAllowedMediaUrl(url)) {
    toast('URL de download não autorizada.', '⚠');
    return false;
  }

  let objUrl = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}.`);
    const blob = await res.blob();
    objUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objUrl;
    a.download = filename || 'arquivo';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(objUrl); objUrl = null; }, 1500);
    return true;
  } catch (err) {
    toast(`Não foi possível baixar: ${err?.message || 'erro'}`, '⚠');
    if (objUrl) URL.revokeObjectURL(objUrl);
    return false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────
// MP-01 — Fila no miniplayer persistente
// ─────────────────────────────────────────────────────────────
async function queueAlbum(albumId, startTrackId, requestedVersion) { // MP-03
  const album = State.albums.find((a) => String(a.id) === String(albumId));
  let list = State.tracks.get(String(albumId));
  if (!Array.isArray(list) || !list.length) {
    try { await loadTracksForAlbum(albumId); } catch { /* segue com o que houver */ }
    list = State.tracks.get(String(albumId));
  }
  if (!Array.isArray(list) || !list.length) {
    return toast('Não consegui carregar as faixas do álbum.', '⚠');
  }
  const dtos = list.map((t) => ({
    id: t.id,
    title: t.title,
    trackNumber: t.trackNumber ?? t.track_index ?? 0,
    albumId: String(albumId),
    albumTitle: album?.title || '',
    coverUrl: album?.coverUrl || album?.cover_image || '',
    previewPath: t.previewPath ?? t.preview_path ?? null,
    fullPath: t.fullPath ?? t.full_path ?? null,
    streamKey: t.streamKey ?? t.stream_key ?? null
  })).filter((t) => t.previewPath || t.fullPath || t.streamKey);
  if (!dtos.length) return toast('Este álbum não tem áudios cadastrados.', '⚠');
  AdminMiniPlayer.setQueue(dtos, {
    startId: startTrackId || dtos[0].id,
    version: requestedVersion === 'full' ? 'full' : 'preview'
  });
}

function queueTrack(albumId, trackId) { return queueAlbum(albumId, trackId); }

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

    tbody.addEventListener('drop', async (e) => { // A-01/A-02: drop seguro + DOM otimista
      e.preventDefault();
      if (!_dragState) return;
      if (String(_dragState.albumId) !== String(albumId)) { cleanupDrag(scope); return; }

      const draggedRow = _dragState.row;
      cleanupDrag(scope);

      // A-01: linha órfã (repaint durante o arrasto) aborta sem corromper
      if (!tbody.contains(draggedRow)) return;
      const targetRow = e.target.closest('tr[data-track-id]');
      if (!targetRow || !tbody.contains(targetRow) || targetRow === draggedRow) return;

      const rows = Array.from(tbody.querySelectorAll('tr[data-track-id]'));
      if (rows.indexOf(draggedRow) < 0 || rows.indexOf(targetRow) < 0) return;

      const rect = targetRow.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;

      // A-02: reordena o DOM antes de persistir (estado visível = estado enviado)
      rows.splice(rows.indexOf(draggedRow), 1);
      let insertAt = rows.indexOf(targetRow);
      if (!isAbove) insertAt += 1;
      rows.splice(insertAt, 0, draggedRow);
      rows.forEach((row) => tbody.appendChild(row));

      const order = rows.map((row, i) => ({ id: String(row.dataset.trackId), track_number: i + 1 }));
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
  const tbody = Array.from(document.querySelectorAll('[data-tracks-body]'))
    .find((el) => el.dataset.tracksBody === String(albumId)); // A-19
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
          <button class="btn btn-ghost btn-sm" data-album-queue="${escAttr(album.id)}" type="button" title="Tocar álbum no miniplayer">▶ Tocar</button>
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

  const mpCur = AdminMiniPlayer.current(); // MP-03
  const isCurrent = mpCur
    && String(mpCur.id) === String(track.id)
    && String(mpCur.albumId) === String(albumId);
  const playing = isCurrent && !mpCur.paused;

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
                  data-track-queue="${escAttr(String(track.id))}"
                  data-track-album="${escAttr(albumId)}"
                  type="button" title="Tocar a partir daqui no miniplayer">＋ Fila</button>
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

  const albumSaveBtn = document.getElementById('albumSave');
  albumSaveBtn?.addEventListener('click', async () => {
    if (albumSaveBtn.disabled) return; // A-03
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

    albumSaveBtn.disabled = true; // A-03
    try {
      if (isNew) await apiFetch('albums', { method: 'POST', body: payload });
      else await apiFetch('album', { method: 'PATCH', query: { id: a.id }, body: payload });
      toast('Álbum salvo.', '💿');
      closeAdminModal();
      await loadAlbums();
    } catch (err) {
      if (errEl) errEl.textContent = err?.message || 'Falha ao salvar.';
    } finally {
      albumSaveBtn.disabled = false;
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
      <div class="form-group">
        <label>Preço do aluguel (centavos, 0 desativa)</label>
        <input type="number" id="trackPrice" value="${escAttr(String(t.priceCents ?? 0))}">
        <span class="hint" style="color:var(--text-dim);font-size:0.78rem;">UP-04: o preço cria/atualiza o produto de aluguel (72h por padrão) que o site cobra. Salve a faixa para aplicar.</span>
      </div>
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

  // Observer: quando o modal some, para qualquer reprodução de teste (correção #7)
  const modalObs = new MutationObserver(() => {
    if (document.getElementById('trackTitle')) return;
    modalObs.disconnect(); // A-10: desconecta em TODOS os caminhos
    stopModalAudio();
  });
  const modalRoot = document.querySelector('[data-admin-modal], .admin-modal') || document.body;
  modalObs.observe(modalRoot, { childList: true, subtree: true });

  bindTrackUpload({ buttonSel: '[data-upload-preview]', inputId: 'trackPreviewInput', statusSel: '[data-preview-status]', testSel: '[data-test-preview]', kind: 'audio-preview', uploadFn: uploadAudioPreview, field: 'previewPath', albumId, track: t });
  bindTrackUpload({ buttonSel: '[data-upload-full]',    inputId: 'trackFullInput',    statusSel: '[data-full-status]',    testSel: '[data-test-full]',    kind: 'audio-full',    uploadFn: uploadAudioFull,    field: 'fullPath',    albumId, track: t });

  const trackSaveBtn = document.getElementById('trackSave');
  trackSaveBtn?.addEventListener('click', async () => {
    if (trackSaveBtn.disabled) return; // A-03
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

    trackSaveBtn.disabled = true; // A-03
    try {
      if (isNew) {
        State.pendingOperations.set(`create-track-${albumId}`, opId);
        const res = await apiFetch('tracks', { method: 'POST', body: { ...payload, albumId } });
        if (State.pendingOperations.get(`create-track-${albumId}`) !== opId) return;
        State.pendingOperations.delete(`create-track-${albumId}`);
        if (!res?.track?.id) throw new Error('Backend não retornou o id da faixa criada.'); // A-09
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
    } finally {
      trackSaveBtn.disabled = false; // A-03
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Upload de Faixa
// ─────────────────────────────────────────────────────────────
function bindTrackUpload({ buttonSel, inputId, statusSel, testSel, kind, uploadFn, field, albumId, track }) {
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

      // A-01: o backend exige trackId OU (albumId + trackIndex) no upload-confirm
      const result = await uploadFn(file, (pct) => {
        if (statusEl) statusEl.innerHTML = `<span class="audio-chip">⬆ ${pct}%</span>`;
      }, { trackId: track.id });

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
        const probeTimeout = setTimeout(() => { probe.src = ''; }, 8000); // A-24
        probe.addEventListener('loadedmetadata', () => {
          clearTimeout(probeTimeout);
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
        probe.addEventListener('error', () => { clearTimeout(probeTimeout); probe.remove(); });
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
// Debug
// ─────────────────────────────────────────────────────────────
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') { // A-13
  window.__albums = { State, queueAlbum, getAdminAudioUrl, stopModalAudio, loadAlbums };
}
