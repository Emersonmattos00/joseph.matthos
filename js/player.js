// js/player.js — versão final auditada (com Modo Rádio, ícones e pré-carregamento)

'use strict';

/* ============================================================
   CORREÇÕES E ADIÇÕES APLICADAS:
   - Modo Rádio (?radio=true) com fila do sessionStorage
   - Concorrência: AbortController + requestId
   - onerror: distingue 403 de erro real via format=json
   - Ended: Respeita o modo rádio, repeat e shuffle
   - Media Session: comandos play/pause corretos e setPositionState
   - Ícones de ação na listagem de músicas (curtir, compartilhar, alugar, mais opções)
   - Hover: ícone de Play aparece no lugar do número ao passar o mouse
   - Toast elegante para feedback visual
   - Compartilhamento nativo (navigator.share)
   - Pré-carregamento de imagens para eliminar delay na exibição
   ============================================================ */

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

// Função para mostrar notificações elegantes (Toast)
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

// ─── PRÉ-CARREGAMENTO DE IMAGENS ───
const imageCache = new Map();

function preloadImage(url) {
  if (!url || imageCache.has(url)) return;
  const img = new Image();
  img.src = url;
  imageCache.set(url, img);
}

function preloadAlbumCover(meta) {
  if (!meta || !meta.coverUrl) return;
  preloadImage(meta.coverUrl);
  if (Array.isArray(meta.albumTracks)) {
    meta.albumTracks.forEach(track => {
      if (track.coverUrl) preloadImage(track.coverUrl);
    });
  }
}

const els = {
  container: document.getElementById('playerContainer'),
  cover: document.getElementById('playerCover'),
  title: document.getElementById('playerTitle'),
  artist: document.getElementById('playerArtist'),
  playBtn: document.getElementById('playBtn'),
  playIcon: document.getElementById('playIcon'),
  nextBtn: document.getElementById('nextBtn'),
  prevBtn: document.getElementById('prevBtn'),
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
  radioBadge: document.getElementById('radioBadge')
};

const audio = new Audio();
audio.preload = 'metadata';

let updateInterval = null;
let currentTrackId = null;
let parsedLyrics = [];
let currentLyricIndex = -1;
let currentTrackMeta = null;

// ─── ESTADO DE CONTROLES ───
let shuffleEnabled = false;
let repeatMode = 'off'; // 'off' | 'one' | 'all'

// Concorrência
let playerRequestId = 0;
let playerAbortController = null;

// ─── ESTADO DA RÁDIO ───
let isRadioMode = false;
let radioQueue = [];
let radioIndex = -1;

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
  document.body.classList.remove('immersive-mode');
}

tabs.forEach(tab => tab.addEventListener('click', () => updateTabState(tab)));
function switchTab(tabName) {
  const btn = document.querySelector(`.mobile-tab[data-tab="${tabName}"]`);
  if (btn) updateTabState(btn);
}

// ─── MODO IMERSIVO ───
function toggleModoImersivo() {
  const playerTab = document.getElementById('tab-player');
  if (!playerTab || !playerTab.classList.contains('active')) return;
  if (!audio.src || audio.paused) return;
  document.body.classList.toggle('immersive-mode');
}

let touchStartTime = 0;
els.container.addEventListener('touchstart', (e) => {
  if (e.target.closest('button, .mobile-tab, .progress-bar')) return;
  touchStartTime = Date.now();
}, { passive: true });

els.container.addEventListener('touchend', (e) => {
  if (e.target.closest('button, .mobile-tab, .progress-bar')) return;
  if (Date.now() - touchStartTime < 300) toggleModoImersivo();
});

els.container.addEventListener('click', (e) => {
  if (e.target.closest('button, .mobile-tab, .progress-bar')) return;
  if (Date.now() - touchStartTime < 500) return;
  toggleModoImersivo();
});

// ─── TELA CHEIA ───
if (els.fullscreenBtn) {
  els.fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      const el = els.container;
      if (el.requestFullscreen) el.requestFullscreen();
      else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });
}

// ─── FETCH DE METADADOS ───
async function fetchMetadata(trackId, signal) {
  const r = await fetch(`/api/public?track=${encodeURIComponent(trackId)}`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', signal
  });
  if (!r.ok) {
    if (r.status === 404) throw new Error('Faixa não encontrada ou não publicada.');
    throw new Error(`Erro ao consultar faixa: HTTP ${r.status}`);
  }
  const data = await r.json();
  if (!data || typeof data !== 'object' || !data.id || !data.title || !Array.isArray(data.albumTracks)) {
    throw new Error('A API retornou dados incompletos.');
  }
  return data;
}

// ─── DIAGNÓSTICO DO STREAM ───
async function diagnoseStreamError(trackId) {
  try {
    const r = await fetch(`/api/stream?trackId=${encodeURIComponent(trackId)}&format=json&t=${Date.now()}`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store'
    });
    if (r.ok) return { status: 'ok' };
    if (r.status === 403) return { status: 'forbidden', message: 'Prévia indisponível. Assine ou alugue.' };
    if (r.status === 404) return { status: 'not_found', message: 'Áudio não configurado.' };
    if (r.status === 503) return { status: 'unavailable', message: 'Serviço temporariamente indisponível.' };
    if (r.status === 429) return { status: 'rate_limited', message: 'Muitas requisições.' };
    return { status: 'error', message: `Erro HTTP ${r.status}.` };
  } catch {
    return { status: 'network', message: 'Verifique sua conexão.' };
  }
}

// ─── MEDIA SESSION ───
function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator)) return;
  if (typeof navigator.mediaSession.setPositionState !== 'function') return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  if (!Number.isFinite(audio.currentTime)) return;

  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration)
    });
  } catch (error) {
    console.warn('[player] Posição Media Session:', error);
  }
}

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

  const actionHandlers = [
    ['play', () => {
      if (audio.src && audio.paused) audio.play().catch(err => console.warn('[player] Falha ao reproduzir:', err));
      else if (!audio.src && currentTrackId) initPlayer(currentTrackId, true);
    }],
    ['pause', () => { if (!audio.paused) audio.pause(); }],
    ['nexttrack', () => window.playerNext()],
    ['previoustrack', () => window.playerPrev()],
    ['seekbackward', (details) => { audio.currentTime = Math.max(audio.currentTime - (details.seekOffset || 10), 0); }],
    ['seekforward', (details) => { audio.currentTime = Math.min(audio.currentTime + (details.seekOffset || 10), audio.duration); }],
    ['seekto', (details) => {
      if (details.fastSeek && 'fastSeek' in audio) { audio.fastSeek(details.seekTime); return; }
      audio.currentTime = details.seekTime;
    }]
  ];

  for (const [action, handler] of actionHandlers) {
    try { navigator.mediaSession.setActionHandler(action, handler); } 
    catch (e) { console.warn(`Ação "${action}" não suportada.`); }
  }
}

// ─── LETRA ───
function renderLyrics(lyricsArray) {
  if (!Array.isArray(lyricsArray) || !lyricsArray.length) {
    els.lyricsContent.innerHTML = '<p class="lyrics-empty">Esta faixa não tem letra cadastrada.</p>';
    parsedLyrics = [];
    currentLyricIndex = -1;
    return;
  }
  const validLyrics = lyricsArray.filter(line => line && typeof line === 'object' && Number.isFinite(Number(line.time)) && typeof line.text === 'string');
  if (!validLyrics.length) {
    els.lyricsContent.innerHTML = '<p class="lyrics-empty">Letra indisponível.</p>';
    parsedLyrics = [];
    currentLyricIndex = -1;
    return;
  }
  els.lyricsContent.innerHTML = validLyrics.map((line, index) => `
    <button class="lyric-line" data-index="${index}" data-time="${Number(line.time)}" type="button">${esc(line.text)}</button>
  `).join('');

  parsedLyrics = validLyrics.map((line, index) => ({
    time: Number(line.time),
    element: els.lyricsContent.querySelector(`[data-index="${index}"]`)
  }));
  currentLyricIndex = -1;

  els.lyricsContent.querySelectorAll('.lyric-line').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!audio.src || !Number.isFinite(audio.duration)) return;
      audio.currentTime = Number(btn.dataset.time);
      highlightLyricLine(Number(btn.dataset.index));
    });
  });
}

function highlightLyricLine(index) {
  if (index < 0 || index >= parsedLyrics.length) return;
  parsedLyrics.forEach((l, i) => l.element.classList.toggle('active', i === index));
  const active = parsedLyrics[index].element;
  if (active && document.getElementById('tab-lyrics').classList.contains('active')) {
    const container = els.lyricsContent;
    const scrollPos = active.offsetTop - (container.clientHeight / 2) + (active.clientHeight / 2);
    container.scrollTo({ top: scrollPos, behavior: 'smooth' });
  }
}

function syncLyrics() {
  if (!audio || !parsedLyrics.length) return;
  const seek = audio.currentTime || 0;
  let newIndex = -1;
  for (let i = 0; i < parsedLyrics.length; i++) {
    if (parsedLyrics[i].time <= seek) newIndex = i;
    else break;
  }
  if (newIndex !== currentLyricIndex) {
    currentLyricIndex = newIndex;
    highlightLyricLine(newIndex);
  }
}

// ─── LISTA DE MÚSICAS (COM ÍCONES E HOVER) ───
function renderPlayerTrackList(meta, currentId) {
  els.musicList.replaceChildren();
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
    artist.textContent = meta.artist || 'Joseph Matthos';

    info.append(title, artist);

    const actions = document.createElement('div');
    actions.className = 'music-item-actions';

    const atualizarIconeCurtir = (btn) => {
      const key = `jm_like_${meta.id}_${index}`;
      const isLiked = localStorage.getItem(key) === '1';
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="${isLiked ? '#1DB954' : 'none'}" stroke="${isLiked ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
    };

    // Curtir
    const likeBtn = document.createElement('button');
    likeBtn.className = 'action-icon';
    atualizarIconeCurtir(likeBtn);
    likeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = `jm_like_${meta.id}_${index}`;
      const liked = localStorage.getItem(key) === '1';
      localStorage.setItem(key, liked ? '0' : '1');
      atualizarIconeCurtir(likeBtn);
      showToast(liked ? 'Removido dos curtidos' : 'Curtido!');
    });
    actions.appendChild(likeBtn);

    // Compartilhar
    const shareBtn = document.createElement('button');
    shareBtn.className = 'action-icon';
    shareBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
    shareBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;
      const shareData = { title: `${track.title} — Joseph Matthos`, text: `Ouça "${track.title}" de Joseph Matthos`, url };
      if (navigator.share) {
        try { await navigator.share(shareData); return; } catch {}
      }
      try {
        await navigator.clipboard.writeText(url);
        showToast('Link copiado!');
      } catch {
        showToast('Não foi possível compartilhar.');
      }
    });
    actions.appendChild(shareBtn);

    // Alugar
    const rentBtn = document.createElement('button');
    rentBtn.className = 'action-icon';
    rentBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2z"/><path d="M9 10v4M15 10v4"/></svg>';
    rentBtn.title = 'Alugar';
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

    // Mais opções
    const moreBtn = document.createElement('button');
    moreBtn.className = 'action-icon';
    moreBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>';
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      document.getElementById('playerTrackMenu')?.remove();
      
      const menu = document.createElement('div');
      menu.id = 'playerTrackMenu';
      menu.className = 'track-more-menu';
      menu.style.position = 'fixed';
      menu.style.zIndex = '9999';
      
      const liked = localStorage.getItem(`jm_like_${meta.id}_${index}`) === '1';
      
      menu.innerHTML = `
        <button type="button" data-menu-action="like">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="${liked ? '#1DB954' : 'none'}" stroke="${liked ? '#1DB954' : 'currentColor'}" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          <span>${liked ? 'Remover dos curtidos' : 'Curtir'}</span>
        </button>
        <button type="button" data-menu-action="share">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z"/></svg>
          <span>Compartilhar</span>
        </button>
        <button type="button" data-menu-action="rent">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2zm-4.42 4.8L13 14.62V17h-2v-6h2v2.38l2.58-2.18 1.42 1.4L14.42 15l2.58 2.4-1.42 1.4z"/></svg>
          <span>Alugar</span>
        </button>
        <button type="button" data-menu-action="copy-link">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
          <span>Copiar link</span>
        </button>
      `;
      
      document.body.appendChild(menu);
      
      const rect = moreBtn.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const top = Math.min(rect.bottom + 6, window.innerHeight - menuRect.height - 10);
      const left = Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 10);
      menu.style.top = `${Math.max(10, top)}px`;
      menu.style.left = `${Math.max(10, left)}px`;
      
      const close = (ev) => { if (!menu.contains(ev.target) && ev.target !== moreBtn) { menu.remove(); document.removeEventListener('click', close); } };
      setTimeout(() => document.addEventListener('click', close), 0);
      
      menu.querySelectorAll('[data-menu-action]').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const act = btn.dataset.menuAction;
          
          if (act === 'like') {
            const key = `jm_like_${meta.id}_${index}`;
            const isLiked = localStorage.getItem(key) === '1';
            localStorage.setItem(key, isLiked ? '0' : '1');
            atualizarIconeCurtir(likeBtn);
            showToast(isLiked ? 'Removido dos curtidos' : 'Curtido!');
          } else if (act === 'share') {
            const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;
            const shareData = { title: `${track.title} — Joseph Matthos`, text: `Ouça "${track.title}" de Joseph Matthos`, url };
            if (navigator.share) {
              try { await navigator.share(shareData); return; } catch {}
            }
            try {
              await navigator.clipboard.writeText(url);
              showToast('Link copiado!');
            } catch {
              showToast('Não foi possível compartilhar.');
            }
          } else if (act === 'rent') {
            window.location.href = `/?rent=${encodeURIComponent(track.id)}`;
          } else if (act === 'copy-link') {
            const url = `${location.origin}/player.html?id=${encodeURIComponent(track.id)}`;
            await navigator.clipboard.writeText(url);
            showToast('Link copiado!');
          }
          
          menu.remove();
        });
      });
    });
    actions.appendChild(moreBtn);

    item.append(number, info, actions);
    item.addEventListener('click', () => window.tocarMusicaDaLista(String(track.id)));
    els.musicList.appendChild(item);
  });
}

// ─── INIT ───
async function initPlayer(trackId, autoplay = true) {
  if (!trackId || typeof trackId !== 'string') {
    els.title.textContent = 'Nenhuma faixa selecionada';
    return;
  }

  const requestId = ++playerRequestId;
  if (playerAbortController) { try { playerAbortController.abort(); } catch {} }
  playerAbortController = new AbortController();

  currentTrackId = trackId;
  currentTrackMeta = null;
  currentLyricIndex = -1;
  parsedLyrics = [];

  clearInterval(updateInterval);
  document.body.classList.remove('immersive-mode');

  audio.pause();
  audio.removeAttribute('src');
  audio.load();

  els.title.textContent = 'Carregando faixa...';
  els.artist.textContent = 'Joseph Matthos';
  els.currentTime.textContent = '0:00';
  els.duration.textContent = '0:00';
  els.progressFill.style.width = '0%';
  if (els.progressBar) els.progressBar.setAttribute('aria-valuenow', '0');

  try {
    const meta = await fetchMetadata(trackId, playerAbortController.signal);
    if (requestId !== playerRequestId) return;
    currentTrackMeta = meta;

    // Pré-carrega a imagem antes de exibir
    preloadAlbumCover(meta);

    els.title.textContent = meta.title;
    els.artist.textContent = `${meta.artist || 'Joseph Matthos'} · ${meta.albumTitle || ''}`;

    if (meta.coverUrl) {
      if (els.cover.tagName === 'IMG') els.cover.src = meta.coverUrl;
      else els.cover.style.backgroundImage = `url('${meta.coverUrl}')`;
      els.container.style.setProperty('--player-bg', `url('${meta.coverUrl}')`);
      els.albumHeaderCover.style.backgroundImage = `url('${meta.coverUrl}')`;
    } else {
      if (els.cover.tagName === 'IMG') els.cover.removeAttribute('src');
      else els.cover.style.backgroundImage = '';
      els.container.style.removeProperty('--player-bg');
      els.albumHeaderCover.style.backgroundImage = '';
    }

    renderLyrics(meta.lyrics);
    els.albumHeaderTitle.textContent = meta.albumTitle || 'Álbum';
    els.albumHeaderArtist.textContent = meta.artist || 'Joseph Matthos';
    els.albumHeaderCount.textContent = `${meta.albumTracks.length} faixas`;

    renderPlayerTrackList(meta, trackId);
    updateMediaSessionMetadata(meta);

    const streamUrl = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
    audio.src = streamUrl;
    audio.load();

    if (requestId !== playerRequestId) return;

    if (autoplay) {
      try {
        await audio.play();
      } catch (err) {
        if (requestId === playerRequestId && err?.name !== 'AbortError') {
          console.warn('[player] Autoplay bloqueado:', err?.message || err);
        }
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId !== playerRequestId) return;
    console.error('[player] Erro ao carregar faixa:', error);
    currentTrackMeta = null;
    currentTrackId = null;
    els.title.textContent = 'Não foi possível carregar a faixa';
    els.artist.textContent = error.message || 'Tente novamente.';
  }
}

// ─── ÁUDIO: EVENTOS ───
function bindAudioEvents() {
  audio.addEventListener('play', () => {
    els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      const seek = audio.currentTime || 0;
      const duration = audio.duration || 0;
      const percent = duration > 0 && Number.isFinite(duration) ? Math.min(100, (seek / duration) * 100) : 0;
      els.progressFill.style.width = `${percent}%`;
      if (els.progressBar) {
        els.progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
        els.progressBar.setAttribute('aria-valuetext', `${formatTime(seek)} de ${formatTime(duration)}`);
      }
      els.currentTime.textContent = formatTime(seek);
      syncLyrics();
    }, 250);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  audio.addEventListener('pause', () => {
    els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    clearInterval(updateInterval);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  audio.addEventListener('loadedmetadata', () => {
    els.duration.textContent = formatTime(audio.duration);
    updateMediaSessionPosition();
  });

  audio.addEventListener('timeupdate', updateMediaSessionPosition);
  audio.addEventListener('seeked', updateMediaSessionPosition);
  audio.addEventListener('ratechange', updateMediaSessionPosition);

  audio.addEventListener('error', async () => {
    const error = audio.error;
    console.error('[player] Erro no áudio:', { code: error?.code, message: error?.message, source: audio.currentSrc });
    if (!currentTrackId) return;
    const trackId = currentTrackId;

    if (error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      els.title.textContent = 'Erro ao carregar áudio';
      els.artist.textContent = 'Verificando disponibilidade...';
      const diag = await diagnoseStreamError(trackId);
      if (trackId !== currentTrackId) return;

      if (diag.status === 'forbidden') {
        els.title.textContent = 'Prévia indisponível';
        els.artist.textContent = 'Assine o Premium ou alugue para ouvir esta faixa.';
      } else if (diag.status === 'not_found') {
        els.title.textContent = 'Áudio não configurado';
        els.artist.textContent = 'Esta faixa ainda não tem arquivo de áudio.';
      } else if (diag.status === 'ok') {
        els.title.textContent = 'Formato não suportado';
        els.artist.textContent = 'O navegador não consegue reproduzir este arquivo.';
      } else {
        els.title.textContent = 'Erro ao carregar áudio';
        els.artist.textContent = diag.message || 'Tente novamente.';
      }
    } else if (error?.code === MediaError.MEDIA_ERR_NETWORK) {
      els.title.textContent = 'Erro de rede';
      els.artist.textContent = 'Verifique sua conexão ou tente novamente.';
    } else if (error?.code === MediaError.MEDIA_ERR_DECODE) {
      els.title.textContent = 'Arquivo corrompido';
      els.artist.textContent = 'Não foi possível decodificar o áudio.';
    } else {
      els.title.textContent = 'Erro ao carregar áudio';
      els.artist.textContent = 'Tente novamente.';
    }
  });

  audio.addEventListener('ended', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';

    if (isRadioMode) {
      if (radioIndex + 1 < radioQueue.length) {
        radioIndex++;
        sessionStorage.setItem('radio_index', String(radioIndex));
        const next = radioQueue[radioIndex];
        window.tocarMusicaDaLista(String(next.trackId));
      } else {
        radioIndex = 0;
        sessionStorage.setItem('radio_index', String(radioIndex));
        const first = radioQueue[0];
        window.tocarMusicaDaLista(String(first.trackId));
      }
      return;
    }

    if (repeatMode === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }

    if (!currentTrackMeta?.albumTracks) return;
    const tracks = currentTrackMeta.albumTracks;
    const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
    if (index < 0) return;

    let nextIndex;
    if (shuffleEnabled) {
      nextIndex = getRandomTrackIndex(tracks, index);
    } else if (index < tracks.length - 1) {
      nextIndex = index + 1;
    } else if (repeatMode === 'all') {
      nextIndex = 0;
    } else {
      return;
    }

    const next = tracks[nextIndex];
    if (next?.id) window.tocarMusicaDaLista(String(next.id));
  });
}

function getRandomTrackIndex(tracks, currentIndex) {
  if (!Array.isArray(tracks) || tracks.length <= 1) return currentIndex;
  let nextIndex;
  do { nextIndex = Math.floor(Math.random() * tracks.length); } 
  while (nextIndex === currentIndex);
  return nextIndex;
}

// ─── PROGRESS BAR: TECLADO ───
if (els.progressBar) {
  els.progressBar.addEventListener('keydown', (e) => {
    if (!audio.duration || !Number.isFinite(audio.duration)) return;
    const step = 5;
    let newTime = audio.currentTime;
    switch (e.key) {
      case 'ArrowLeft':  newTime -= step; break;
      case 'ArrowRight': newTime += step; break;
      case 'Home':       newTime = 0; break;
      case 'End':        newTime = audio.duration; break;
      default: return;
    }
    e.preventDefault();
    audio.currentTime = Math.max(0, Math.min(audio.duration, newTime));
  });
}

// ─── CONTROLES GLOBAIS ───
window.playerPlay = () => {
  if (!audio.src) {
    if (currentTrackId) initPlayer(currentTrackId, true);
    return;
  }
  if (audio.paused) audio.play().catch(err => console.error('[player] play() falhou:', err));
  else audio.pause();
};

window.playerNext = () => {
  if (isRadioMode) {
    if (radioIndex + 1 < radioQueue.length) radioIndex++;
    else radioIndex = 0;
    sessionStorage.setItem('radio_index', String(radioIndex));
    window.tocarMusicaDaLista(String(radioQueue[radioIndex].trackId));
    return;
  }

  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  if (!tracks.length) return;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;

  const nextIndex = shuffleEnabled ? getRandomTrackIndex(tracks, index) : (index < tracks.length - 1 ? index + 1 : 0);
  const next = tracks[nextIndex];
  if (next?.id) window.tocarMusicaDaLista(String(next.id));
};

window.playerPrev = () => {
  if (isRadioMode) {
    if (radioIndex > 0) radioIndex--;
    else radioIndex = radioQueue.length - 1;
    sessionStorage.setItem('radio_index', String(radioIndex));
    window.tocarMusicaDaLista(String(radioQueue[radioIndex].trackId));
    return;
  }

  if (!currentTrackMeta?.albumTracks) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const tracks = currentTrackMeta.albumTracks;
  if (!tracks.length) return;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;

  const prevIndex = shuffleEnabled ? getRandomTrackIndex(tracks, index) : (index > 0 ? index - 1 : tracks.length - 1);
  const prev = tracks[prevIndex];
  if (prev?.id) window.tocarMusicaDaLista(String(prev.id));
};

els.progressBar?.addEventListener('click', (e) => {
  if (!audio.duration || !Number.isFinite(audio.duration)) return;
  const rect = els.progressBar.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  audio.currentTime = audio.duration * Math.max(0, Math.min(1, pos));
});

window.tocarMusicaDaLista = async (id) => {
  if (!id) return;
  const safeId = String(id);
  history.replaceState(null, '', `/player.html?id=${encodeURIComponent(safeId)}${isRadioMode ? '&radio=true' : ''}`);
  switchTab('player');
  
  // Pré-carrega a imagem se já tivermos os metadados
  if (currentTrackMeta && currentTrackMeta.albumTracks) {
    const track = currentTrackMeta.albumTracks.find(t => String(t.id) === safeId);
    if (track && track.coverUrl) preloadImage(track.coverUrl);
  }
  
  await initPlayer(safeId);
};

// ─── SHUFFLE / REPEAT ───
if (els.shuffleBtn) {
  els.shuffleBtn.addEventListener('click', () => {
    if (isRadioMode) return;
    shuffleEnabled = !shuffleEnabled;
    els.shuffleBtn.setAttribute('aria-pressed', String(shuffleEnabled));
    els.shuffleBtn.classList.toggle('active', shuffleEnabled);
  });
}

if (els.repeatBtn) {
  els.repeatBtn.addEventListener('click', () => {
    if (isRadioMode) return;
    const order = ['off', 'all', 'one'];
    repeatMode = order[(order.indexOf(repeatMode) + 1) % order.length];
    els.repeatBtn.setAttribute('aria-pressed', String(repeatMode !== 'off'));
    els.repeatBtn.classList.toggle('active', repeatMode !== 'off');
    els.repeatBtn.dataset.mode = repeatMode;
    els.repeatBtn.setAttribute('aria-label',
      repeatMode === 'off' ? 'Repetir: desligado' :
      repeatMode === 'all' ? 'Repetir: todas' : 'Repetir: uma'
    );
  });
}

// ─── MODAIS ───
window.abrirModalAssinatura = () => { window.location.href = '/#planos'; };
window.abrirModalAluguel = () => {
  if (!currentTrackId) return;
  window.location.href = `/?rent=${encodeURIComponent(currentTrackId)}`;
};

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
  bindAudioEvents();
  setupMediaSessionHandlers();

  const params = new URLSearchParams(window.location.search);
  isRadioMode = params.get('radio') === 'true';
  const trackId = params.get('id');

  if (isRadioMode) {
    if (els.radioBadge) els.radioBadge.style.display = 'flex';
    if (els.shuffleBtn) els.shuffleBtn.style.display = 'none';
    if (els.repeatBtn) els.repeatBtn.style.display = 'none';

    try {
      radioQueue = JSON.parse(sessionStorage.getItem('radio_queue') || '[]');
      radioIndex = parseInt(sessionStorage.getItem('radio_index') || '0', 10);
    } catch {
      radioQueue = [];
      radioIndex = 0;
    }

    if (!radioQueue.length) {
      els.title.textContent = 'Fila da rádio vazia';
      return;
    }

    const initialTrack = trackId || radioQueue[radioIndex]?.trackId;
    if (initialTrack) {
      await initPlayer(initialTrack);
    }
    return;
  }

  if (!trackId) {
    els.title.textContent = 'Nenhuma faixa selecionada';
    return;
  }
  await initPlayer(trackId);
});

window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (trackId && trackId !== currentTrackId) {
    initPlayer(trackId);
  }
});