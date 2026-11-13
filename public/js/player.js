// js/player.js — Versão Final Definitiva (Abas, Mini-Player, Áudio Seguro, Playlists)

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

// ─── PLAYLISTS (localStorage) ───
function getPlaylists() {
  try {
    return JSON.parse(localStorage.getItem('jm_playlists') || '[]');
  } catch {
    return [];
  }
}

function savePlaylists(playlists) {
  localStorage.setItem('jm_playlists', JSON.stringify(playlists));
}

function createPlaylist(name) {
  const playlists = getPlaylists();
  const newPlaylist = { id: Date.now().toString(), name, tracks: [], coverUrl: '' };
  playlists.push(newPlaylist);
  savePlaylists(playlists);
  return newPlaylist;
}

function addTrackToPlaylist(playlistId, trackId) {
  const playlists = getPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);
  if (playlist && !playlist.tracks.includes(trackId)) {
    playlist.tracks.push(trackId);
    savePlaylists(playlists);
    return true;
  }
  return false;
}

function removePlaylist(playlistId) {
  let playlists = getPlaylists();
  playlists = playlists.filter(p => p.id !== playlistId);
  savePlaylists(playlists);
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
  lyricsContent: document.getElementById('lyricsContent'),
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
  if (tabName === 'playlists') {
    renderPlaylistsTab();
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

// ─── RENDERIZAR ÁLBUNS ───
async function renderAlbumsTab() {
  const container = document.getElementById('albumsList');
  if (!container) return;

  container.innerHTML = '<p style="text-align:center;color:#aaa;padding:1rem;">Carregando álbuns...</p>';

  try {
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

// ─── RENDERIZAR PLAYLISTS ───
function renderPlaylistsTab() {
  const container = els.playlistsContainer;
  if (!container) return;

  const playlists = getPlaylists();

  let html = `
    <div class="playlist-header">
      <h2>Minhas Playlists</h2>
      <button class="btn-new-playlist" onclick="window.criarPlaylistModal()">+ Nova</button>
    </div>
  `;

  if (playlists.length === 0) {
    html += '<p style="text-align:center;color:#aaa;padding:2rem;">Nenhuma playlist criada ainda.</p>';
  } else {
    html += playlists.map(p => `
      <div class="playlist-card">
        <div class="playlist-info" onclick="window.abrirPlaylist('${p.id}')">
          <h3>${esc(p.name)}</h3>
          <p>${p.tracks.length} faixas</p>
        </div>
        <button class="playlist-delete-btn" onclick="event.stopPropagation(); window.deletarPlaylist('${p.id}')" title="Excluir">🗑️</button>
      </div>
    `).join('');
  }

  container.innerHTML = html;
}

// ─── CRIAR PLAYLIST ───
window.criarPlaylistModal = () => {
  const name = prompt('Nome da nova playlist:');
  if (name && name.trim()) {
    createPlaylist(name.trim());
    renderPlaylistsTab();
    showToast('Playlist criada!');
  }
};

window.deletarPlaylist = (id) => {
  if (confirm('Tem certeza que deseja excluir esta playlist?')) {
    removePlaylist(id);
    renderPlaylistsTab();
    showToast('Playlist excluída.');
  }
};

// ─── ABRIR PLAYLIST (como um álbum) ───
window.abrirPlaylist = async (playlistId) => {
  const playlists = getPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);
  if (!playlist) return;

  if (playlist.tracks.length === 0) {
    showToast('Esta playlist está vazia.');
    return;
  }

  switchTab('music');

  const list = document.getElementById('musicList');
  const header = document.getElementById('albumTracklistHeader');
  
  if (header) {
    header.style.display = 'flex';
    if (els.albumHeaderCover) {
      els.albumHeaderCover.style.backgroundImage = playlist.coverUrl ? `url('${playlist.coverUrl}')` : 'none';
      els.albumHeaderCover.style.backgroundColor = '#333';
    }
    if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = playlist.name;
    if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = 'Sua Playlist';
    if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${playlist.tracks.length} faixas`;

    // Adiciona botão de editar capa
    const oldBtn = header.querySelector('.btn-subscribe-header');
    if (oldBtn) oldBtn.remove();
    let editBtn = header.querySelector('.btn-edit-cover');
    if (!editBtn) {
      editBtn = document.createElement('button');
      editBtn.className = 'btn-edit-cover';
      editBtn.textContent = 'Editar Capa';
      editBtn.onclick = () => window.editarCapaPlaylist(playlistId);
      header.appendChild(editBtn);
    }
  }
  
  if (list) list.innerHTML = '<p style="text-align:center;color:#aaa;">Carregando faixas da playlist...</p>';

  try {
    const trackPromises = playlist.tracks.map(id => 
      fetch(`/api/public?track=${encodeURIComponent(id)}`).then(r => r.json())
    );
    const results = await Promise.all(trackPromises);
    
    const validTracks = results.filter(r => r.ok).map(r => ({
      id: r.id,
      title: r.title,
      artist: r.artist || 'Joseph Matthos',
      albumTitle: r.albumTitle,
      durationSeconds: r.durationSeconds
    }));

    if (validTracks.length === 0) {
      if (list) list.innerHTML = '<p style="text-align:center;color:#aaa;">Não foi possível carregar as faixas desta playlist.</p>';
      return;
    }

    currentTrackMeta = { 
      ...currentTrackMeta, 
      albumTracks: validTracks,
      id: playlist.id,
      title: playlist.name,
      artist: 'Sua Playlist',
      coverUrl: playlist.coverUrl || '/assets/img/tema.webp'
    };

    renderPlayerTrackList(currentTrackMeta, currentTrackId);

  } catch (err) {
    if (list) list.innerHTML = `<p style="color:var(--danger);text-align:center;">Erro ao carregar a playlist.</p>`;
    console.error('[Playlist] Erro:', err);
  }
};

// ─── EDITAR CAPA ───
window.editarCapaPlaylist = (playlistId) => {
  const playlists = getPlaylists();
  const playlist = playlists.find(p => p.id === playlistId);
  if (!playlist) return;

  const novaCapa = prompt('Cole a URL da imagem de capa (ou deixe em branco para remover):', playlist.coverUrl || '');
  if (novaCapa !== null) {
    playlist.coverUrl = novaCapa.trim();
    savePlaylists(playlists);
    showToast('Capa atualizada!');
    window.abrirPlaylist(playlistId);
  }
};

// ─── ADICIONAR À PLAYLIST (menu de opções) ───
window.abrirModalAdicionarPlaylist = (trackId) => {
  document.getElementById('playlistModalOverlay')?.remove();

  const playlists = getPlaylists();

  let html = `
    <div class="playlist-modal-overlay" id="playlistModalOverlay">
      <div class="playlist-modal">
        <h3>Adicionar à Playlist</h3>
  `;

  if (playlists.length === 0) {
    html += '<p style="color:#aaa;">Nenhuma playlist criada.</p>';
  } else {
    html += '<div class="playlist-tracks-list">';
    html += playlists.map(p => `
      <div class="playlist-card" style="padding:0.5rem;" onclick="window.adicionarTrackPlaylist('${p.id}', '${trackId}')">
        <div class="playlist-info">
          <h3 style="font-size:0.9rem;">${esc(p.name)}</h3>
        </div>
      </div>
    `).join('');
    html += '</div>';
  }

  html += `
        <div class="playlist-modal-actions">
          <button onclick="document.getElementById('playlistModalOverlay').remove()">Cancelar</button>
          <button class="save" onclick="window.criarPlaylistEAdicionar('${trackId}')">+ Nova Playlist</button>
        </div>
      </div>
    </div>
  `;

  document.body.insertAdjacentHTML('beforeend', html);
};

window.adicionarTrackPlaylist = (playlistId, trackId) => {
  const added = addTrackToPlaylist(playlistId, trackId);
  document.getElementById('playlistModalOverlay')?.remove();
  showToast(added ? 'Adicionado à playlist!' : 'Esta música já está na playlist.');
};

window.criarPlaylistEAdicionar = (trackId) => {
  document.getElementById('playlistModalOverlay')?.remove();
  const name = prompt('Nome da nova playlist:');
  if (name && name.trim()) {
    const newPlaylist = createPlaylist(name.trim());
    addTrackToPlaylist(newPlaylist.id, trackId);
    renderPlaylistsTab();
    showToast('Playlist criada e música adicionada!');
  }
};

// ─── ABRIR ÁLBUM ───
window.abrirAlbum = async (albumId) => {
  const header = document.getElementById('albumTracklistHeader');
  const list = document.getElementById('musicList');
  if (header) {
    header.style.display = 'flex';
    const oldBtn = header.querySelector('.btn-edit-cover');
    if (oldBtn) oldBtn.remove();
    const subBtn = header.querySelector('.btn-subscribe-header');
    if (subBtn) subBtn.style.display = 'block';
  }
  if (list) list.innerHTML = '<p style="text-align:center;color:#aaa;">Carregando faixas...</p>';

  switchTab('music');

  try {
    const res = await fetch(`/api/public?album=${albumId}&t=${Date.now()}`, { cache: 'no-store' });
    const data = await res.json();
    
    if (!data.ok || !data.album) throw new Error(data.error || 'Álbum não encontrado.');

    const album = data.album;
    const tracks = data.tracks || []; 

    currentTrackMeta = { ...album, albumTracks: tracks };
    
    if (els.albumHeaderCover) els.albumHeaderCover.style.backgroundImage = `url('${album.coverUrl}')`;
    if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = album.title;
    if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = album.artist || 'Joseph Matthos';
    if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${tracks.length} faixas`;

    if (tracks.length === 0) {
      if (list) list.innerHTML = '<p style="text-align:center;color:#aaa;padding:1rem;">Este álbum ainda não tem faixas cadastradas no banco de dados.</p>';
      return;
    }

    renderPlayerTrackList(currentTrackMeta, currentTrackId);
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

    const rentBtn = document.createElement('button');
    rentBtn.className = 'action-icon';
    rentBtn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 12c0-1.1.9-2 2-2V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2z"/><path d="M9 10v4M15 10v4"/></svg>`;
    rentBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.location.href = `/?rent=${encodeURIComponent(track.id)}`;
    });
    actions.appendChild(rentBtn);

    const duration = document.createElement('span');
    duration.className = 'music-item-duration';
    duration.textContent = track.locked ? '🔒' : track.durationSeconds ? formatTime(track.durationSeconds) : '--:--';
    actions.appendChild(duration);

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

// ─── MENU DE OPÇÕES ───
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
        window.abrirModalAdicionarPlaylist(track.id);
      }

      menu.remove();
    });
  });
}

// ─── MEDIA SESSION ───
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
async function initPlayer(trackId, autoplay = true, keepPlaylistContext = false) {
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

    // Carrega faixas do álbum (se não estiver mantendo contexto de playlist)
    const albumId = meta.albumId;
    if (albumId && !keepPlaylistContext) {
      try {
        const albumRes = await fetch(`/api/public?album=${albumId}&t=${Date.now()}`, { signal: playerAbortController.signal });
        const albumData = await albumRes.json();
        
        if (albumData.ok && albumData.album) {
          const tracks = albumData.tracks || [];
          
          if (els.albumHeaderCover) els.albumHeaderCover.style.backgroundImage = `url('${albumData.album.coverUrl}')`;
          if (els.albumHeaderTitle) els.albumHeaderTitle.textContent = albumData.album.title;
          if (els.albumHeaderArtist) els.albumHeaderArtist.textContent = albumData.album.artist || 'Joseph Matthos';
          if (els.albumHeaderCount) els.albumHeaderCount.textContent = `${tracks.length} faixas`;

          currentTrackMeta = { ...meta, albumTracks: tracks };
        }
      } catch (albumErr) {
        if (albumErr.name !== 'AbortError') console.warn('[player] Falha ao carregar faixas do álbum:', albumErr);
      }
    }

    // Se estiver mantendo contexto de playlist, usa o currentTrackMeta existente
    if (keepPlaylistContext && currentTrackMeta?.albumTracks) {
      renderPlayerTrackList(currentTrackMeta, trackId);
    } else {
      renderPlayerTrackList({ ...meta, albumTracks: meta.albumTracks || [] }, trackId);
    }

    updateMediaSessionMetadata(meta);

    // Áudio seguro
    audio.src = `/api/stream?trackId=${encodeURIComponent(trackId)}&t=${Date.now()}`;
    console.log('[Player] Solicitando áudio seguro para o backend:', audio.src);
    
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
  
  let nextIndex;
  const currentIndex = tracks.findIndex(t => String(t.id) === String(currentTrackId));

  if (shuffleEnabled && tracks.length > 1) {
    do {
      nextIndex = Math.floor(Math.random() * tracks.length);
    } while (nextIndex === currentIndex);
  } else {
    nextIndex = (currentIndex + 1) % tracks.length;
  }

  const nextTrack = tracks[nextIndex];
  if (nextTrack?.id) window.tocarMusicaDaLista(String(nextTrack.id));
};

window.playerPrev = () => {
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (!currentTrackMeta?.albumTracks) return;
  const tracks = currentTrackMeta.albumTracks;
  const currentIndex = tracks.findIndex(t => String(t.id) === String(currentTrackId));

  let prevIndex;
  if (shuffleEnabled && tracks.length > 1) {
    do {
      prevIndex = Math.floor(Math.random() * tracks.length);
    } while (prevIndex === currentIndex);
  } else {
    prevIndex = (currentIndex - 1 + tracks.length) % tracks.length;
  }

  const prevTrack = tracks[prevIndex];
  if (prevTrack?.id) window.tocarMusicaDaLista(String(prevTrack.id));
};

window.tocarMusicaDaLista = async (id) => {
  if (!id) return;
  history.replaceState(null, '', `/player.html?id=${encodeURIComponent(id)}`);
  
  // Se estamos em uma playlist, mantemos o contexto
  const isPlaylist = currentTrackMeta?.artist === 'Sua Playlist';
  await initPlayer(id, true, isPlaylist);
};

// ─── SHUFFLE E REPEAT ───
window.toggleShuffle = () => {
  shuffleEnabled = !shuffleEnabled;
  const btn = document.getElementById('shuffleBtn');
  if (btn) {
    btn.style.color = shuffleEnabled ? 'var(--green)' : 'var(--text-dim)';
  }
  showToast(shuffleEnabled ? 'Modo Aleatório Ativado' : 'Modo Aleatório Desativado');
};

window.toggleRepeat = () => {
  if (repeatMode === 'off') repeatMode = 'all';
  else if (repeatMode === 'all') repeatMode = 'one';
  else repeatMode = 'off';

  const btn = document.getElementById('repeatBtn');
  if (btn) {
    btn.style.color = repeatMode !== 'off' ? 'var(--green)' : 'var(--text-dim)';
  }
  showToast(`Repetição: ${repeatMode === 'off' ? 'Desligada' : repeatMode === 'all' ? 'Álbum' : 'Música'}`);
};

// ─── EVENTOS DE ÁUDIO ───
function bindAudioEvents() {
  audio.addEventListener('play', () => {
    if (els.playIcon) els.playIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/>';
    if (els.miniPlayBtn) {
      els.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    }
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
    if (els.miniPlayBtn) {
      els.miniPlayBtn.innerHTML = '<svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    }
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
  
  audio.addEventListener('error', (e) => {
    console.error('[Audio] Erro ao carregar o áudio:', audio.error);
    showToast('Erro ao carregar o áudio. Verifique o console.');
  });
}

// ─── BOOT ───
window.addEventListener('DOMContentLoaded', async () => {
  bindAudioEvents();
  setupMediaSessionHandlers();

  document.getElementById('shuffleBtn')?.addEventListener('click', window.toggleShuffle);
  document.getElementById('repeatBtn')?.addEventListener('click', window.toggleRepeat);

  const params = new URLSearchParams(window.location.search);
  const trackId = params.get('id');

  if (trackId) {
    await initPlayer(trackId);
  } else {
    if (els.title) els.title.textContent = 'Nenhuma faixa selecionada';
  }
});