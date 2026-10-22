// js/player.js

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

let audio = new Audio();
let updateInterval = null;
let currentTrackId = null;
let parsedLyrics = [];
let currentLyricIndex = -1;

// ─── ABAS ───
const tabs = document.querySelectorAll('.mobile-tab');
const tabContents = document.querySelectorAll('.tab-content');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    // Sempre mostra os menus ao trocar de aba
    document.body.classList.remove('immersive-mode');
  });
});

function switchTab(tabName) {
  const btn = document.querySelector(`.mobile-tab[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

// ─── MODO IMERSIVO (TOGGLE) ───
function toggleModoImersivo() {
  // Só ativa se estiver na aba Player
  if (!document.getElementById('tab-player').classList.contains('active')) return;
  // Só ativa se a música estiver tocando
  if (!audio.src || audio.paused) return;
  
  document.body.classList.toggle('immersive-mode');
}

// Tratamento unificado para toque e clique (evita o "pisca-pisca")
let touchStartTime = 0;

els.container.addEventListener('touchstart', (e) => {
  if (e.target.closest('button') || e.target.closest('.mobile-tab') || e.target.closest('.progress-bar')) return;
  touchStartTime = Date.now();
}, { passive: true });

els.container.addEventListener('touchend', (e) => {
  if (e.target.closest('button') || e.target.closest('.mobile-tab') || e.target.closest('.progress-bar')) return;
  // Se o toque foi rápido (menos de 300ms), considera como um clique
  if (Date.now() - touchStartTime < 300) {
    toggleModoImersivo();
  }
});

els.container.addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.closest('.mobile-tab') || e.target.closest('.progress-bar')) return;
  // No celular, o touchend já cuidou. Isso evita duplo toggle.
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

// ─── FETCHES ───
async function fetchMetadata(trackId) {
  const r = await fetch(`/api/public?track=${encodeURIComponent(trackId)}`, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('Faixa não encontrada');
  return await r.json();
}

async function fetchStreamUrl(trackId) {
  const r = await fetch(`/api/stream?trackId=${encodeURIComponent(trackId)}`, {
    credentials: 'same-origin', cache: 'no-store'
  });
  if (!r.ok) throw new Error(`Falha no áudio (${r.status})`);
  return await r.json();
}

// ─── LETRA ───
function renderLyrics(lyricsArray) {
  if (!lyricsArray || !lyricsArray.length) {
    els.lyricsContent.innerHTML = '<p class="lyrics-empty">Esta faixa não tem letra cadastrada.</p>';
    parsedLyrics = [];
    return;
  }
  els.lyricsContent.innerHTML = lyricsArray.map((l, i) => `
    <button class="lyric-line" data-index="${i}" data-time="${l.time}">${esc(l.text || '')}</button>
  `).join('');
  parsedLyrics = lyricsArray.map((l, i) => ({
    time: Number(l.time) || 0,
    element: els.lyricsContent.querySelector(`[data-index="${i}"]`)
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

// ─── INIT ───
async function initPlayer(trackId) {
  currentTrackId = trackId;
  currentLyricIndex = -1;
  document.body.classList.remove('immersive-mode');

  let meta;
  try { meta = await fetchMetadata(trackId); }
  catch (err) { els.title.textContent = 'Faixa não encontrada'; return; }

  // 1. Atualiza a UI Principal
  els.title.textContent = meta.title;
  els.artist.textContent = `${meta.artist} · ${meta.albumTitle}`;
  
  if (meta.coverUrl) {
    if (els.cover.tagName === 'IMG') {
      els.cover.src = meta.coverUrl;
    } else {
      els.cover.style.backgroundImage = `url('${meta.coverUrl}')`;
    }
    els.container.style.setProperty('--player-bg', `url('${meta.coverUrl}')`);
  }
  
  renderLyrics(meta.lyrics);

  // 2. Atualiza a Lista
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

  // 3. Busca o Áudio
  let stream;
  try { stream = await fetchStreamUrl(trackId); }
  catch (err) { els.title.textContent = 'Áudio indisponível'; return; }

  if (!stream.audioUrl) { els.title.textContent = 'Áudio não configurado'; return; }

  // 4. Configura a tag de áudio nativa
  audio.pause();
  audio.removeAttribute('src');
  audio.src = stream.audioUrl;
  audio.load();

  audio.onplay = () => {
    els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    clearInterval(updateInterval);
    updateInterval = setInterval(() => {
      const seek = audio.currentTime || 0;
      const duration = audio.duration || 0;
      els.progressFill.style.width = `${(seek / duration) * 100}%`;
      els.currentTime.textContent = formatTime(seek);
      syncLyrics();
    }, 250);
  };

  audio.onpause = () => {
    els.playIcon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
    clearInterval(updateInterval);
  };

  audio.onloadedmetadata = () => {
    els.duration.textContent = formatTime(audio.duration);
  };

  audio.onerror = (e) => {
    console.error('[player] Erro no áudio:', audio.error);
    els.title.textContent = 'Erro ao carregar áudio';
  };

    // Em vez de tentar tocar automaticamente, apenas carregue a música.
  // O usuário vai clicar no botão de Play para iniciar.
  console.log('[player] Faixa carregada e pronta para o Play.');
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
  if (!audio.duration) return;
  audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
};

window.playerPrev = () => {
  if (!audio.duration) return;
  audio.currentTime = Math.max(0, audio.currentTime - 10);
};

els.progressBar.addEventListener('click', (e) => {
  if (!audio.duration) return;
  const rect = els.progressBar.getBoundingClientRect();
  const pos = (e.clientX - rect.left) / rect.width;
  audio.currentTime = audio.duration * pos;
});

window.tocarMusicaDaLista = async (id) => {
  history.replaceState(null, '', `/player.html?id=${id}`);
  await initPlayer(id);
  switchTab('player');
};

window.abrirModalAssinatura = () => { window.location.href = '/#planos'; };
window.abrirModalAluguel = () => { if (currentTrackId) alert(`Abrindo aluguel: ${currentTrackId}`); };

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');
  if (!trackId) { els.title.textContent = 'Nenhuma faixa selecionada'; return; }
  await initPlayer(trackId);
});