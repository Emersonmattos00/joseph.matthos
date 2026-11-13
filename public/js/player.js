// js/player.js — Versão Final Corrigida (Restaurando estrutura)

'use strict';

// ─── UTILS ───
function formatTime(secs) {
  const value = Number(secs);
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function showToast(message) {
  const existing = document.getElementById('playerToast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'playerToast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function normalizeTrackId(value) {
  if (value === null || value === undefined || typeof value === 'object') return null;
  const id = String(value).trim();
  if (!id || id.length > 128) return null;
  return id;
}

const imageCache = new Map();
function preloadImage(url) {
  if (!url || imageCache.has(url)) return;
  const img = new Image();
  img.src = url;
  imageCache.set(url, img);
}

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
  lyricsContent: document.getElementById('lyricsContent'),
  musicList: document.getElementById('musicList'),
  albumHeaderCover: document.getElementById('albumHeaderCover'),
  albumHeaderTitle: document.getElementById('albumHeaderTitle'),
  albumHeaderArtist: document.getElementById('albumHeaderArtist'),
  albumHeaderCount: document.getElementById('albumHeaderCount'),
  fullscreenBtn: document.getElementById('fullscreenBtn'),
  shuffleBtn: document.getElementById('shuffleBtn'),
  repeatBtn: document.getElementById('repeatBtn'),
  // Mini-Player
  miniPlayer: document.getElementById('miniPlayer'),
  miniCover: document.getElementById('miniCover'),
  miniTitle: document.getElementById('miniTitle'),
  miniArtist: document.getElementById('miniArtist'),
  miniPlayBtn: document.getElementById('miniPlayBtn'),
  miniNextBtn: document.getElementById('miniNextBtn'),
  miniPrevBtn: document.getElementById('miniPrevBtn'),
  miniOpenBtn: document.getElementById('miniOpenBtn')
};

const audio = new Audio();
audio.preload = 'metadata';

let updateInterval = null;
let currentTrackId = null;
let parsedLyrics = [];
let currentLyricIndex = -1;
let currentTrackMeta = null;

let shuffleEnabled = false;
let repeatMode = 'off';

let playerRequestId = 0;
let playerAbortController = null;

// ─── ABAS ───
const tabs = document.querySelectorAll('.mobile-tab');
const tabContents = document.querySelectorAll('.tab-content');

function updateTabState(activeTab) {
  const tabName = activeTab?.dataset.tab;
  if (!tabName) return;
  tabs.forEach(t => {
    const on = t === activeTab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  tabContents.forEach(c => {
    const on = c.id === `tab-${tabName}`;
    c.classList.toggle('active', on);
    c.hidden = !on;
  });

  if (tabName !== 'player' && currentTrackId) {
    els.miniPlayer.style.display = 'flex';
  } else {
    els.miniPlayer.style.display = 'none';
  }

  if (tabName === 'albums') {
    renderAlbumsTab();
  }
}

tabs.forEach(tab => tab.addEventListener('click', () => updateTabState(tab)));

function switchTab(tabName) {
  const btn = document.querySelector(`.mobile-tab[data-tab="${tabName}"]`);
  if (btn) updateTabState(btn);
}

// ─── MINI-PLAYER ───
els.miniPlayBtn?.addEventListener('click', () => window.playerPlay());
els.miniNextBtn?.addEventListener('click', () => window.playerNext());
els.miniPrevBtn?.addEventListener('click', () => window.playerPrev());
els.miniOpenBtn?.addEventListener('click', () => switchTab('player'));

// ─── RENDERIZAR ÁLBUNS (Restaurado) ───
async function renderAlbumsTab() {
  const container = document.getElementById('albumsList');
  if (!container) return;

  container.innerHTML = '<p style="text-align:center;color:#aaa;padding:1rem;">Carregando álbuns...</p>';

  try {
    // Busca a lista completa de álbuns
    const res = await fetch('/api/public?t=' + Date.now());
    const data = await res.json();
    if (!data.ok || !data.albums) throw new Error('Falha ao carregar álbuns.');

    container.innerHTML = data.albums.map(album => `
      <div class="album-card" onclick="window.abrirAlbum('${album.id}')">
        <img src="${album.coverUrl}" alt="${album.title}">
        <div class="album-info">
          <div class="album-title">${esc(album.title)}</div>
          <div class="album-sub">${album.tracks?.length || 0} faixas</div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger);text-align:center;">${esc(err.message)}</p>`;
  }
}

// ─── ABRIR ÁLBUM (CORRIGIDO) ───
window.abrirAlbum = async (albumId) => {
  const header = document.getElementById('albumTracklistHeader');
  const list = document.getElementById('musicList');
  if (header) header.style.display = 'flex';
  if (list) list.innerHTML = '<p style="text-align:center;color:#aaa;">Carregando faixas...</p>';

  switchTab('music');

  try {
    // A API pública espera o parâmetro "album" para buscar as faixas
    const res = await fetch(`/api/public?album=${albumId}&t=${Date.now()}`);
    const data = await res.json();
    if (!data.ok || !data.album) throw new Error(data.error || 'Álbum não encontrado.');

    const album = data.album;
    const tracks = album.tracks || [];

    if (els.albumHeaderCover) els.albumHeaderCover.style.backgroundImage = `url('${album.coverUrl}')`;
    if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = album.title;
    if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = album.artist || 'Joseph Matthos';
    if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${tracks.length} faixas`;

    renderPlayerTrackList({ ...album, albumTracks: tracks }, currentTrackId);
  } catch (err) {
    if (list) list.innerHTML = `<p style="color:var(--danger);text-align:center;">${esc(err.message)}</p>`;
  }
};

// ─── LISTA DE MÚSICAS ───
function renderPlayerTrackList(meta, currentId) {
  if (!els.musicList) return;
  els.musicList.replaceChildren();
  if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${meta.albumTracks.length} faixas`;

  meta.albumTracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'music-item';
    if (String(track.id) === String(currentId)) item.classList.add('playing');

    const number = document.createElement('div');
    number.className = 'music-item-number';
    number.innerHTML = `<span class="num-text">${index + 1}</span><span class="play-hover">▶</span>`;

    const info = document.createElement('div');
    info.className = 'music-item-info';

    const title = document.createElement('div');
    title.className = 'music-item-title';
    title.textContent = track.title || 'Faixa sem título';

    const artist = document.createElement('div');
    artist.className = 'music-item-artist';
    artist.innerHTML = `${esc(meta.artist || 'Joseph Matthos')} ${track.isrc ? `<span class="music-item-isrc">ISRC: ${esc(track.isrc)}</span>` : ''}`;

    info.append(title, artist);

    const actions = document.createElement('div');
    actions.className = 'music-item-actions';

    // Botão Curtir
    const likeBtn = document.createElement('button');
    likeBtn.className = 'action-icon';
    const key = `jm_like_${meta.id}_${index}`;
    const isLiked = localStorage.getItem(key) === '1';
    likeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${isLiked ? '#1DB954' : 'none'}" stroke="${isLiked ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const liked = localStorage.getItem(key) === '1';
      localStorage.setItem(key, liked ? '0' : '1');
      likeBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${!liked ? '#1DB954' : 'none'}" stroke="${!liked ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
      showToast(liked ? 'Removido dos curtidos' : 'Curtido!');
    });
    actions.appendChild(likeBtn);

    // Botão Compartilhar
    const shareBtn = document.createElement('button');
    shareBtn.className = 'action-icon';
    shareBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>`;
    shareBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;
      const shareData = { title: `${track.title} — Joseph Matthos`, text: `Ouça "${track.title}"`, url };
      if (navigator.share) { try { await navigator.share(shareData); return; } catch {} }
      try { await navigator.clipboard.writeText(url); showToast('Link copiado!'); }
      catch { showToast('Não foi possível compartilhar.'); }
    });
    actions.appendChild(shareBtn);

    // Botão Alugar
    const rentBtn = document.createElement('button');
    rentBtn.className = 'action-icon';
    rentBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2z"/><path d="M9 10v4M15 10v4"/></svg>`;
    rentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = `/?rent=${encodeURIComponent(track.id)}`;
    });
    actions.appendChild(rentBtn);

    // Duração
    const duration = document.createElement('span');
    duration.className = 'music-item-duration';
    duration.textContent = track.locked ? '🔒' : track.durationSeconds ? formatTime(track.durationSeconds) : '--:--';
    actions.appendChild(duration);

    // Menu 3 pontinhos
    const moreBtn = document.createElement('button');
    moreBtn.className = 'action-icon';
    moreBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>`;
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openOptionsMenu(track, meta, index, moreBtn);
    });
    actions.appendChild(moreBtn);

    item.append(number, info, actions);
    item.addEventListener('click', () => window.tocarMusicaDaLista(String(track.id)));
    els.musicList.appendChild(item);
  });
}

// ─── MENU DE OPÇÕES (3 pontinhos) ───
function openOptionsMenu(track, meta, index, anchorEl) {
  document.getElementById('trackOptionsMenu')?.remove();

  const menu = document.createElement('div');
  menu.id = 'trackOptionsMenu';
  menu.className = 'track-options-menu';
  const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;

  menu.innerHTML = `
    <button data-action="share">🔗 Compartilhar</button>
    <button data-action="copy">📋 Copiar link</button>
    <button data-action="rent">🎫 Alugar</button>
    <button data-action="playlist">➕ Adicionar à playlist</button>
    <button data-action="go-album">💿 Ir para o álbum</button>
    <button data-action="go-tracks">🎵 Ir para as faixas</button>
  `;

  document.body.appendChild(menu);

  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const top = Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 10);
  const left = Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 10);
  menu.style.top = `${Math.max(10, top)}px`;
  menu.style.left = `${Math.max(10, left)}px`;

  const close = (ev) => {
    if (!menu.contains(ev.target) && ev.target !== anchorEl) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  menu.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const action = btn.dataset.action;

      if (action === 'share') {
        if (navigator.share) { try { await navigator.share({ title: `${track.title} — Joseph Matthos`, url }); } catch {} }
        else { await navigator.clipboard.writeText(url); showToast('Link copiado!'); }
      } else if (action === 'copy') {
        await navigator.clipboard.writeText(url);
        showToast('Link copiado!');
      } else if (action === 'rent') {
        window.location.href = `/?rent=${encodeURIComponent(track.id)}`;
      } else if (action === 'playlist') {
        showToast('Funcionalidade de playlist em breve.');
      } else if (action === 'go-album') {
        switchTab('albums');
        window.abrirAlbum(meta.id);
      } else if (action === 'go-tracks') {
        switchTab('music');
        renderPlayerTrackList(meta, track.id);
      }

      menu.remove();
    });
  });
}

// ─── MEDIA SESSION (NOTIFICAÇÕES) ───
function updateMediaSessionMetadata(meta) {
  if (!('mediaSession' in navigator)) return;
  const cover = meta.coverUrl || '/assets/img/tema.webp';
  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.title || 'Faixa sem título',
    artist: meta.artist || 'Joseph Matthos',
    album: meta.albumTitle || 'Álbum',
    artwork: [
      { src: cover, sizes: '96x96', type: 'image/webp' },
      { src: cover, sizes: '128x128', type: 'image/webp' },
      { src: cover, sizes: '192x192', type: 'image/webp' },
      { src: cover, sizes: '256x256', type: 'image/webp' },
      { src: cover, sizes: '384x384', type: 'image/webp' },
      { src: cover, sizes: '512x512', type: 'image/webp' }
    ]
  });
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  const handlers = [
    ['play', () => { if (audio.src && audio.paused) audio.play().catch(() => {}); }],
    ['pause', () => { if (!audio.paused) audio.pause(); }],
    ['nexttrack', () => window.playerNext()],
    ['previoustrack', () => window.playerPrev()],
    ['seekbackward', (d) => { audio.currentTime = Math.max(0, audio.currentTime - (Number(d.seekOffset) || 10)); }],
    ['seekforward', (d) => { audio.currentTime = Math.min(audio.duration, audio.currentTime + (Number(d.seekOffset) || 10)); }]
  ];
  for (const [action, handler] of handlers) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch {}
  }
}

// ─── INIT PLAYER ───
async function initPlayer(trackId, autoplay = true) {
  trackId = normalizeTrackId(trackId);
  if (!trackId) return;

  const requestId = ++playerRequestId;
  if (playerAbortController) { try { playerAbortController.abort(); } catch {} }
  playerAbortController = new AbortController();

  currentTrackId = trackId;
  currentTrackMeta = null;
  currentLyricIndex = -1;
  parsedLyrics = [];

  clearInterval(updateInterval);

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  if (els.title) els.title.textContent = 'Carregando...';
  if (els.artist) els.artist.textContent = 'Joseph Matthos';

  try {
    const res = await fetch(`/api/public?track=${encodeURIComponent(trackId)}`, { signal: playerAbortController.signal });
    const meta = await res.json();
    if (!meta.ok) throw new Error(meta.error || 'Erro ao carregar faixa.');

    currentTrackMeta = meta;

    if (els.title) els.title.textContent = meta.title;
    if (els.artist) els.artist.textContent = `${meta.artist || 'Joseph Matthos'} · ${meta.albumTitle || ''}`;

    if (meta.coverUrl) {
      if (els.cover) els.cover.src = meta.coverUrl;
      if (els.container) els.container.style.setProperty('--player-bg', `url('${meta.coverUrl}')`);
    }

    if (els.miniCover) els.miniCover.style.backgroundImage = `url('${meta.coverUrl}')`;
    if (els.miniTitle) els.miniTitle.textContent = meta.title;
    if (els.miniArtist) els.miniArtist.textContent = meta.artist || 'Joseph Matthos';

    renderPlayerTrackList({ ...meta, albumTracks: meta.albumTracks }, trackId);
    updateMediaSessionMetadata(meta);

    audio.src = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
    audio.load();

    if (autoplay) {
      try { await audio.play(); } catch (err) {
        if (err.name === 'NotAllowedError') showToast('Toque em play para iniciar.');
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('[player] Erro:', err);
    if (els.title) els.title.textContent = 'Erro ao carregar';
    if (els.artist) els.artist.textContent = err.message;
  }
}

// ─── CONTROLES ───
window.playerPlay = () => {
  if (!audio.src) { if (currentTrackId) initPlayer(currentTrackId); return; }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
};

window.playerNext = () => {
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;
  const next = tracks[(index + 1) % tracks.length];
  if (next?.id) window.tocarMusicaDaLista(String(next.id));
};

window.playerPrev = () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;
  const prev = tracks[(index - 1 + tracks.length) % tracks.length];
  if (prev?.id) window.tocarMusicaDaLista(String(prev.id));
};

window.tocarMusicaDaLista = async (id) => {
  if (!id) return;
  history.replaceState(null, '', `/player.html?id=${encodeURIComponent(id)}`);
  switchTab('player');
  await initPlayer(id);
};

// ─── EVENTOS DE ÁUDIO ───
function bindAudioEvents() {
  audio.addEventListener('play', () => {
    if (els.playIcon) els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    if (els.miniPlayBtn) els.miniPlayBtn.textContent = '⏸';
    clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      const seek = audio.currentTime || 0;
      const duration = audio.duration || 0;
      const percent = duration > 0 ? Math.min(100, (seek / duration) * 100) : 0;
      if (els.progressFill) els.progressFill.style.width = `${percent}%`;
      if (els.currentTime) els.currentTime.textContent = formatTime(seek);
      if (els.duration) els.duration.textContent = formatTime(duration);
    }, 250);
  });

  audio.addEventListener('pause', () => {
    if (els.playIcon) els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    if (els.miniPlayBtn) els.miniPlayBtn.textContent = '▶';
    clearInterval(updateInterval);
  });

  audio.addEventListener('loadedmetadata', () => {
    if (els.duration) els.duration.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('ended', () => {
    if (repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play();
    } else {
      window.playerNext();
    }
  });
}

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
  bindAudioEvents();
  setupMediaSessionHandlers();

  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');

  if (trackId) {
    await initPlayer(trackId);
  } else {
    if (els.title) els.title.textContent = 'Nenhuma faixa selecionada';
  }
});