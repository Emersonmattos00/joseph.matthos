// js/player.js — versão final auditada e integrada com Media Session

'use strict';

/* ============================================================
   CORREÇÕES E FUNCIONALIDADES APLICADAS:
   - Concorrência: AbortController + requestId em initPlayer
   - Validação do trackId e do meta.id retornado pela API
   - onerror: distingue 403 (preview indisponível) via /api/stream?format=json
   - Repeat: clique simples = repetir atual (one), duplo clique = repetir tudo (all)
   - Media Session API: controles e metadados na tela de bloqueio/notificação
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
  repeatBtn: document.getElementById('repeatBtn')
};

const audio = new Audio();
audio.preload = 'metadata';  // iOS: 'none' pode impedir metadata

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

tabs.forEach(tab => {
  tab.addEventListener('click', () => updateTabState(tab));
});

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
  const r = await fetch(
    `/api/public?track=${encodeURIComponent(trackId)}`,
    { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal }
  );

  if (!r.ok) {
    if (r.status === 404) throw new Error('Faixa não encontrada ou não publicada.');
    throw new Error(`Erro ao consultar faixa: HTTP ${r.status}`);
  }

  const data = await r.json();

  if (!data || typeof data !== 'object' || !data.id || !data.title || !Array.isArray(data.albumTracks)) {
    throw new Error('A API retornou dados incompletos para o player.');
  }

  return data;
}

// ─── DIAGNÓSTICO DO STREAM ───
// MediaError 4 é genérico. Um HEAD/GET com format=json distingue 403 de 404.
async function diagnoseStreamError(trackId) {
  try {
    const r = await fetch(
      `/api/stream?trackId=${encodeURIComponent(trackId)}&format=json&t=${Date.now()}`,
      { method: 'GET', credentials: 'same-origin', cache: 'no-store' }
    );

    if (r.ok) return { status: 'ok' };
    if (r.status === 403) return { status: 'forbidden', message: 'Prévia indisponível. Assine ou alugue para ouvir.' };
    if (r.status === 404) return { status: 'not_found', message: 'Áudio não configurado para esta faixa.' };
    if (r.status === 503) return { status: 'unavailable', message: 'Serviço de áudio temporariamente indisponível.' };
    if (r.status === 429) return { status: 'rate_limited', message: 'Muitas requisições. Tente em instantes.' };

    return { status: 'error', message: `Erro HTTP ${r.status}.` };
  } catch {
    return { status: 'network', message: 'Verifique sua conexão.' };
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

  const validLyrics = lyricsArray.filter(line =>
    line && typeof line === 'object' &&
    Number.isFinite(Number(line.time)) &&
    typeof line.text === 'string'
  );

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
    duration.textContent = track.locked
      ? '🔒'
      : track.durationSeconds ? formatTime(track.durationSeconds) : '--:--';

    actions.append(duration);
    item.append(number, info, actions);

    item.addEventListener('click', () => {
      window.tocarMusicaDaLista(String(track.id));
    });

    els.musicList.appendChild(item);
  });
}

// ─── INIT ───
async function initPlayer(trackId, autoplay = true) {
  // Validação do identificador recebido (P0)
  if (
    typeof trackId !== 'string' ||
    !trackId.trim() ||
    trackId.length > 100
  ) {
    els.title.textContent = 'Identificador de faixa inválido';
    return;
  }

  // Identificador único desta inicialização (P0 — concorrência)
  const requestId = ++playerRequestId;

  if (playerAbortController) {
    try { playerAbortController.abort(); } catch {}
  }
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

    // Impede respostas antigas de alterar a seleção atual (P0)
    if (requestId !== playerRequestId) return;

    // Valida que a API devolveu exatamente a faixa solicitada (P0)
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

    // ★ Integração Media Session
    updateMediaSessionMetadata(meta);

    const streamUrl = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
    audio.src = streamUrl;
    audio.load();

    // Rechecagem antes do autoplay (P0)
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

// ─── MEDIA SESSION (INTEGRAÇÃO COM NOTIFICAÇÕES) ───
function updateMediaSessionMetadata(meta) {
  if (!('mediaSession' in navigator)) return;
  const cover = meta.coverUrl || '/assets/default-cover.png'; // Ajuste o fallback se necessário

  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.title || 'Faixa sem título',
    artist: meta.artist || 'Joseph Matthos',
    album: meta.albumTitle || 'Mentalidade de Ouro',
    artwork: [
      { src: cover, sizes: '96x96',   type: 'image/png' },
      { src: cover, sizes: '128x128', type: 'image/png' },
      { src: cover, sizes: '192x192', type: 'image/png' },
      { src: cover, sizes: '256x256', type: 'image/png' },
      { src: cover, sizes: '384x384', type: 'image/png' },
      { src: cover, sizes: '512x512', type: 'image/png' }
    ]
  });
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;

  const actionHandlers = [
    ['play', () => window.playerPlay()],
    ['pause', () => window.playerPlay()],
    ['nexttrack', () => window.playerNext()],
    ['previoustrack', () => window.playerPrev()],
    ['seekbackward', (details) => {
      const skipTime = details.seekOffset || 10;
      audio.currentTime = Math.max(audio.currentTime - skipTime, 0);
    }],
    ['seekforward', (details) => {
      const skipTime = details.seekOffset || 10;
      audio.currentTime = Math.min(audio.currentTime + skipTime, audio.duration);
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
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      console.warn(`A ação "${action}" não é suportada neste navegador.`);
    }
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
      const percent = duration > 0 && Number.isFinite(duration)
        ? Math.min(100, (seek / duration) * 100)
        : 0;
      els.progressFill.style.width = `${percent}%`;
      if (els.progressBar) els.progressBar.setAttribute('aria-valuenow', String(Math.round(percent)));
      els.currentTime.textContent = formatTime(seek);
      syncLyrics();
    }, 250);

    // ★ Media Session: estado tocando + barra de progresso no sistema
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
      if ('setPositionState' in navigator.mediaSession && Number.isFinite(audio.duration)) {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: audio.currentTime
        });
      }
    }
  });

  audio.addEventListener('pause', () => {
    els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    clearInterval(updateInterval);

    // ★ Media Session: estado pausado
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  });

  audio.addEventListener('loadedmetadata', () => {
    els.duration.textContent = formatTime(audio.duration);
  });

  // ★ Erro de áudio: distingue 403 de erro real via diagnoseStreamError
  audio.addEventListener('error', async () => {
    const error = audio.error;
    console.error('[player] Erro no áudio:', {
      code: error?.code,
      message: error?.message,
      source: audio.currentSrc
    });

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

  // ★ Ended: respeita repeat mode e faz wrap
  audio.addEventListener('ended', () => {
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
      nextIndex = Math.floor(Math.random() * tracks.length);
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
  // iOS: permite tentar play mesmo com src vazio (o streamUrl vem logo em seguida)
  if (!audio.src) {
    if (currentTrackId) initPlayer(currentTrackId, true);
    return;
  }
  if (audio.paused) {
    audio.play().catch(err => console.error('[player] play() falhou:', err));
  } else {
    audio.pause();
  }
};

window.playerNext = () => {
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  if (!tracks.length) return;

  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;

  let nextIndex;
  if (shuffleEnabled) {
    nextIndex = Math.floor(Math.random() * tracks.length);
  } else if (index < tracks.length - 1) {
    nextIndex = index + 1;
  } else {
    nextIndex = 0; // wrap
  }

  const next = tracks[nextIndex];
  if (next?.id) window.tocarMusicaDaLista(String(next.id));
};

window.playerPrev = () => {
  if (!currentTrackMeta?.albumTracks) return;

  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }

  const tracks = currentTrackMeta.albumTracks;
  if (!tracks.length) return;

  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0) return;

  let prevIndex;
  if (shuffleEnabled) {
    prevIndex = Math.floor(Math.random() * tracks.length);
  } else if (index > 0) {
    prevIndex = index - 1;
  } else {
    prevIndex = tracks.length - 1; // wrap
  }

  const prev = tracks[prevIndex];
  if (prev?.id) window.tocarMusicaDaLista(String(prev.id));
};

els.progressBar?.addEventListener('click', (e) => {
  if (!audio.duration || !Number.isFinite(audio.duration)) return;
  const rect = els.progressBar.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  audio.currentTime = audio.duration * Math.max(0, Math.min(1, pos));
});

// ★ tocarMusicaDaLista: encodeURIComponent + history + abas
window.tocarMusicaDaLista = async (id) => {
  if (!id) return;
  const safeId = String(id);
  history.replaceState(null, '', `/player.html?id=${encodeURIComponent(safeId)}`);
  switchTab('player');
  await initPlayer(safeId);
};

// ─── SHUFFLE ───
if (els.shuffleBtn) {
  els.shuffleBtn.addEventListener('click', () => {
    shuffleEnabled = !shuffleEnabled;
    els.shuffleBtn.setAttribute('aria-pressed', String(shuffleEnabled));
    els.shuffleBtn.classList.toggle('active', shuffleEnabled);
  });
}

// ─── REPEAT ───
// Clique simples: alterna "repetir música atual" (one) / desligado (off)
// Duplo clique: "repetir tudo" (all)
if (els.repeatBtn) {
  let repeatClickTimer = null;

  const applyRepeatMode = (mode) => {
    repeatMode = mode;
    els.repeatBtn.setAttribute('aria-pressed', String(repeatMode !== 'off'));
    els.repeatBtn.classList.toggle('active', repeatMode !== 'off');
    els.repeatBtn.dataset.mode = repeatMode;
    els.repeatBtn.setAttribute(
      'aria-label',
      repeatMode === 'off' ? 'Repetir: desligado'
        : repeatMode === 'one' ? 'Repetir: música atual'
        : 'Repetir: tudo'
    );
  };

  els.repeatBtn.addEventListener('click', () => {
    if (repeatClickTimer) return; // já é parte de um duplo clique
    repeatClickTimer = setTimeout(() => {
      repeatClickTimer = null;
      applyRepeatMode(repeatMode === 'one' ? 'off' : 'one');
    }, 250);
  });

  els.repeatBtn.addEventListener('dblclick', () => {
    if (repeatClickTimer) {
      clearTimeout(repeatClickTimer);
      repeatClickTimer = null;
    }
    applyRepeatMode('all');
  });
}

// ─── MODAIS (ALUGUEL / ASSINATURA) ───
window.abrirModalAssinatura = () => { window.location.href = '/#planos'; };

window.abrirModalAluguel = () => {
  if (!currentTrackId) return;
  // O modal de aluguel vive na home (index.html).
  // Redireciona para a home e pede o aluguel via hash.
  const url = `/?rent=${encodeURIComponent(currentTrackId)}`;
  window.location.href = url;
  // TODO: index.html precisa ler ?rent=UUID e abrir o modal de aluguel.
};

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
  bindAudioEvents();
  setupMediaSessionHandlers(); // ★ Inicializa os controles na notificação do celular

  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
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
