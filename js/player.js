// js/player.js — versão final (API redireciona para o Cloudflare Worker)

/* ============================================================
   CORREÇÕES APLICADAS (Etapa 7 da auditoria):
   - Concorrência: AbortController + requestId
   - onerror: não confunde 403 com erro de formato
   - Lista: sem onclick inline, usa addEventListener
   - Navegação: trata findIndex = -1
   - Letras: valida formato do array
   - formatTime: trata Infinity/NaN
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
  fullscreenBtn: document.getElementById('fullscreenBtn')
};

let audio = new Audio();
audio.preload = 'none';
let updateInterval = null;
let currentTrackId = null;
let parsedLyrics = [];
let currentLyricIndex = -1;
let currentTrackMeta = null;

// ★ CORREÇÃO P0: controle de concorrência
let playerRequestId = 0;
let playerAbortController = null;

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
  const playerTab = document.getElementById('tab-player');
  if (!playerTab || !playerTab.classList.contains('active')) return;
  if (!audio.src || audio.paused) return;
  document.body.classList.toggle('immersive-mode');
}

let touchStartTime = 0;
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

// ─── LETRA ───
function renderLyrics(lyricsArray) {
  if (!Array.isArray(lyricsArray) || !lyricsArray.length) {
    els.lyricsContent.innerHTML = '<p class="lyrics-empty">Esta faixa não tem letra cadastrada.</p>';
    parsedLyrics = [];
    currentLyricIndex = -1;
    return;
  }

  // ★ CORREÇÃO: valida cada linha
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
    <button class="lyric-line" data-index="${index}" data-time="${Number(line.time)}">${esc(line.text)}</button>
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

// ─── LISTA DE MÚSICAS (SEM onclick INLINE) ───
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
  if (!trackId || typeof trackId !== 'string') {
    els.title.textContent = 'Nenhuma faixa selecionada';
    return;
  }

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

  try {
    const meta = await fetchMetadata(trackId, playerAbortController.signal);

    // ★ descarta respostas antigas
    if (requestId !== playerRequestId) return;

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

    const streamUrl = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
    audio.src = streamUrl;
    audio.load();

    if (requestId !== playerRequestId) return;

    if (autoplay) {
      try {
        await audio.play();
      } catch (err) {
        if (requestId === playerRequestId) {
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

// ─── EVENTOS DE ÁUDIO (centralizados) ───
function bindAudioEvents() {
  audio.addEventListener('play', () => {
    els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      const seek = audio.currentTime || 0;
      const duration = audio.duration || 0;
      if (duration > 0 && Number.isFinite(duration)) {
        els.progressFill.style.width = `${Math.min(100, (seek / duration) * 100)}%`;
      }
      els.currentTime.textContent = formatTime(seek);
      syncLyrics();
    }, 250);
  });

  audio.addEventListener('pause', () => {
    els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    clearInterval(updateInterval);
  });

  audio.addEventListener('loadedmetadata', () => {
    els.duration.textContent = formatTime(audio.duration);
  });

  // ★ CORREÇÃO: não confunde erro de formato com 403
  audio.addEventListener('error', () => {
    const error = audio.error;
    console.error('[player] Erro no áudio:', {
      code: error?.code,
      message: error?.message,
      source: audio.currentSrc
    });

    if (!currentTrackId) return;

    if (error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      els.title.textContent = 'Erro ao carregar áudio';
      els.artist.textContent = 'Formato não suportado ou arquivo indisponível.';
    } else if (error?.code === MediaError.MEDIA_ERR_NETWORK) {
      els.title.textContent = 'Erro ao carregar áudio';
      els.artist.textContent = 'Verifique sua conexão ou tente novamente.';
    } else {
      els.title.textContent = 'Erro ao carregar áudio';
      els.artist.textContent = 'Tente novamente.';
    }
  });

  // ★ CORREÇÃO: findIndex = -1 não avança para a primeira faixa
  audio.addEventListener('ended', () => {
    if (!currentTrackMeta || !Array.isArray(currentTrackMeta.albumTracks)) return;
    const tracks = currentTrackMeta.albumTracks;
    const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
    if (index < 0) return;
    const next = tracks[index + 1];
    if (next?.id) window.tocarMusicaDaLista(String(next.id));
  });
}

// ─── CONTROLES GLOBAIS ───
window.playerPlay = () => {
  if (!audio.src) return;
  if (audio.paused) {
    audio.play().catch(err => console.error('[player] play() falhou:', err));
  } else {
    audio.pause();
  }
};

window.playerNext = () => {
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index < 0 || index >= tracks.length - 1) return;
  const next = tracks[index + 1];
  if (next?.id) window.tocarMusicaDaLista(String(next.id));
};

window.playerPrev = () => {
  if (!currentTrackMeta?.albumTracks) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const tracks = currentTrackMeta.albumTracks;
  const index = tracks.findIndex(t => String(t.id) === String(currentTrackId));
  if (index <= 0) {
    audio.currentTime = 0;
    return;
  }
  const prev = tracks[index - 1];
  if (prev?.id) window.tocarMusicaDaLista(String(prev.id));
};

els.progressBar.addEventListener('click', (e) => {
  if (!audio.duration || !Number.isFinite(audio.duration)) return;
  const rect = els.progressBar.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  audio.currentTime = audio.duration * pos;
});

// ★ CORREÇÃO: encodeURIComponent no ID
window.tocarMusicaDaLista = async (id) => {
  if (!id) return;
  const safeId = String(id);
  history.replaceState(null, '', `/player.html?id=${encodeURIComponent(safeId)}`);
  switchTab('player');
  await initPlayer(safeId);
};

window.abrirModalAssinatura = () => { window.location.href = '/#planos'; };
window.abrirModalAluguel = () => {
  if (currentTrackId) {
    // TODO: integrar com o fluxo real de aluguel
    alert(`Abrindo aluguel: ${currentTrackId}`);
  }
};

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
  bindAudioEvents();

  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (!trackId) {
    els.title.textContent = 'Nenhuma faixa selecionada';
    return;
  }
  await initPlayer(trackId);
});

// ─── NAVEGAÇÃO PELO HISTÓRICO ───
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (trackId && trackId !== currentTrackId) {
    initPlayer(trackId);
  }
});