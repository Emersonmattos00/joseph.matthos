<<<<<<< HEAD
// js/player.js — Versão Final Consolidada

'use strict';

/* ============================================================
   CORREÇÕES APLICADAS:
   - Alinhamento com api/stream.js (leitura de JSON no diagnóstico)
   - Concorrência dupla: playerRequestId e playbackGeneration
   - Media Session: comandos play/pause corretos e setPositionState
   - Acessibilidade: aria-valuetext, repeat via ciclo de teclado
   - Shuffle inteligente (não repete a mesma faixa)
   ============================================================ */
=======
// js/player.js — versão final (API redireciona para o Cloudflare Worker)
>>>>>>> upstream/main

function formatTime(secs) {
  if (isNaN(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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
  fullscreenBtn: document.getElementById('fullscreenBtn')
};

<<<<<<< HEAD
const audio = new Audio();
audio.preload = 'metadata';

=======
let audio = new Audio();
audio.preload = 'none'; // ★ não baixa áudio antes do play (essencial com 330+ faixas)
>>>>>>> upstream/main
let updateInterval = null;
let currentTrackId = null;
let parsedLyrics = [];
let currentLyricIndex = -1;
<<<<<<< HEAD
let currentTrackMeta = null;

let shuffleEnabled = false;
let repeatMode = 'off'; // 'off' | 'one' | 'all'

// Controle de concorrência de metadados e áudio
let playerRequestId = 0;
let playbackGeneration = 0;
let playerAbortController = null;
let currentStreamUrl = '';
=======
let currentTrackMeta = null; // ★ guarda metadados da faixa atual para próximo/anterior
>>>>>>> upstream/main

// ─── ABAS ───
const tabs = document.querySelectorAll('.mobile-tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    document.body.classList.remove('immersive-mode');
  });
});

function switchTab(tabName) {
  const btn = document.querySelector(`.mobile-tab[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

// ─── MODO IMERSIVO ───
function toggleModoImersivo() {
  if (!document.getElementById('tab-player').classList.contains('active')) return;
  if (!audio.src || audio.paused) return;
  document.body.classList.toggle('immersive-mode');
}

let touchStartTime = 0;
<<<<<<< HEAD
if (els.container) {
  els.container.addEventListener('touchstart', (e) => {
    if (e.target.closest('button, .mobile-tab, .progress-bar')) return;
    touchStartTime = Date.now();
  }, { passive: true });

  els.container.addEventListener('touchend', (e) => {
    if (e.target.closest('button, .mobile-tab, .progress-bar')) return;
    const elapsed = Date.now() - touchStartTime;
    if (elapsed < 300) toggleModoImersivo();
  });

  els.container.addEventListener('click', (e) => {
    if (e.target.closest('button, .mobile-tab, .progress-bar')) return;
    if (touchStartTime && Date.now() - touchStartTime < 500) return;
    toggleModoImersivo();
  });
}
=======
els.container.addEventListener('touchstart', (e) => {
  if (e.target.closest('button') || e.target.closest('.mobile-tab') || e.target.closest('.progress-bar')) return;
  touchStartTime = Date.now();
}, { passive: true });

els.container.addEventListener('touchend', (e) => {
  if (e.target.closest('button') || e.target.closest('.mobile-tab') || e.target.closest('.progress-bar')) return;
  if (Date.now() - touchStartTime < 300) toggleModoImersivo();
});

els.container.addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.closest('.mobile-tab') || e.target.closest('.progress-bar')) return;
  if (Date.now() - touchStartTime < 500) return;
  toggleModoImersivo();
});
>>>>>>> upstream/main

// ─── TELA CHEIA ───
if (els.fullscreenBtn) {
  els.fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      if (els.container.requestFullscreen) els.container.requestFullscreen();
      else if (els.container.webkitRequestFullscreen) els.container.webkitRequestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });
}

<<<<<<< HEAD
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
  if (!data || !data.id || !data.title || !Array.isArray(data.albumTracks)) {
    throw new Error('A API retornou dados incompletos.');
  }
  return data;
}

// ─── DIAGNÓSTICO DO STREAM (Alinhado ao api/stream.js) ───
async function diagnoseStreamError(trackId) {
  try {
    const r = await fetch(`/api/stream?trackId=${encodeURIComponent(trackId)}&format=json&t=${Date.now()}`, { 
      method: 'GET', credentials: 'same-origin', cache: 'no-store' 
    });
    
    const data = await r.json().catch(() => ({}));

    if (r.ok) return { status: 'ok' };
    
    // O backend envia 403 quando não há previewKey para não-assinantes
    if (r.status === 403) return { status: 'forbidden', message: data.error || 'Prévia indisponível. Assine ou alugue.' };
    // O backend envia 404 quando não há streamKey para assinantes
    if (r.status === 404) return { status: 'not_found', message: data.error || 'Áudio não configurado.' };
    if (r.status === 503) return { status: 'unavailable', message: data.error || 'Serviço temporariamente indisponível.' };
    if (r.status === 429) return { status: 'rate_limited', message: data.error || 'Muitas requisições. Tente em instantes.' };
    
    return { status: 'error', message: data.error || `Erro HTTP ${r.status}.` };
  } catch {
    return { status: 'network', message: 'Verifique sua conexão.' };
  }
=======
// ─── FETCHES ───
async function fetchMetadata(trackId) {
  const r = await fetch(`/api/public?track=${encodeURIComponent(trackId)}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Faixa não encontrada');
  return await r.json();
>>>>>>> upstream/main
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
      if (audio.src && audio.paused) {
        audio.play().catch(err => console.warn('[player] Falha ao reproduzir:', err));
      } else if (!audio.src && currentTrackId) {
        initPlayer(currentTrackId, true);
      }
    }],
    ['pause', () => {
      if (!audio.paused) audio.pause();
    }],
    ['nexttrack', () => window.playerNext()],
    ['previoustrack', () => window.playerPrev()],
    ['seekbackward', (details) => {
      audio.currentTime = Math.max(audio.currentTime - (details.seekOffset || 10), 0);
    }],
    ['seekforward', (details) => {
      audio.currentTime = Math.min(audio.currentTime + (details.seekOffset || 10), audio.duration);
    }],
    ['seekto', (details) => {
      if (details.fastSeek && 'fastSeek' in audio) {
        audio.fastSeek(details.seekTime);
        return;
      }
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
  if (!lyricsArray || !lyricsArray.length) {
    els.lyricsContent.innerHTML = '<p class="lyrics-empty">Esta faixa não tem letra cadastrada.</p>';
    parsedLyrics = [];
    return;
  }
<<<<<<< HEAD

  const validLyrics = lyricsArray
    .filter(line =>
      line && typeof line === 'object' &&
      line.time !== null && line.time !== '' &&
      Number.isFinite(Number(line.time)) && Number(line.time) >= 0 &&
      typeof line.text === 'string'
    )
    .map(line => ({ time: Number(line.time), text: line.text }))
    .sort((a, b) => a.time - b.time);

  if (!validLyrics.length) {
    els.lyricsContent.innerHTML = '<p class="lyrics-empty">Letra indisponível.</p>';
    parsedLyrics = [];
    currentLyricIndex = -1;
    return;
  }

  els.lyricsContent.innerHTML = validLyrics.map((line, index) => `
    <button class="lyric-line" data-index="${index}" data-time="${line.time}" type="button">${esc(line.text)}</button>
  `).join('');

  parsedLyrics = validLyrics.map((line, index) => ({
    time: line.time,
    element: els.lyricsContent.querySelector(`[data-index="${index}"]`)
=======
  els.lyricsContent.innerHTML = lyricsArray.map((l, i) => `
    <button class="lyric-line" data-index="${i}" data-time="${l.time}">${esc(l.text || '')}</button>
  `).join('');
  parsedLyrics = lyricsArray.map((l, i) => ({
    time: Number(l.time) || 0,
    element: els.lyricsContent.querySelector(`[data-index="${i}"]`)
>>>>>>> upstream/main
  }));
  els.lyricsContent.querySelectorAll('.lyric-line').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!audio.src) return;
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

<<<<<<< HEAD
// ─── LISTA DE MÚSICAS ───
function renderPlayerTrackList(meta, currentId) {
  els.musicList.replaceChildren();

  meta.albumTracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'music-item';
    if (String(track.id) === String(currentId)) item.classList.add('playing');

    const number = document.createElement('div');
    number.className = 'music-item-number';
    number.textContent = String(index + 1);

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

    const duration = document.createElement('span');
    duration.className = 'music-item-duration';
    duration.textContent = track.locked ? '🔒' : track.durationSeconds ? formatTime(track.durationSeconds) : '--:--';

    actions.append(duration);
    item.append(number, info, actions);

    item.addEventListener('click', () => window.tocarMusicaDaLista(String(track.id)));
    els.musicList.appendChild(item);
  });
}

// ─── INIT ───
async function initPlayer(trackId, autoplay = true) {
  if (typeof trackId !== 'string' || !trackId.trim() || trackId.length > 100) {
    els.title.textContent = 'Identificador de faixa inválido';
    return;
  }

  const requestId = ++playerRequestId;
  const generation = ++playbackGeneration;

  if (playerAbortController) {
    try { playerAbortController.abort(); } catch {}
  }
  playerAbortController = new AbortController();

=======
// ─── INIT ───
async function initPlayer(trackId, autoplay = true) {
>>>>>>> upstream/main
  currentTrackId = trackId;
  currentLyricIndex = -1;
  document.body.classList.remove('immersive-mode');

  let meta;
  try { meta = await fetchMetadata(trackId); }
  catch (err) { els.title.textContent = 'Faixa não encontrada'; return; }

  currentTrackMeta = meta;

  // 1. UI principal
  els.title.textContent = meta.title;
  els.artist.textContent = `${meta.artist} · ${meta.albumTitle}`;

  if (meta.coverUrl) {
    if (els.cover.tagName === 'IMG') els.cover.src = meta.coverUrl;
    else els.cover.style.backgroundImage = `url('${meta.coverUrl}')`;
    els.container.style.setProperty('--player-bg', `url('${meta.coverUrl}')`);
  }

  renderLyrics(meta.lyrics);

  // 2. Lista
  if (meta.coverUrl) {
    els.albumHeaderCover.style.backgroundImage = `url('${meta.coverUrl}')`;
  }
  els.albumHeaderTitle.textContent = meta.albumTitle;
  els.albumHeaderArtist.textContent = meta.artist;
  els.albumHeaderCount.textContent = `${meta.albumTracks.length} faixas`;

  els.musicList.innerHTML = meta.albumTracks.map((t, index) => {
    const isPlaying = t.id === trackId;
    const dur = t.durationSeconds ? formatTime(t.durationSeconds) : '--:--';
    return `
      <div class="music-item ${isPlaying ? 'playing' : ''}" onclick="window.tocarMusicaDaLista('${t.id}')">
        <div class="music-item-number">${index + 1}</div>
        <div class="music-item-info">
          <div class="music-item-title">${esc(t.title)}</div>
          <div class="music-item-artist">${esc(meta.artist)}</div>
        </div>
        <div class="music-item-actions">
          <button class="action-icon" onclick="event.stopPropagation();">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
          </button>
          <button class="action-icon" onclick="event.stopPropagation();">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>
          </button>
          <span class="music-item-duration">${t.locked ? '🔒' : dur}</span>
        </div>
      </div>
    `;
  }).join('');

  // ★ 3. Áudio: chama a API que AUTORIZA e REDIRECIONA para o Cloudflare Worker.
  // O navegador segue o 302 e busca direto no CDN (cache de borda, egress zero do B2 após o 1º hit).
  const streamUrl = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
  // ★ t=... evita cache do navegador na decisão de autorização (a URL do CDN em si é cacheada normalmente)

  audio.pause();
  audio.removeAttribute('src');
  audio.src = streamUrl;
  audio.load();

<<<<<<< HEAD
  els.title.textContent = 'Carregando faixa...';
  els.artist.textContent = 'Joseph Matthos';
  els.currentTime.textContent = '0:00';
  els.duration.textContent = '0:00';
  els.progressFill.style.width = '0%';
  if (els.progressBar) {
    els.progressBar.setAttribute('aria-valuenow', '0');
    els.progressBar.setAttribute('aria-valuetext', '0:00 de 0:00');
  }

  try {
    const meta = await fetchMetadata(trackId, playerAbortController.signal);

    if (requestId !== playerRequestId) return;

    if (!meta || !meta.id || String(meta.id) !== String(trackId)) {
      els.title.textContent = 'Dados da faixa inválidos';
      return;
    }

    currentTrackMeta = meta;
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
    currentStreamUrl = new URL(streamUrl, window.location.origin).href;
    
    audio.src = currentStreamUrl;
    audio.load();

    if (requestId !== playerRequestId || generation !== playbackGeneration) return;

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
=======
  audio.onplay = () => {
>>>>>>> upstream/main
    els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    clearInterval(updateInterval);
    
    updateInterval = setInterval(() => {
      const seek = audio.currentTime || 0;
      const duration = audio.duration || 0;
<<<<<<< HEAD
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
=======
      if (duration > 0) {
        els.progressFill.style.width = `${(seek / duration) * 100}%`;
      }
      els.currentTime.textContent = formatTime(seek);
      syncLyrics();
    }, 250);
  };
>>>>>>> upstream/main

  audio.onpause = () => {
    els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    clearInterval(updateInterval);
<<<<<<< HEAD
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });
=======
  };
>>>>>>> upstream/main

  audio.onloadedmetadata = () => {
    els.duration.textContent = formatTime(audio.duration);
<<<<<<< HEAD
    updateMediaSessionPosition();
  });

  audio.addEventListener('timeupdate', updateMediaSessionPosition);
  audio.addEventListener('seeked', updateMediaSessionPosition);
  audio.addEventListener('ratechange', updateMediaSessionPosition);

  audio.addEventListener('error', async () => {
    const error = audio.error;
    const generation = playbackGeneration;
    const expectedUrl = currentStreamUrl;
    const trackId = currentTrackId;

    console.error('[player] Erro no áudio:', {
      code: error?.code,
      message: error?.message,
      source: audio.currentSrc
    });

    if (!trackId || !expectedUrl) return;
    const currentUrl = audio.currentSrc || audio.src;
    if (generation !== playbackGeneration || currentUrl !== expectedUrl) return;

    els.title.textContent = 'Erro ao carregar áudio';
    els.artist.textContent = 'Verificando disponibilidade...';

    const diag = await diagnoseStreamError(trackId);
    
    if (generation !== playbackGeneration || currentUrl !== (audio.currentSrc || audio.src)) return;

    if (diag.status === 'forbidden') {
      els.title.textContent = 'Prévia indisponível';
      els.artist.textContent = diag.message;
    } else if (diag.status === 'not_found') {
      els.title.textContent = 'Áudio não configurado';
      els.artist.textContent = diag.message;
    } else if (diag.status === 'ok') {
      els.title.textContent = 'Formato não suportado';
      els.artist.textContent = 'O navegador não consegue reproduzir este arquivo.';
    } else {
      els.title.textContent = 'Erro de reprodução';
      els.artist.textContent = diag.message || 'Tente novamente.';
    }
  });

  audio.addEventListener('ended', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';

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

// ─── PROGRESS BAR ───
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

  els.progressBar.addEventListener('click', (e) => {
    if (!audio.duration || !Number.isFinite(audio.duration)) return;
    const rect = els.progressBar.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    audio.currentTime = audio.duration * Math.max(0, Math.min(1, pos));
  });
=======
  };

  audio.onerror = () => {
    console.error('[player] Erro no áudio:', audio.error, streamUrl);
    // ★ 403 = faixa sem preview (precisa alugar/assinar)
    if (audio.error && audio.error.code === 4) {
      els.title.textContent = 'Prévia indisponível — alugue ou assine';
    } else {
      els.title.textContent = 'Erro ao carregar áudio';
    }
  };

  audio.onended = () => {
    // ★ avança automaticamente para a próxima faixa do álbum
    if (!currentTrackMeta || !currentTrackMeta.albumTracks) return;
    const idx = currentTrackMeta.albumTracks.findIndex(t => t.id === trackId);
    const next = currentTrackMeta.albumTracks[idx + 1];
    if (next) window.tocarMusicaDaLista(next.id);
  };

  if (autoplay) {
    audio.play().catch(err => {
      console.warn('[player] Autoplay bloqueado:', err);
    });
  }
>>>>>>> upstream/main
}

// ─── CONTROLES GLOBAIS ───
window.playerPlay = () => {
<<<<<<< HEAD
  if (!audio.src) {
    if (currentTrackId) initPlayer(currentTrackId, true);
    return;
  }
  if (audio.paused) audio.play().catch(err => console.error('[player] play() falhou:', err));
  else audio.pause();
=======
  if (!audio.src) return;
  if (audio.paused) {
    audio.play().catch(err => console.error('[player] play() falhou:', err));
  } else {
    audio.pause();
  }
>>>>>>> upstream/main
};

// ★ Agora Next/Prev navegam de verdade entre faixas do álbum
window.playerNext = () => {
<<<<<<< HEAD
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

=======
  if (!currentTrackMeta || !currentTrackMeta.albumTracks) return;
  const idx = currentTrackMeta.albumTracks.findIndex(t => t.id === currentTrackId);
  const next = currentTrackMeta.albumTracks[idx + 1];
  if (next) window.tocarMusicaDaLista(next.id);
};

window.playerPrev = () => {
  if (!currentTrackMeta || !currentTrackMeta.albumTracks) return;
  // se estiver nos primeiros 3s, volta para a faixa anterior; senão reinicia a atual
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const idx = currentTrackMeta.albumTracks.findIndex(t => t.id === currentTrackId);
  const prev = currentTrackMeta.albumTracks[idx - 1];
  if (prev) window.tocarMusicaDaLista(prev.id);
};

els.progressBar.addEventListener('click', (e) => {
  if (!audio.duration) return;
  const rect = els.progressBar.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  audio.currentTime = audio.duration * pos;
});

>>>>>>> upstream/main
window.tocarMusicaDaLista = async (id) => {
  history.replaceState(null, '', `/player.html?id=${id}`);
  await initPlayer(id);
  switchTab('player');
};

<<<<<<< HEAD
// ─── SHUFFLE & REPEAT ───
if (els.shuffleBtn) {
  els.shuffleBtn.addEventListener('click', () => {
    shuffleEnabled = !shuffleEnabled;
    els.shuffleBtn.setAttribute('aria-pressed', String(shuffleEnabled));
    els.shuffleBtn.classList.toggle('active', shuffleEnabled);
  });
}

function applyRepeatMode(mode) {
  repeatMode = mode;
  if (!els.repeatBtn) return;
  els.repeatBtn.setAttribute('aria-pressed', String(mode !== 'off'));
  els.repeatBtn.dataset.mode = mode;
  els.repeatBtn.classList.toggle('active', mode !== 'off');
  els.repeatBtn.setAttribute('aria-label', mode === 'off' ? 'Repetição desligada' : mode === 'one' ? 'Repetir faixa atual' : 'Repetir álbum');
}

if (els.repeatBtn) {
  els.repeatBtn.addEventListener('click', () => {
    const nextMode = { off: 'one', one: 'all', all: 'off' };
    applyRepeatMode(nextMode[repeatMode]);
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
  
  if (els.repeatBtn) applyRepeatMode('off');
  if (els.shuffleBtn) {
    els.shuffleBtn.setAttribute('aria-pressed', String(shuffleEnabled));
    els.shuffleBtn.classList.toggle('active', shuffleEnabled);
  }

=======
window.abrirModalAssinatura = () => { window.location.href = '/#planos'; };
window.abrirModalAluguel = () => { if (currentTrackId) alert(`Abrindo aluguel: ${currentTrackId}`); };

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
>>>>>>> upstream/main
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (!trackId) { els.title.textContent = 'Nenhuma faixa selecionada'; return; }
  await initPlayer(trackId);
<<<<<<< HEAD
});

window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (trackId && trackId !== currentTrackId) initPlayer(trackId);
=======
>>>>>>> upstream/main
});