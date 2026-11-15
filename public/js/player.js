// js/player.js — v32.9.1
// v32.9 → v32.9.1:
// - updateTabState: sincroniza tabindex (0/-1) das abas (WAI-ARIA APG)
// - Tablist: navegação por ArrowLeft/ArrowRight/Home/End
// - Progresso: aria-valuenow/aria-valuetext no mesmo setInterval (sem timer novo)
// - resetProgressUI e restorePlaybackSnapshot: reset/restaura ARIA
// - syncProgressUI(): seek por click/teclado atualiza ARIA com player pausado
// - renderPlayerTrackList: music-item focável (role=button, tabindex, Enter/Space)
// - renderPlaylistsTab: role/tabindex movidos de .playlist-info para .playlist-card
//   + guarda no delete (lixeira não abre a playlist)
// - setBuffering: sem alteração (já correto em #playerContainer)

'use strict';

const DEFAULT_COVER = '/assets/img/tema.webp';
const MAX_SHUFFLE_HISTORY = 50;
const MAX_PLAYLIST_TRACKS = 50;
const MAX_PLAYLIST_NAME = 100;
const AUDIO_PREPARE_TIMEOUT_MS = 20000;

// ─── UTILS ───
function formatTime(secs) {
  const v = Number(secs);
  if (!Number.isFinite(v) || v < 0) return '0:00';
  return `${Math.floor(v/60)}:${String(Math.floor(v%60)).padStart(2, '0')}`;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function normalizeTrackId(v) {
  if (v == null || typeof v === 'object') return null;
  const id = String(v).trim();
  if (!id || id.length > 128) return null;
  return id;
}
function normalizeCoverUrl(url, fallback = DEFAULT_COVER) {
  if (!url) return fallback;
  try {
    const p = new URL(url, window.location.origin);
    if (p.protocol === 'https:' || (p.protocol === 'http:' && window.location.hostname === 'localhost')) return p.href;
  } catch {}
  return fallback;
}
function isValidTrack(t) {
  if (!t || typeof t !== 'object') return false;
  if (!normalizeTrackId(t.id)) return false;
  if (typeof t.title !== 'string' || !t.title.trim()) return false;
  if (t.artist !== undefined && typeof t.artist !== 'string') return false;
  if (t.durationSeconds !== undefined && t.durationSeconds !== null && (!Number.isFinite(t.durationSeconds) || t.durationSeconds < 0)) return false;
  if (t.albumId !== undefined && t.albumId !== null && !normalizeTrackId(t.albumId)) return false;
  return true;
}
function formatDuration(sec, locked) {
  if (locked) return '🔒';
  if (sec === undefined || sec === null) return '--:--';
  if (sec === 0) return '0:00';
  return formatTime(sec);
}
function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function showToast(msg) {
  try {
    const ex = document.getElementById('playerToast');
    if (ex) ex.remove();
    const t = document.createElement('div');
    t.id = 'playerToast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('visible'));
    setTimeout(() => { t.classList.remove('visible'); setTimeout(() => t.remove(), 300); }, 2500);
  } catch (e) { console.warn('[player] Falha ao exibir toast:', e); }
}
function getLikeState(k) { try { return localStorage.getItem(k) === '1'; } catch { return false; } }
function setLikeState(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); return true; } catch { return false; } }

class AlbumError extends Error {
  constructor(msg, reason) { super(msg); this.name = 'AlbumError'; this.reason = reason; }
}
const NON_FALLBACK_ALBUM_REASONS = new Set([
  'auth', 'rate-limit', 'integrity', 'unknown', 'server', 'network'
]);
const AUTH_ALBUM_CODES = new Set([
  'ALBUM_PRIVATE', 'ACCESS_DENIED', 'ACCESS_FORBIDDEN',
  'SUBSCRIPTION_REQUIRED', 'PREMIUM_REQUIRED', 'FORBIDDEN'
]);

// ─── PLAYLIST STORAGE ───
function getPlaylists() {
  try {
    const data = JSON.parse(localStorage.getItem('jm_playlists') || '[]');
    if (!Array.isArray(data)) return [];
    const seen = new Set();
    const result = [];
    for (const p of data) {
      if (!p || typeof p !== 'object') continue;
      const id = typeof p.id === 'string' ? p.id.trim() : '';
      const name = typeof p.name === 'string' ? p.name.trim().substring(0, MAX_PLAYLIST_NAME) : '';
      if (!id || id.length > 128 || !name || seen.has(id)) continue;
      seen.add(id);
      if (!Array.isArray(p.tracks)) continue;
      const ts = new Set();
      const tracks = [];
      for (const t of p.tracks) {
        const tid = normalizeTrackId(t);
        if (!tid || ts.has(tid)) continue;
        ts.add(tid);
        tracks.push(tid);
        if (tracks.length >= MAX_PLAYLIST_TRACKS) break;
      }
      result.push({ id, name, coverUrl: normalizeCoverUrl(p.coverUrl, ''), tracks });
    }
    return result;
  } catch { return []; }
}
function savePlaylists(pl) {
  try { localStorage.setItem('jm_playlists', JSON.stringify(pl)); return true; }
  catch { showToast('Erro ao salvar playlist.'); return false; }
}
function createPlaylistWithTrack(name, trackId) {
  const n = String(name || '').trim().substring(0, MAX_PLAYLIST_NAME);
  const tid = normalizeTrackId(trackId);
  if (!n || !tid) return null;
  const pl = getPlaylists();
  const p = { id: generateId(), name: n, tracks: [tid], coverUrl: '' };
  pl.push(p);
  if (!savePlaylists(pl)) return null;
  return p;
}
function createPlaylist(name) {
  const n = String(name || '').trim().substring(0, MAX_PLAYLIST_NAME);
  if (!n) return null;
  const pl = getPlaylists();
  const p = { id: generateId(), name: n, tracks: [], coverUrl: '' };
  pl.push(p);
  if (!savePlaylists(pl)) return null;
  return p;
}
function addTrackToPlaylist(id, trackId) {
  const pl = getPlaylists();
  const p = pl.find(x => x.id === id);
  const tid = normalizeTrackId(trackId);
  if (!p || !tid) return 'error';
  if (p.tracks.includes(tid)) return 'duplicate';
  if (p.tracks.length >= MAX_PLAYLIST_TRACKS) return 'limit_reached';
  p.tracks.push(tid);
  if (!savePlaylists(pl)) return 'error';
  return 'added';
}
function removePlaylist(id) {
  let pl = getPlaylists();
  if (!pl.some(p => p.id === id)) return false;
  pl = pl.filter(p => p.id !== id);
  return savePlaylists(pl);
}

// ─── ELS ───
const els = {
  container: document.getElementById('playerContainer'),
  cover: document.getElementById('playerCover'),
  title: document.getElementById('playerTitle'),
  artist: document.getElementById('playerArtist'),
  playBtn: document.getElementById('playBtn'),
  playIcon: document.getElementById('playIcon'),
  progressBar: document.getElementById('progressBar'),
  progressFill: document.getElementById('progressFill'),
  currentTime: document.getElementById('currentTime'),
  duration: document.getElementById('duration'),
  musicList: document.getElementById('musicList'),
  albumHeaderCover: document.getElementById('albumHeaderCover'),
  albumHeaderTitle: document.getElementById('albumHeaderTitle'),
  albumHeaderArtist: document.getElementById('albumHeaderArtist'),
  albumHeaderCount: document.getElementById('albumHeaderCount'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  repeatBtn: document.getElementById('repeatBtn'),
  miniPlayer: document.getElementById('miniPlayer'),
  miniCover: document.getElementById('miniCover'),
  miniTitle: document.getElementById('miniTitle'),
  miniArtist: document.getElementById('miniArtist'),
  miniPlayBtn: document.getElementById('miniPlayBtn'),
  miniNextBtn: document.getElementById('miniNextBtn'),
  miniPrevBtn: document.getElementById('miniPrevBtn'),
  miniOpenBtn: document.getElementById('miniOpenBtn'),
  playlistsContainer: document.getElementById('playlistsContainer')
};

// ─── STATE ───
let currentAudio = null;
let currentTrackId = null;
let currentTrackMeta = null;
let currentPlaybackContext = null;
let selectedCatalogContext = null;

let shuffleQueue = [];
let shuffleHistory = [];
let shuffleHistoryIndex = -1;
let shuffleEnabled = false;
let repeatMode = 'off';

let playbackRequestId = 0;
let catalogRequestId = 0;
let navigationRequestId = 0;
let commitRequestId = 0;
let activeRestoreId = 0;
let playbackAbortController = null;
let catalogAbortController = null;
let updateInterval = null;
let isBuffering = false;
let isBooted = false;

const snapshotRefs = new Map();

function createPlaybackRequest() {
  if (playbackAbortController) { try { playbackAbortController.abort(); } catch {} }
  playbackAbortController = new AbortController();
  return playbackAbortController;
}
function createCatalogRequest() {
  if (catalogAbortController) { try { catalogAbortController.abort(); } catch {} }
  catalogAbortController = new AbortController();
  return catalogAbortController;
}
function safeDisposeAudio(audio) {
  if (!audio) return;
  if (audio === currentAudio) return;
  if ((snapshotRefs.get(audio) || 0) > 0) return;
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch {}
}
function registerSnapshot(snapshot) {
  const audio = snapshot?.audio;
  if (!audio) return;
  snapshotRefs.set(audio, (snapshotRefs.get(audio) || 0) + 1);
}
function releaseSnapshot(snapshot) {
  const audio = snapshot?.audio;
  if (!audio) return;
  if (snapshot.released) return;
  snapshot.released = true;
  const count = snapshotRefs.get(audio) || 0;
  if (count <= 1) snapshotRefs.delete(audio);
  else snapshotRefs.set(audio, count - 1);
}
function releaseAndDisposeSnapshot(snapshot) {
  if (!snapshot?.audio) return;
  const audio = snapshot.audio;
  releaseSnapshot(snapshot);
  safeDisposeAudio(audio);
}

async function fetchInBatches(ids, signal, fn, chunk = 3) {
  const out = [];
  for (let i = 0; i < ids.length; i += chunk) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    out.push(...(await Promise.all(ids.slice(i, i + chunk).map(id => fn(id, signal)))));
  }
  return out;
}
function generateShuffleQueue(tracks, currentId) {
  const seen = new Set();
  const idx = [];
  for (let i = 0; i < tracks.length; i++) {
    const id = String(tracks[i].id);
    if (id === String(currentId) || seen.has(id)) continue;
    seen.add(id);
    idx.push(i);
  }
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}
function initShuffleState(context, trackId) {
  if (!shuffleEnabled || !context || context.tracks.length <= 1) {
    shuffleQueue = [];
    shuffleHistory = trackId ? [String(trackId)] : [];
    shuffleHistoryIndex = trackId ? 0 : -1;
    return;
  }
  shuffleQueue = generateShuffleQueue(context.tracks, trackId);
  shuffleHistory = [String(trackId)];
  shuffleHistoryIndex = 0;
}
function shouldAdvanceQueue(result) {
  if (!result || !result.committed) return false;
  if (result.playbackStarted) return true;
  return result.reason === 'not-allowed';
}
function setBuffering(value) {
  isBuffering = Boolean(value);
  if (els.container) els.container.classList.toggle('is-buffering', isBuffering);
}
function renderCurrentCatalog(highlightId = null) {
  const ctx = selectedCatalogContext || currentPlaybackContext;
  if (!ctx || !Array.isArray(ctx.tracks)) return;
  const belongs = highlightId != null && ctx.tracks.some(t => String(t.id) === String(highlightId));
  renderPlayerTrackList(ctx, belongs ? highlightId : null);
}
function setCatalogLoading(loading) {
  const targets = [els.musicList, document.getElementById('albumTracklistHeader')].filter(Boolean);
  for (const el of targets) {
    if (loading) {
      el.style.opacity = '0.5';
      el.style.pointerEvents = 'none';
      el.setAttribute('aria-busy', 'true');
    } else {
      el.style.opacity = '';
      el.style.pointerEvents = '';
      el.removeAttribute('aria-busy');
    }
  }
}

async function restorePlaybackSnapshot(snapshot, operationId, restoreId) {
  if (!snapshot) return { restored: false };

  releaseSnapshot(snapshot);
  currentAudio = snapshot.audio;
  currentTrackId = snapshot.trackId;
  currentTrackMeta = snapshot.trackMeta;
  currentPlaybackContext = snapshot.playbackContext;

  try { setBuffering(false); } catch (e) { console.warn('[player] setBuffering:', e); }
  if (snapshot.trackMeta) {
    try { updatePlayerUI(snapshot.trackMeta); } catch (e) { console.warn('[player] updatePlayerUI:', e); }
  }
  try { renderCurrentCatalog(snapshot.trackId); } catch (e) { console.warn('[player] renderCurrentCatalog:', e); }

  if (!snapshot.audio) {
    try { resetProgressUI(); } catch (e) { console.warn(e); }
    return { restored: true, playbackStarted: false };
  }

  try {
    if (Number.isFinite(snapshot.currentTime) && snapshot.currentTime >= 0) {
      snapshot.audio.currentTime = snapshot.currentTime;
    }
  } catch {}
  try {
    const dur = snapshot.audio.duration || 0;
    const cur = snapshot.audio.currentTime || 0;
    const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
    if (els.progressFill) els.progressFill.style.width = `${pct}%`;
    if (els.currentTime) els.currentTime.textContent = formatTime(cur);
    if (els.duration) els.duration.textContent = formatTime(dur);
    /* ← v32.9.1 — restaura ARIA junto com o visual */
    if (els.progressBar) {
      els.progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
      els.progressBar.setAttribute('aria-valuetext',
        `${formatTime(cur)} de ${formatTime(dur)}`);
    }
  } catch {}

  if (snapshot.wasPaused) {
    try {
      if (els.playIcon) els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
      if (els.miniPlayBtn) els.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    } catch {}
    return { restored: true, playbackStarted: false };
  }

  if (restoreId !== undefined && restoreId !== activeRestoreId) {
    return { restored: false, playbackStarted: false, reason: 'restore-revoked-before-play' };
  }

  const result = await attemptPlay(snapshot.audio);

  if (restoreId !== undefined && restoreId !== activeRestoreId) {
    if (currentAudio !== snapshot.audio) {
      try { snapshot.audio.pause(); } catch {}
    }
    return { restored: false, playbackStarted: false, reason: 'restore-revoked-after-play' };
  }

  return { restored: true, playbackStarted: result.started, reason: result.reason };
}

// ─── ABAS ───
const tabs = document.querySelectorAll('.mobile-tab');
const tabContents = document.querySelectorAll('.tab-content');
function updateTabState(activeTab) {
  const name = activeTab?.dataset.tab;
  if (!name) return;
  tabs.forEach(t => {
    const on = t === activeTab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.setAttribute('tabindex', on ? '0' : '-1');           /* ← v32.9.1 */
  });
  tabContents.forEach(c => {
    const on = c.id === `tab-${name}`;
    c.classList.toggle('active', on);
    c.hidden = !on;
  });
  if (els.miniPlayer) els.miniPlayer.style.display = (name !== 'player' && currentTrackId) ? 'flex' : 'none';
  if (name === 'albums') renderAlbumsTab();
  if (name === 'playlists') renderPlaylistsTab();
}
tabs.forEach(t => t.addEventListener('click', () => updateTabState(t)));

/* ← v32.9.1 — navegação por setas no tablist (WAI-ARIA APG) */
tabs.forEach((tab, idx) => {
  tab.addEventListener('keydown', (e) => {
    let next = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    tabs[next].focus();
    updateTabState(tabs[next]);
  });
});

function switchTab(name) { const b = document.querySelector(`.mobile-tab[data-tab="${name}"]`); if (b) updateTabState(b); }

// ─── CATÁLOGO ───
async function renderAlbumsTab() {
  const container = document.getElementById('albumsList');
  if (!container) return;
  const ctrl = createCatalogRequest();
  const reqId = ++catalogRequestId;
  container.innerHTML = '<p style="text-align:center;color:#aaa;padding:1rem;">Carregando...</p>';
  try {
    const res = await fetch('/api/public?t=' + Date.now(), { signal: ctrl.signal });
    if (!res.ok) throw new Error('Falha de rede');
    const data = await res.json();
    if (reqId !== catalogRequestId) return;
    if (!data.ok || !Array.isArray(data.albums)) throw new Error('Falha.');
    container.innerHTML = '';
    data.albums.forEach(album => {
      if (!album || !normalizeTrackId(album.id)) return;
      if (typeof album.title !== 'string' || !album.title.trim()) return;
      const card = document.createElement('div');
      card.className = 'album-card';
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Abrir álbum ${album.title}`);
      const img = document.createElement('img');
      img.src = normalizeCoverUrl(album.coverUrl); img.alt = '';
      const info = document.createElement('div'); info.className = 'album-info';
      const t = document.createElement('div'); t.className = 'album-title'; t.textContent = album.title;
      const s = document.createElement('div'); s.className = 'album-sub'; s.textContent = `${album.tracks?.length || 0} faixas`;
      info.append(t, s); card.append(img, info);
      card.addEventListener('click', () => window.abrirAlbum(album.id));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.abrirAlbum(album.id); } });
      container.appendChild(card);
    });
  } catch (e) {
    if (e.name === 'AbortError' || reqId !== catalogRequestId) return;
    container.innerHTML = `<p style="color:var(--danger);text-align:center;">${esc(e.message)}</p>`;
  }
}

function renderPlaylistsTab() {
  const c = els.playlistsContainer; if (!c) return;
  const pl = getPlaylists(); c.innerHTML = '';
  const h = document.createElement('div'); h.className = 'playlist-header';
  const t = document.createElement('h2'); t.textContent = 'Minhas Playlists'; h.appendChild(t);
  const b = document.createElement('button'); b.className = 'btn-new-playlist'; b.textContent = '+ Nova';
  b.setAttribute('aria-label', 'Criar nova playlist');
  b.addEventListener('click', () => window.criarPlaylistModal()); h.appendChild(b); c.appendChild(h);
  if (!pl.length) {
    const p = document.createElement('p'); p.style.cssText = 'text-align:center;color:#aaa;padding:2rem;';
    p.textContent = 'Nenhuma playlist criada.'; c.appendChild(p); return;
  }
  pl.forEach(p => {
    const card = document.createElement('div'); card.className = 'playlist-card';
    /* ← v32.9.1 — foco/role movidos de .playlist-info para .playlist-card */
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', `Abrir playlist ${p.name}`);
    const info = document.createElement('div'); info.className = 'playlist-info';
    const t = document.createElement('h3'); t.textContent = p.name;
    const s = document.createElement('p'); s.textContent = `${p.tracks.length} faixas`;
    info.append(t, s);
    /* ← v32.9.1 — clique/teclado no card; lixeira não abre */
    card.addEventListener('click', (e) => {
      if (e.target.closest('.playlist-delete-btn')) return;
      window.abrirPlaylist(p.id);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.abrirPlaylist(p.id); }
    });
    const d = document.createElement('button'); d.className = 'playlist-delete-btn'; d.title = 'Excluir'; d.setAttribute('aria-label', `Excluir playlist ${p.name}`); d.textContent = '🗑️';
    d.addEventListener('click', (e) => { e.stopPropagation(); window.deletarPlaylist(p.id); });
    card.append(info, d); c.appendChild(card);
  });
}

window.criarPlaylistModal = () => {
  const n = prompt('Nome da nova playlist:');
  if (n && n.trim()) { const c = createPlaylist(n); if (c) { renderPlaylistsTab(); showToast('Playlist criada!'); } else showToast('Erro.'); }
};
window.deletarPlaylist = (id) => {
  if (confirm('Excluir esta playlist?')) { if (removePlaylist(id)) { renderPlaylistsTab(); showToast('Excluída.'); } else showToast('Erro.'); }
};
window.editarCapaPlaylist = (id) => {
  const pl = getPlaylists(); const p = pl.find(x => x.id === id); if (!p) return;
  const n = prompt('URL da capa:', p.coverUrl || '');
  if (n !== null) { p.coverUrl = normalizeCoverUrl(n.trim(), ''); if (savePlaylists(pl)) { showToast('Capa atualizada!'); window.abrirPlaylist(id); } }
};
window.abrirModalAdicionarPlaylist = (trackId) => {
  document.getElementById('playlistModalOverlay')?.remove();
  const pl = getPlaylists();
  const ov = document.createElement('div'); ov.className = 'playlist-modal-overlay'; ov.id = 'playlistModalOverlay';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Adicionar à playlist');
  const m = document.createElement('div'); m.className = 'playlist-modal';
  const h = document.createElement('h3'); h.textContent = 'Adicionar à Playlist'; m.appendChild(h);
  if (!pl.length) { const p = document.createElement('p'); p.style.color = '#aaa'; p.textContent = 'Nenhuma playlist.'; m.appendChild(p); }
  else {
    const l = document.createElement('div'); l.className = 'playlist-tracks-list';
    pl.forEach(p => {
      const card = document.createElement('div'); card.className = 'playlist-card'; card.style.padding = '0.5rem';
      card.setAttribute('role', 'button'); card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Adicionar em ${p.name}`);
      const info = document.createElement('div'); info.className = 'playlist-info';
      const t = document.createElement('h3'); t.style.fontSize = '0.9rem'; t.textContent = p.name; info.appendChild(t);
      card.appendChild(info);
      card.addEventListener('click', () => window.adicionarTrackPlaylist(p.id, trackId));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.adicionarTrackPlaylist(p.id, trackId); } });
      l.appendChild(card);
    });
    m.appendChild(l);
  }
  const ac = document.createElement('div'); ac.className = 'playlist-modal-actions';
  const cb = document.createElement('button'); cb.textContent = 'Cancelar'; cb.addEventListener('click', () => ov.remove());
  const sb = document.createElement('button'); sb.className = 'save'; sb.textContent = '+ Nova'; sb.addEventListener('click', () => window.criarPlaylistEAdicionar(trackId));
  ac.append(cb, sb); m.appendChild(ac); ov.appendChild(m); document.body.appendChild(ov);
};
window.adicionarTrackPlaylist = (id, trackId) => {
  const s = addTrackToPlaylist(id, trackId); document.getElementById('playlistModalOverlay')?.remove();
  if (s === 'added') showToast('Adicionado!'); else if (s === 'duplicate') showToast('Já está na playlist.');
  else if (s === 'limit_reached') showToast(`Limite de ${MAX_PLAYLIST_TRACKS}.`); else showToast('Erro.');
};
window.criarPlaylistEAdicionar = (trackId) => {
  document.getElementById('playlistModalOverlay')?.remove();
  const n = prompt('Nome da nova playlist:');
  if (n && n.trim()) { const p = createPlaylistWithTrack(n, trackId); if (p) { renderPlaylistsTab(); showToast('Playlist criada!'); } else showToast('Erro.'); }
};

// ─── LISTA DE MÚSICAS ───
function renderPlayerTrackList(context, currentId) {
  if (!els.musicList) return;
  els.musicList.replaceChildren();
  if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${context.tracks.length} faixas`;
  context.tracks.forEach((track, index) => {
    const item = document.createElement('div'); item.className = 'music-item';
    if (String(track.id) === String(currentId)) item.classList.add('playing');
    const nc = document.createElement('div'); nc.className = 'music-item-number';
    nc.style.cssText = 'display:flex;align-items:center;gap:12px;width:auto;min-width:60px;';
    const num = document.createElement('span'); num.className = 'num-text'; num.textContent = index + 1; num.style.cssText = 'width:20px;text-align:center;';
    const ph = document.createElement('span'); ph.className = 'play-hover'; ph.textContent = '▶'; ph.style.cssText = 'width:20px;text-align:center;';
    const img = document.createElement('img');
    img.src = normalizeCoverUrl(track.coverUrl); img.alt = '';
    img.style.cssText = 'width:40px;height:40px;border-radius:4px;object-fit:cover;flex-shrink:0;';
    img.onerror = () => { img.onerror = null; img.src = DEFAULT_COVER; };
    nc.append(num, ph, img);
    const info = document.createElement('div'); info.className = 'music-item-info';
    const t = document.createElement('div'); t.className = 'music-item-title'; t.textContent = track.title || 'Faixa sem título';
    const a = document.createElement('div'); a.className = 'music-item-artist';
    a.appendChild(document.createTextNode(track.artist || 'Joseph Matthos'));
    if (track.isrc) { const s = document.createElement('span'); s.className = 'music-item-isrc'; s.textContent = `ISRC: ${track.isrc}`; a.appendChild(s); }
    info.append(t, a);
    const act = document.createElement('div'); act.className = 'music-item-actions';
    const like = document.createElement('button'); like.className = 'action-icon';
    like.setAttribute('aria-label', 'Curtir faixa');
    const key = `jm_like_${track.id}`; const lk = getLikeState(key);
    like.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${lk ? '#1DB954' : 'none'}" stroke="${lk ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    like.addEventListener('click', (e) => {
      e.stopPropagation(); const l = getLikeState(key);
      if (setLikeState(key, !l)) {
        like.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${!l ? '#1DB954' : 'none'}" stroke="${!l ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
        showToast(l ? 'Removido' : 'Curtido!');
      } else showToast('Erro ao salvar.');
    });
    act.appendChild(like);
    const sh = document.createElement('button'); sh.className = 'action-icon';
    sh.setAttribute('aria-label', 'Compartilhar faixa');
    sh.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
    sh.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;
      const sd = { title: `${track.title} — Joseph Matthos`, url };
      if (navigator.share) { try { await navigator.share(sd); return; } catch {} }
      if (navigator.clipboard) { try { await navigator.clipboard.writeText(url); showToast('Link copiado!'); } catch { showToast('Erro.'); } }
      else showToast('Não suportado.');
    });
    act.appendChild(sh);
    const rt = document.createElement('button'); rt.className = 'action-icon';
    rt.setAttribute('aria-label', 'Alugar faixa');
    rt.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2z"/></svg>`;
    rt.addEventListener('click', (e) => { e.stopPropagation(); window.location.href = `/?rent=${encodeURIComponent(track.id)}`; });
    act.appendChild(rt);
    const d = document.createElement('span'); d.className = 'music-item-duration';
    d.textContent = formatDuration(track.durationSeconds, track.locked); act.appendChild(d);
    const mb = document.createElement('button'); mb.className = 'action-icon';
    mb.setAttribute('aria-label', 'Mais opções');
    mb.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;
    mb.addEventListener('click', (e) => { e.stopPropagation(); openOptionsMenu(track, mb); });
    act.appendChild(mb);
    item.append(nc, info, act);
    /* ← v32.9.1 — item focável + teclado (ignora foco em botões filhos) */
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Tocar ${track.title || 'faixa'}`);
    item.addEventListener('click', () => window.tocarMusicaDaLista(String(track.id), 'user'));
    item.addEventListener('keydown', (e) => {
      if (e.target !== item) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        window.tocarMusicaDaLista(String(track.id), 'user');
      }
    });
    els.musicList.appendChild(item);
  });
}

function openOptionsMenu(track, anchorEl) {
  document.getElementById('trackOptionsMenu')?.remove();
  const m = document.createElement('div'); m.id = 'trackOptionsMenu'; m.className = 'track-options-menu';
  m.setAttribute('role', 'menu');
  const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;
  m.innerHTML = `<button role="menuitem" data-action="share">🔗 Compartilhar</button><button role="menuitem" data-action="copy">📋 Copiar</button><button role="menuitem" data-action="rent">🎫 Alugar</button><button role="menuitem" data-action="playlist">➕ Playlist</button>`;
  document.body.appendChild(m);
  const r = anchorEl.getBoundingClientRect(); const mr = m.getBoundingClientRect();
  m.style.top = `${Math.max(10, Math.min(r.bottom + 6, window.innerHeight - mr.height - 10))}px`;
  m.style.left = `${Math.max(10, Math.min(r.right - mr.width, window.innerWidth - mr.width - 10))}px`;
  const cleanup = () => { m.remove(); document.removeEventListener('click', close); document.removeEventListener('keydown', kd); };
  const close = (e) => { if (!m.contains(e.target) && e.target !== anchorEl) cleanup(); };
  const kd = (e) => { if (e.key === 'Escape') cleanup(); };
  setTimeout(() => { document.addEventListener('click', close); document.addEventListener('keydown', kd); }, 0);
  m.querySelectorAll('button[data-action]').forEach(b => {
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation(); const a = b.dataset.action;
      if (a === 'share') { if (navigator.share) { try { await navigator.share({ title: track.title, url }); } catch {} } else if (navigator.clipboard) { try { await navigator.clipboard.writeText(url); showToast('Link copiado!'); } catch { showToast('Erro.'); } } }
      else if (a === 'copy') { if (navigator.clipboard) { try { await navigator.clipboard.writeText(url); showToast('Link copiado!'); } catch { showToast('Erro.'); } } }
      else if (a === 'rent') { window.location.href = `/?rent=${encodeURIComponent(track.id)}`; }
      else if (a === 'playlist') { window.abrirModalAdicionarPlaylist(track.id); }
      cleanup();
    });
  });
}

// ─── MEDIA SESSION ───
function updateMediaSessionMetadata(meta) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  try {
    const cover = normalizeCoverUrl(meta.coverUrl);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: meta.title || 'Sem título', artist: meta.artist || 'Joseph Matthos', album: meta.albumTitle || 'Álbum',
      artwork: [96,128,192,256,384,512].map(s => ({ src: cover, sizes: `${s}x${s}` }))
    });
  } catch (e) { console.warn('[MediaSession]', e); }
}
function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  [['play', () => { if (currentAudio) attemptPlay(currentAudio); }],
   ['pause', () => { if (currentAudio && !currentAudio.paused) currentAudio.pause(); }],
   ['nexttrack', () => window.playerNext(false)],
   ['previoustrack', () => window.playerPrev()],
   ['seekbackward', (d) => { if (currentAudio && Number.isFinite(currentAudio.duration)) currentAudio.currentTime = Math.max(0, currentAudio.currentTime - (Number(d.seekOffset) || 10)); }],
   ['seekforward', (d) => { if (currentAudio && Number.isFinite(currentAudio.duration)) currentAudio.currentTime = Math.min(currentAudio.duration, currentAudio.currentTime + (Number(d.seekOffset) || 10)); }]
  ].forEach(([a, h]) => { try { navigator.mediaSession.setActionHandler(a, h); } catch {} });
}

// ─── UI UPDATERS ───
function updatePlayerUI(meta) {
  if (!meta) return;
  const c = normalizeCoverUrl(meta.coverUrl);
  if (els.title) els.title.textContent = meta.title;
  if (els.artist) els.artist.textContent = `${meta.artist || 'Joseph Matthos'} · ${meta.albumTitle || ''}`;
  if (els.cover) els.cover.src = c;
  if (els.container) els.container.style.setProperty('--player-bg', `url('${c}')`);
  if (els.miniCover) els.miniCover.style.backgroundImage = `url('${c}')`;
  if (els.miniTitle) els.miniTitle.textContent = meta.title;
  if (els.miniArtist) els.miniArtist.textContent = meta.artist || 'Joseph Matthos';
  updateMediaSessionMetadata(meta);
}
function resetProgressUI() {
  if (els.progressFill) els.progressFill.style.width = '0%';
  if (els.currentTime) els.currentTime.textContent = '0:00';
  if (els.duration) els.duration.textContent = '0:00';
  /* ← v32.9.1 — reset ARIA junto com o visual */
  if (els.progressBar) {
    els.progressBar.setAttribute('aria-valuenow', '0');
    els.progressBar.setAttribute('aria-valuetext', '0:00 de 0:00');
  }
}
/* ← v32.9.1 — sincroniza visual + ARIA a partir do áudio atual (seek com player pausado) */
function syncProgressUI() {
  if (!currentAudio) return;
  const s = currentAudio.currentTime || 0;
  const d = Number.isFinite(currentAudio.duration) ? currentAudio.duration : 0;
  const pct = d > 0 ? Math.min(100, (s / d) * 100) : 0;
  if (els.progressFill) els.progressFill.style.width = `${pct}%`;
  if (els.currentTime) els.currentTime.textContent = formatTime(s);
  if (els.duration) els.duration.textContent = formatTime(d);
  if (els.progressBar) {
    els.progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
    els.progressBar.setAttribute('aria-valuetext',
      `${formatTime(s)} de ${formatTime(d)}`);
  }
}
function attemptPlay(audioEl) {
  if (!audioEl || !audioEl.src) return Promise.resolve({ started: false, reason: 'no-src' });
  if (!audioEl.paused) return Promise.resolve({ started: true, reason: 'already-playing' });
  let playPromise;
  try {
    playPromise = audioEl.play();
  } catch (syncErr) {
    console.error('[player] play() lançou sincronamente:', syncErr);
    showToast('Não foi possível iniciar a reprodução.');
    return Promise.resolve({ started: false, reason: 'failed' });
  }
  if (!playPromise || typeof playPromise.then !== 'function') {
    return Promise.resolve({
      started: !audioEl.paused,
      reason: audioEl.paused ? 'play-no-promise' : 'started'
    });
  }
  return playPromise
    .then(() => ({ started: true, reason: 'started' }))
    .catch(err => {
      if (err.name === 'AbortError') return { started: false, reason: 'aborted' };
      if (err.name === 'NotAllowedError') { showToast('Toque em play para iniciar.'); return { started: false, reason: 'not-allowed' }; }
      console.error('[player] Falha ao iniciar reprodução:', err);
      showToast('Não foi possível iniciar a reprodução.');
      return { started: false, reason: 'failed' };
    });
}

// ─── AUDIO LISTENERS ───
function attachPlaybackListeners(a) {
  a.addEventListener('play', () => {
    if (a !== currentAudio) return;
    if (els.playIcon) els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    if (els.miniPlayBtn) els.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      if (a !== currentAudio) return;
      const s = a.currentTime || 0, d = a.duration || 0;
      const pct = d > 0 ? Math.min(100, (s / d) * 100) : 0;
      if (els.progressFill) els.progressFill.style.width = `${pct}%`;
      if (els.currentTime) els.currentTime.textContent = formatTime(s);
      if (els.duration) els.duration.textContent = formatTime(d);
      /* ← v32.9.1 — ARIA no mesmo ponto de update, sem timer novo */
      if (els.progressBar) {
        els.progressBar.setAttribute('aria-valuenow', String(Math.round(pct)));
        els.progressBar.setAttribute('aria-valuetext',
          `${formatTime(s)} de ${formatTime(d)}`);
      }
    }, 250);
  });
  a.addEventListener('pause', () => {
    if (a !== currentAudio) return;
    if (els.playIcon) els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    if (els.miniPlayBtn) els.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    clearInterval(updateInterval);
    setBuffering(false);
  });
  a.addEventListener('loadedmetadata', () => { if (a === currentAudio && els.duration) els.duration.textContent = formatTime(a.duration); });
  a.addEventListener('ended', () => { if (a === currentAudio) window.playerNext(true); });
  a.addEventListener('waiting', () => { if (a === currentAudio) setBuffering(true); });
  a.addEventListener('playing', () => { if (a === currentAudio) setBuffering(false); });
  a.addEventListener('canplay', () => { if (a === currentAudio) setBuffering(false); });
  a.addEventListener('stalled', () => { if (a === currentAudio) { console.warn('[player] Stream stalled'); setBuffering(true); } });
  a.addEventListener('error', () => {
    if (a !== currentAudio) return;
    const code = a.error?.code || 0;
    setBuffering(false);
    if (code === 2) {
      console.warn('[player] Erro de rede (transitório):', a.error);
      showToast('Conexão instável.');
      return;
    }
    console.warn(`[player] Erro de mídia (code=${code}):`, a.error);
    showToast('Falha na reprodução.');
    if (els.playIcon) els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    if (els.miniPlayBtn) els.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    clearInterval(updateInterval);
  });
}

// ─── FASE 1: PREPARE ───
async function prepareTrack(trackId, { contextHint, signal, allowAlbumFallback = true }) {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  let createdAudio = null;
  try {
    const res = await fetch(`/api/public?track=${encodeURIComponent(trackId)}`, { signal });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!res.ok) throw new Error('Falha de rede');
    const meta = await res.json();
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!meta.ok || !isValidTrack(meta)) throw new Error(meta.error || 'Dados inválidos.');
    if (normalizeTrackId(meta.id) !== trackId) throw new Error('ID incompatível.');

    const trackMeta = { ...meta, coverUrl: normalizeCoverUrl(meta.coverUrl) };
    let playbackContext = null;

    if (contextHint) {
      const ct = contextHint.tracks.find(t => String(t.id) === String(trackId));
      if (ct) {
        playbackContext = contextHint;
        trackMeta.coverUrl = normalizeCoverUrl(ct.coverUrl, trackMeta.coverUrl);
        if (ct.albumTitle) trackMeta.albumTitle = ct.albumTitle;
      } else {
        console.warn('[player] contextHint não contém a faixa; buscando álbum.');
      }
    }

    // TBD backend: 404 do álbum → fallback single. Requer contrato verificado
    // de que /api/stream?trackId= revalida autorização independentemente.
    if (!playbackContext && allowAlbumFallback) {
      const albumId = normalizeTrackId(meta.albumId);
      if (albumId) {
        try {
          const ar = await fetch(`/api/public?album=${encodeURIComponent(albumId)}&t=${Date.now()}`, { signal });
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

          if (ar.status === 404) {
            throw new AlbumError('Álbum não encontrado.', 'not-found');
          } else if (ar.status === 401 || ar.status === 403) {
            throw new AlbumError('Acesso negado ao álbum.', 'auth');
          } else if (ar.status === 429) {
            throw new AlbumError('Muitas requisições. Tente novamente.', 'rate-limit');
          } else if (ar.status >= 500) {
            throw new AlbumError(`Servidor de álbum indisponível (HTTP ${ar.status}).`, 'server');
          } else if (!ar.ok) {
            throw new AlbumError(`Erro HTTP ${ar.status} no álbum.`, 'server');
          } else {
            const ad = await ar.json();
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            if (!ad.ok) {
              const code = typeof ad.code === 'string' ? ad.code : '';
              if (code === 'ALBUM_NOT_FOUND') throw new AlbumError('Álbum não encontrado.', 'not-found');
              if (AUTH_ALBUM_CODES.has(code)) throw new AlbumError(ad.error || 'Acesso negado ao álbum.', 'auth');
              console.warn('[player] ok:false com código não reconhecido; fallback bloqueado:', ad);
              throw new AlbumError(ad.error || 'Álbum indisponível.', 'unknown');
            }

            if (!ad.album) throw new AlbumError('Álbum ausente na resposta.', 'integrity');
            if (normalizeTrackId(ad.album.id) !== albumId) throw new AlbumError('ID do álbum incompatível.', 'integrity');
            if (typeof ad.album.title !== 'string' || !ad.album.title.trim()) throw new AlbumError('Álbum sem título.', 'integrity');
            if (!Array.isArray(ad.tracks)) throw new AlbumError('Álbum sem lista de faixas.', 'integrity');

            const ac = normalizeCoverUrl(ad.album.coverUrl);
            const seen = new Set();
            const tracks = [];
            let invalid = 0;
            for (const t of ad.tracks) {
              if (!isValidTrack(t)) { invalid++; continue; }
              const tid = normalizeTrackId(t.id);
              if (seen.has(tid)) { invalid++; continue; }
              const tAlbumId = normalizeTrackId(t.albumId);
              if (tAlbumId !== albumId) { invalid++; continue; }
              seen.add(tid);
              tracks.push({ ...t, coverUrl: ac });
            }
            if (invalid > 0) {
              throw new AlbumError(`Álbum contém ${invalid} faixa(s) inválida(s)/duplicada(s).`, 'integrity');
            }
            if (!tracks.some(t => String(t.id) === trackId)) {
              throw new AlbumError('Faixa ausente no álbum retornado.', 'integrity');
            }
            trackMeta.coverUrl = ac;
            playbackContext = { type: 'album', id: ad.album.id, name: ad.album.title, coverUrl: ac, tracks };
          }
        } catch (e) {
          if (e.name === 'AbortError') throw e;
          if (e.name === 'AlbumError') throw e;
          console.warn('[player] Falha de comunicação ao buscar álbum:', e.message);
          throw new AlbumError(`Falha ao buscar álbum: ${e.message || 'erro de rede'}`, 'network');
        }
      }
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    createdAudio = new Audio();
    createdAudio.preload = 'auto';

    let failAudioReady = null;
    const audioReady = new Promise((resolve, reject) => {
      let done = false;
      let tid = null;

      const cleanup = () => {
        if (done) return false;
        done = true;
        if (tid) clearTimeout(tid);
        createdAudio.removeEventListener('canplay', onCanPlay);
        createdAudio.removeEventListener('error', onError);
        if (signal) signal.removeEventListener('abort', onAbort);
        return true;
      };

      const succeed = () => { if (cleanup()) resolve(); };
      const fail = (error) => { if (cleanup()) reject(error); };

      const onCanPlay = () => succeed();
      const onError = () => fail(new Error('Falha ao carregar áudio.'));
      const onAbort = () => fail(new DOMException('Aborted', 'AbortError'));

      failAudioReady = fail;

      createdAudio.addEventListener('canplay', onCanPlay);
      createdAudio.addEventListener('error', onError);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      tid = setTimeout(() => fail(new Error('Timeout ao carregar áudio.')), AUDIO_PREPARE_TIMEOUT_MS);
    });

    try {
      createdAudio.src = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
      createdAudio.load();
    } catch (loadErr) {
      if (failAudioReady) {
        failAudioReady(loadErr);
        try { await audioReady; } catch {}
      }
      throw loadErr;
    }

    await audioReady;

    return { audio: createdAudio, trackId, trackMeta, playbackContext };
  } catch (e) {
    if (createdAudio) safeDisposeAudio(createdAudio);
    throw e;
  }
}

// ─── FASE 2: COMMIT ───
async function commitTrack(prepared, autoplay, operationId, navigationToken, restoreId) {
  const isCurrentOp = () =>
    operationId === commitRequestId &&
    (navigationToken === null || navigationToken === navigationRequestId);

  if (!isCurrentOp()) {
    if (prepared?.audio) safeDisposeAudio(prepared.audio);
    return { committed: false, playbackStarted: false, reason: 'superseded' };
  }

  const snapshot = {
    audio: currentAudio,
    trackId: currentTrackId,
    trackMeta: currentTrackMeta,
    playbackContext: currentPlaybackContext,
    wasPaused: currentAudio ? currentAudio.paused : true,
    currentTime: currentAudio && Number.isFinite(currentAudio.currentTime) ? currentAudio.currentTime : 0,
    released: false
  };
  registerSnapshot(snapshot);

  let stateSwapped = false;
  try {
    if (snapshot.audio) { try { snapshot.audio.pause(); } catch {} }

    currentAudio = prepared.audio;
    currentTrackId = prepared.trackId;
    currentTrackMeta = prepared.trackMeta;
    currentPlaybackContext = prepared.playbackContext || {
      type: 'single',
      id: prepared.trackId,
      name: prepared.trackMeta.title,
      coverUrl: prepared.trackMeta.coverUrl,
      tracks: [prepared.trackMeta]
    };
    stateSwapped = true;

    try { attachPlaybackListeners(currentAudio); } catch (e) { console.warn('[player] attachPlaybackListeners:', e); }
    try { setBuffering(false); } catch (e) { console.warn('[player] setBuffering:', e); }
    try { updatePlayerUI(currentTrackMeta); } catch (e) { console.warn('[player] updatePlayerUI:', e); }
    try { resetProgressUI(); } catch (e) { console.warn('[player] resetProgressUI:', e); }
    try { renderCurrentCatalog(prepared.trackId); } catch (e) { console.warn('[player] renderCurrentCatalog:', e); }

    if (!autoplay) {
      releaseAndDisposeSnapshot(snapshot);
      return { committed: true, playbackStarted: false, reason: 'no-autoplay' };
    }

    const playResult = await attemptPlay(currentAudio);

    if (!isCurrentOp()) {
      const opCurrent = operationId === commitRequestId;
      const ownsAudio = currentAudio === prepared.audio;

      if (opCurrent && ownsAudio) {
        const invalidated = prepared.audio;
        await restorePlaybackSnapshot(snapshot, operationId, restoreId);
        safeDisposeAudio(invalidated);
        return { committed: false, playbackStarted: false, reason: 'nav-invalidated' };
      }

      safeDisposeAudio(prepared.audio);
      releaseAndDisposeSnapshot(snapshot);
      return { committed: false, playbackStarted: false, reason: 'superseded-commit' };
    }

    if (!playResult.started && playResult.reason !== 'not-allowed') {
      const failedAudio = currentAudio;
      await restorePlaybackSnapshot(snapshot, operationId, restoreId);
      safeDisposeAudio(failedAudio);
      return { committed: false, playbackStarted: false, reason: playResult.reason };
    }

    releaseAndDisposeSnapshot(snapshot);
    return { committed: true, playbackStarted: playResult.started, reason: playResult.reason };
  } catch (err) {
    if (stateSwapped && operationId === commitRequestId && currentAudio === prepared.audio) {
      try {
        await restorePlaybackSnapshot(snapshot, operationId, restoreId);
      } catch (restoreErr) {
        console.error('[player] Falha no rollback:', restoreErr);
      } finally {
        safeDisposeAudio(prepared.audio);
      }
    } else {
      try { releaseAndDisposeSnapshot(snapshot); } catch (e) { console.warn(e); }
      safeDisposeAudio(prepared.audio);
    }
    throw err;
  }
}

// ─── ORQUESTRADOR INTERNO ───
async function playTrackInternal(trackId, { contextHint = null, allowAlbumFallback = true, navigationToken = null } = {}) {
  trackId = normalizeTrackId(trackId);
  if (!trackId) return { committed: false, playbackStarted: false, reason: 'invalid-id' };

  const operationId = ++commitRequestId;
  const restoreId = ++activeRestoreId;
  const reqId = ++playbackRequestId;
  const ctrl = createPlaybackRequest();

  let prepared = null;
  try {
    prepared = await prepareTrack(trackId, { contextHint, signal: ctrl.signal, allowAlbumFallback });
  } catch (err) {
    if (err.name === 'AbortError') return { committed: false, playbackStarted: false, reason: 'aborted' };
    if (operationId !== commitRequestId || reqId !== playbackRequestId) return { committed: false, playbackStarted: false, reason: 'superseded' };

    if (err.name === 'AlbumError') {
      if (NON_FALLBACK_ALBUM_REASONS.has(err.reason)) {
        showToast(err.message);
        return { committed: false, playbackStarted: false, reason: 'album-' + err.reason };
      }
      showToast(`${err.message} Tocando faixa individual.`);
      try {
        prepared = await prepareTrack(trackId, { contextHint: null, signal: ctrl.signal, allowAlbumFallback: false });
      } catch (retryErr) {
        if (retryErr.name === 'AbortError') return { committed: false, playbackStarted: false, reason: 'aborted' };
        if (operationId !== commitRequestId || reqId !== playbackRequestId) return { committed: false, playbackStarted: false, reason: 'superseded' };
        console.error('[player] Retry single falhou:', retryErr);
        showToast('Não foi possível carregar a faixa.');
        return { committed: false, playbackStarted: false, reason: 'prepare-failed' };
      }
    } else {
      console.error('[player] Falha na preparação:', err);
      showToast(err.message || 'Não foi possível preparar a faixa.');
      return { committed: false, playbackStarted: false, reason: 'prepare-failed' };
    }
  }

  if (operationId !== commitRequestId || reqId !== playbackRequestId) {
    if (prepared?.audio) safeDisposeAudio(prepared.audio);
    return { committed: false, playbackStarted: false, reason: 'superseded' };
  }
  if (navigationToken !== null && navigationToken !== navigationRequestId) {
    if (prepared?.audio) safeDisposeAudio(prepared.audio);
    return { committed: false, playbackStarted: false, reason: 'nav-superseded' };
  }

  let result;
  try {
    result = await commitTrack(prepared, true, operationId, navigationToken, restoreId);
  } catch (commitErr) {
    console.error('[player] Commit falhou (tratado):', commitErr);
    return { committed: false, playbackStarted: false, reason: 'commit-failed' };
  }

  if (operationId !== commitRequestId || reqId !== playbackRequestId) {
    return { committed: false, playbackStarted: false, reason: 'superseded' };
  }
  if (result.committed && currentTrackId === trackId) {
    try { history.replaceState(null, '', `/player.html?id=${encodeURIComponent(trackId)}`); }
    catch (e) { console.warn(e); }
  }
  return result;
}

async function playTrack(trackId, options = {}) {
  try {
    return await playTrackInternal(trackId, options);
  } catch (err) {
    console.error('[player] Falha inesperada em playTrack:', err);
    return { committed: false, playbackStarted: false, reason: 'unexpected-error' };
  }
}

// ─── CONTROLES PÚBLICOS ───
window.playerPlay = () => {
  if (!currentAudio || !currentAudio.src) {
    if (currentTrackId) playTrack(currentTrackId);
    return;
  }
  if (!currentAudio.paused) {
    currentAudio.pause();
    if (playbackAbortController) { try { playbackAbortController.abort(); } catch {} }
    return;
  }
  attemptPlay(currentAudio);
};

function contextKey(ctx) {
  return ctx ? `${ctx.type}:${ctx.id}` : null;
}

window.tocarMusicaDaLista = async (id, mode = 'user') => {
  id = normalizeTrackId(id);
  if (!id) return false;

  const navId = ++navigationRequestId;
  const inCatalog = selectedCatalogContext?.tracks?.some(t => String(t.id) === id);
  const contextHint = inCatalog ? selectedCatalogContext : null;

  const ctxBeforeKey = contextKey(currentPlaybackContext);
  const result = await playTrack(id, { contextHint, navigationToken: navId });
  if (!shouldAdvanceQueue(result)) return false;

  const ctxAfterKey = contextKey(currentPlaybackContext);
  const contextChanged = ctxBeforeKey !== ctxAfterKey;
  if (mode === 'user' || contextChanged) {
    initShuffleState(currentPlaybackContext, id);
  }
  return true;
};

window.playerNext = async (isAuto = false) => {
  if (!currentPlaybackContext?.tracks || currentPlaybackContext.tracks.length === 0) return;
  if (isAuto && repeatMode === 'one') {
    if (currentAudio) { currentAudio.currentTime = 0; attemptPlay(currentAudio); }
    return;
  }
  if (currentPlaybackContext.tracks.length === 1) {
    if (repeatMode === 'all' || !isAuto) {
      if (currentAudio) { currentAudio.currentTime = 0; attemptPlay(currentAudio); }
    }
    return;
  }

  if (shuffleEnabled) {
    if (!isAuto && shuffleHistoryIndex < shuffleHistory.length - 1) {
      const ti = shuffleHistoryIndex + 1;
      const tid = shuffleHistory[ti];
      const navId = ++navigationRequestId;
      const result = await playTrack(String(tid), { contextHint: currentPlaybackContext, navigationToken: navId });
      if (navId !== navigationRequestId) return;
      if (shouldAdvanceQueue(result)) shuffleHistoryIndex = ti;
      return;
    }
    if (shuffleHistoryIndex < shuffleHistory.length - 1) {
      shuffleHistory = shuffleHistory.slice(0, shuffleHistoryIndex + 1);
    }
    if (shuffleQueue.length === 0) {
      if (repeatMode === 'all' || !isAuto) {
        shuffleQueue = generateShuffleQueue(currentPlaybackContext.tracks, currentTrackId);
      } else {
        if (currentAudio) currentAudio.pause();
        return;
      }
    }
    if (shuffleQueue.length > 0) {
      const ni = shuffleQueue[0];
      const nt = currentPlaybackContext.tracks[ni];
      if (!nt) { shuffleQueue.shift(); return; }
      const navId = ++navigationRequestId;
      const result = await playTrack(String(nt.id), { contextHint: currentPlaybackContext, navigationToken: navId });
      if (navId !== navigationRequestId) return;
      if (shouldAdvanceQueue(result)) {
        shuffleQueue.shift();
        shuffleHistory.push(String(nt.id));
        shuffleHistoryIndex = shuffleHistory.length - 1;
        if (shuffleHistory.length > MAX_SHUFFLE_HISTORY) { shuffleHistory.shift(); shuffleHistoryIndex--; }
      }
    }
    return;
  }

  const tracks = currentPlaybackContext.tracks;
  const ci = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (ci === -1) { if (currentAudio) currentAudio.pause(); return; }
  let ni = ci + 1;
  if (ni >= tracks.length) {
    if (repeatMode === 'all' || !isAuto) ni = 0;
    else { if (currentAudio) currentAudio.pause(); return; }
  }
  const navId = ++navigationRequestId;
  await playTrack(String(tracks[ni].id), { contextHint: currentPlaybackContext, navigationToken: navId });
};

window.playerPrev = async () => {
  if (currentAudio && Number.isFinite(currentAudio.currentTime) && currentAudio.currentTime > 3) {
    currentAudio.currentTime = 0;
    return;
  }
  if (!currentPlaybackContext?.tracks || currentPlaybackContext.tracks.length === 0) return;

  if (shuffleEnabled) {
    if (shuffleHistoryIndex > 0) {
      const ti = shuffleHistoryIndex - 1;
      const tid = shuffleHistory[ti];
      const navId = ++navigationRequestId;
      const result = await playTrack(String(tid), { contextHint: currentPlaybackContext, navigationToken: navId });
      if (navId !== navigationRequestId) return;
      if (shouldAdvanceQueue(result)) shuffleHistoryIndex = ti;
    }
    return;
  }

  const tracks = currentPlaybackContext.tracks;
  const ci = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (ci === -1) return;
  const pi = (ci - 1 + tracks.length) % tracks.length;
  const navId = ++navigationRequestId;
  await playTrack(String(tracks[pi].id), { contextHint: currentPlaybackContext, navigationToken: navId });
};

// ─── SHUFFLE / REPEAT ───
window.toggleShuffle = () => {
  shuffleEnabled = !shuffleEnabled;
  if (shuffleEnabled && currentPlaybackContext) initShuffleState(currentPlaybackContext, currentTrackId);
  else { shuffleQueue = []; shuffleHistory = []; shuffleHistoryIndex = -1; }
  const b = document.getElementById('shuffleBtn');
  if (b) { b.style.color = shuffleEnabled ? 'var(--green)' : 'var(--text-dim)'; b.setAttribute('aria-pressed', shuffleEnabled ? 'true' : 'false'); }
  showToast(shuffleEnabled ? 'Aleatório ativado' : 'Aleatório desativado');
};
window.toggleRepeat = () => {
  if (repeatMode === 'off') repeatMode = 'all';
  else if (repeatMode === 'all') repeatMode = 'one';
  else repeatMode = 'off';
  const b = document.getElementById('repeatBtn');
  if (b) { b.style.color = repeatMode !== 'off' ? 'var(--green)' : 'var(--text-dim)'; b.setAttribute('aria-pressed', repeatMode !== 'off' ? 'true' : 'false'); }
  showToast(`Repetição: ${repeatMode === 'off' ? 'Desligada' : repeatMode === 'all' ? 'Álbum' : 'Música'}`);
};

// ─── ABRIR ÁLBUM ───
window.abrirAlbum = async (albumId) => {
  albumId = normalizeTrackId(albumId);
  if (!albumId) return;
  const ctrl = createCatalogRequest();
  const reqId = ++catalogRequestId;
  switchTab('music');
  setCatalogLoading(true);

  try {
    const res = await fetch(`/api/public?album=${encodeURIComponent(albumId)}&t=${Date.now()}`, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('Falha de rede');
    const data = await res.json();
    if (reqId !== catalogRequestId) return;
    if (!data.ok || !data.album) throw new Error(data.error || 'Álbum não encontrado.');
    if (normalizeTrackId(data.album.id) !== albumId) throw new Error('ID do álbum incompatível.');
    if (typeof data.album.title !== 'string' || !data.album.title.trim()) throw new Error('Álbum sem título.');
    if (!Array.isArray(data.tracks)) throw new Error('Resposta sem lista de faixas válida.');

    const ac = normalizeCoverUrl(data.album.coverUrl);
    const seen = new Set();
    const tracks = [];
    let invalid = 0;
    for (const t of data.tracks) {
      if (!isValidTrack(t)) { invalid++; continue; }
      const tid = normalizeTrackId(t.id);
      if (seen.has(tid)) { invalid++; continue; }
      const tAlbumId = normalizeTrackId(t.albumId);
      if (tAlbumId !== albumId) { invalid++; continue; }
      seen.add(tid);
      tracks.push({ ...t, coverUrl: ac });
    }

    if (invalid > 0) {
      throw new Error(`Álbum com ${invalid} faixa(s) inválida(s). Contate o suporte.`);
    }

    selectedCatalogContext = { type: 'album', id: data.album.id, name: data.album.title, coverUrl: ac, tracks };

    const header = document.getElementById('albumTracklistHeader');
    if (header) {
      header.style.display = 'flex';
      header.querySelector('.btn-edit-cover')?.remove();
      const sub = header.querySelector('.btn-subscribe-header');
      if (sub) sub.style.display = 'block';
    }
    if (els.albumHeaderCover) els.albumHeaderCover.style.backgroundImage = `url('${ac}')`;
    if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = data.album.title;
    if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = data.album.artist || 'Joseph Matthos';
    if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${tracks.length} faixas`;

    if (tracks.length === 0) {
      if (els.musicList) els.musicList.innerHTML = '<p style="text-align:center;color:#aaa;padding:1rem;">Álbum sem faixas cadastradas.</p>';
      return;
    }
    renderPlayerTrackList(selectedCatalogContext, currentTrackId);
  } catch (e) {
    if (e.name === 'AbortError' || reqId !== catalogRequestId) return;
    console.warn('[player] Falha ao abrir álbum:', e.message);
    showToast(e.message || 'Falha ao abrir álbum.');
  } finally {
    if (reqId === catalogRequestId) setCatalogLoading(false);
  }
};

// ─── ABRIR PLAYLIST ───
window.abrirPlaylist = async (playlistId) => {
  const pl = getPlaylists(); const playlist = pl.find(p => p.id === playlistId);
  if (!playlist) return;
  if (playlist.tracks.length === 0) { showToast('Playlist vazia.'); return; }

  const ctrl = createCatalogRequest();
  const reqId = ++catalogRequestId;
  switchTab('music');
  setCatalogLoading(true);

  try {
    const covers = new Map();
    try {
      const cr = await fetch('/api/public?t=' + Date.now(), { signal: ctrl.signal });
      if (cr.ok) {
        const cd = await cr.json();
        if (cd.ok && Array.isArray(cd.albums)) cd.albums.forEach(a => {
          const aid = normalizeTrackId(a.id); if (aid) covers.set(aid, normalizeCoverUrl(a.coverUrl));
        });
      }
    } catch (e) { if (e.name === 'AbortError') return; }
    if (reqId !== catalogRequestId) return;

    const failures = [];
    const fetchTrack = async (id, signal) => {
      try {
        const r = await fetch(`/api/public?track=${encodeURIComponent(id)}`, { signal });
        if (r.status === 404) { failures.push({ id, reason: 'not-found' }); return null; }
        if (!r.ok) { failures.push({ id, reason: `http-${r.status}` }); return null; }
        const d = await r.json();
        if (!d.ok || normalizeTrackId(d.id) !== normalizeTrackId(id)) { failures.push({ id, reason: 'invalid-data' }); return null; }
        let c = DEFAULT_COVER;
        if (d.albumId) { const aid = normalizeTrackId(d.albumId); if (aid && covers.has(aid)) c = covers.get(aid); }
        return { id: d.id, title: d.title, artist: d.artist || 'Joseph Matthos', albumTitle: d.albumTitle, durationSeconds: d.durationSeconds, coverUrl: c };
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        failures.push({ id, reason: 'network' });
        return null;
      }
    };

    const res = await fetchInBatches(playlist.tracks, ctrl.signal, fetchTrack);
    if (reqId !== catalogRequestId) return;
    const seen = new Set(); const valid = [];
    for (const t of res) {
      if (!isValidTrack(t)) continue;
      const tid = normalizeTrackId(t.id);
      if (seen.has(tid)) continue;
      seen.add(tid); valid.push(t);
    }
    if (valid.length === 0) {
      showToast('Não foi possível carregar as faixas.');
      return;
    }
    if (failures.length > 0) {
      console.warn('[player] Faixas indisponíveis na playlist:', failures);
      showToast(`${failures.length} faixa(s) indisponível(is).`);
    }

    selectedCatalogContext = { type: 'playlist', id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl || DEFAULT_COVER, tracks: valid };

    const header = document.getElementById('albumTracklistHeader');
    if (header) {
      header.style.display = 'flex';
      if (els.albumHeaderCover) {
        els.albumHeaderCover.style.backgroundImage = playlist.coverUrl ? `url('${playlist.coverUrl}')` : 'none';
        els.albumHeaderCover.style.backgroundColor = '#333';
      }
      if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = playlist.name;
      if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = 'Sua Playlist';
      if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${valid.length} faixas`;
      const sub = header.querySelector('.btn-subscribe-header');
      if (sub) sub.style.display = 'none';
      let eb = header.querySelector('.btn-edit-cover');
      if (!eb) {
        eb = document.createElement('button'); eb.className = 'btn-edit-cover'; eb.textContent = 'Editar Capa';
        eb.setAttribute('aria-label', 'Editar capa da playlist');
        eb.addEventListener('click', () => window.editarCapaPlaylist(playlistId));
        header.appendChild(eb);
      }
    }
    renderPlayerTrackList(selectedCatalogContext, currentTrackId);
  } catch (e) {
    if (e.name === 'AbortError' || reqId !== catalogRequestId) return;
    console.warn('[player] Falha ao abrir playlist:', e);
    showToast('Erro ao carregar playlist.');
  } finally {
    if (reqId === catalogRequestId) setCatalogLoading(false);
  }
};

// ─── BOOT ───
async function bootPlayer() {
  if (isBooted) return;
  isBooted = true;
  setupMediaSessionHandlers();

  els.playBtn?.addEventListener('click', window.playerPlay);
  els.progressBar?.addEventListener('click', (e) => {
    if (!currentAudio || !Number.isFinite(currentAudio.duration) || currentAudio.duration <= 0) return;
    const r = els.progressBar.getBoundingClientRect();
    if (r.width <= 0) return;
    const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    currentAudio.currentTime = p * currentAudio.duration;
    syncProgressUI();                                       /* ← v32.9.1 */
  });
  els.progressBar?.addEventListener('keydown', (e) => {
    if (!currentAudio || !Number.isFinite(currentAudio.duration) || currentAudio.duration <= 0) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); currentAudio.currentTime = Math.min(currentAudio.duration, currentAudio.currentTime + 5); syncProgressUI(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); currentAudio.currentTime = Math.max(0, currentAudio.currentTime - 5); syncProgressUI(); }
  });
  els.fullscreenBtn?.addEventListener('click', () => {
    if (!els.container || typeof els.container.requestFullscreen !== 'function') return;
    if (!document.fullscreenElement) els.container.requestFullscreen().catch(e => console.warn(e));
    else { try { document.exitFullscreen().catch(e => console.warn(e)); } catch (e) {} }
  });
  els.miniPlayBtn?.addEventListener('click', () => window.playerPlay());
  els.miniNextBtn?.addEventListener('click', () => window.playerNext(false));
  els.miniPrevBtn?.addEventListener('click', () => window.playerPrev());
  els.miniOpenBtn?.addEventListener('click', () => switchTab('player'));
  document.getElementById('shuffleBtn')?.addEventListener('click', window.toggleShuffle);
  document.getElementById('repeatBtn')?.addEventListener('click', window.toggleRepeat);

  els.playBtn?.setAttribute('aria-label', 'Play/Pause');
  els.fullscreenBtn?.setAttribute('aria-label', 'Alternar tela cheia');
  els.miniPlayBtn?.setAttribute('aria-label', 'Play/Pause');
  els.miniNextBtn?.setAttribute('aria-label', 'Próxima faixa');
  els.miniPrevBtn?.setAttribute('aria-label', 'Faixa anterior');
  els.miniOpenBtn?.setAttribute('aria-label', 'Abrir player');

  const shuffleBtn = document.getElementById('shuffleBtn');
  if (shuffleBtn) {
    shuffleBtn.style.color = shuffleEnabled ? 'var(--green)' : 'var(--text-dim)';
    shuffleBtn.setAttribute('aria-label', shuffleEnabled ? 'Desativar aleatório' : 'Ativar aleatório');
    shuffleBtn.setAttribute('aria-pressed', shuffleEnabled ? 'true' : 'false');
  }
  const repeatBtn = document.getElementById('repeatBtn');
  if (repeatBtn) {
    repeatBtn.style.color = repeatMode !== 'off' ? 'var(--green)' : 'var(--text-dim)';
    repeatBtn.setAttribute('aria-label', `Repetição: ${repeatMode === 'off' ? 'desligada' : repeatMode === 'all' ? 'álbum' : 'música'}`);
    repeatBtn.setAttribute('aria-pressed', repeatMode !== 'off' ? 'true' : 'false');
  }

  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (trackId) {
    const result = await playTrack(trackId, { contextHint: null });
    if (shouldAdvanceQueue(result) && shuffleEnabled && currentPlaybackContext) {
      initShuffleState(currentPlaybackContext, trackId);
    }
  } else if (els.title) els.title.textContent = 'Nenhuma faixa selecionada';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPlayer, { once: true });
else bootPlayer();
