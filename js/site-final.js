/* ============================================================
   SITE.JS — Joseph Matthos (Versão Final Definitiva)
   ============================================================ */

import { DEFAULT_CONTENT, SOCIAL_LABELS, RENTAL_PLANS_FALLBACK } from './config.js';
import { esc, sanitizeHtml, safeMediaUrl, safeExternalUrl, formatPrice, formatTime, debounce, isProductionMode, toast, clone } from './utils.js';
import { initRadio, openRadioModal, onRadioTrackEnded, syncRadioOnTrackChange, isRadioActive, resetRadio } from './radio.js';

export const SITE = { content: null, albums: [], tracks: {}, plans: {}, rentalPlans: [], albumRentalPlans: [], user: null, rentals: [], viewMode: 'cards', filter: 'all', expandedAlbumId: null, shopSearch: '', artistTab: 'lancamentos' };
let audio = null, currentTrackIdentity = null, previewState = { active: false, start: 0, end: Infinity };
let previewNoticeTrackKey = '', isSeeking = false, lastVolume = 0.8, muted = false;
let playerQueue = [], playerQueueIndex = -1, shuffleEnabled = false;
let currentStream = null, renewTimer = null, currentAbortController = null, isRenewing = false;
let _rentContext = { albumId: null, trackIndex: null, planId: null, kind: 'track' };

async function boot() {
  try {
    await Promise.allSettled([loadPublicData(), loadUser()]);
    if (!SITE.content) SITE.content = clone(DEFAULT_CONTENT);
    initPlayer();
    applyContentToSite();
    renderDiscography();
    renderPlaylists();
    renderArtistHero();
    renderSpotifySections();
    initCarousels();
    bindArtistTabs();
    applyArtistTabFilter(SITE.artistTab || 'todos');
    updateAuthUI();
    bindGlobalEvents();
    checkAlbumHash();
    console.log('✅ site-final.js pronto');
  } catch (err) { console.error('❌ Falha no boot:', err); }
}

function deepMerge(target, source) {
  if (Array.isArray(source)) return JSON.parse(JSON.stringify(source));
  if (!source || typeof source !== 'object') return source === undefined ? target : source;
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) { out[key] = deepMerge(target[key] || {}, source[key]); } else { out[key] = source[key]; }
  }
  return out;
}

async function loadPublicData() {
  try {
    const r = await fetch('/api/public_v2', { credentials: 'same-origin', cache: 'no-store' });
    const json = await r.json();
    if (!json || !json.ok) return;
    SITE.content = json.content && typeof json.content === 'object' ? deepMerge(clone(DEFAULT_CONTENT), json.content) : clone(DEFAULT_CONTENT);
    SITE.albums = Array.isArray(json.albums) ? json.albums : [];
    console.log('🔥 Álbuns carregados:', SITE.albums.length);
    SITE.tracks = {};
    if (Array.isArray(json.tracks)) { for (const t of json.tracks) { if (!t) continue; if (t.id) SITE.tracks[t.id] = t; if (t.albumId && t.trackNumber != null) SITE.tracks[`${t.albumId}:${t.trackNumber}`] = t; } }
    SITE.plans = {};
    if (Array.isArray(json.plans)) { for (const p of json.plans) { if (!p || !p.id) continue; const nameLower = String(p.name || '').toLowerCase(); let kind = null; if (nameLower.includes('anual') || nameLower.includes('ano')) kind = 'anual'; else if (nameLower.includes('mensal') || nameLower.includes('premium') || nameLower.includes('pro')) kind = 'premium'; SITE.plans[p.id] = { ...p, kind, priceCents: Number(p.priceCents) || 0, available: p.available !== false && (kind === null || Number(p.priceCents) > 0) }; } }
  } catch (err) { console.warn('[public] falha:', err?.message); }
}

async function loadUser() {
  if (!isProductionMode()) { SITE.user = null; SITE.rentals = []; const loginBtn = document.getElementById('loginBtn'); const signupBtn = document.getElementById('signupBtn'); if (loginBtn) loginBtn.style.display = 'none'; if (signupBtn) signupBtn.style.display = 'none'; return; }
  try {
    const r = await fetch('/api/auth?action=me', { credentials: 'same-origin' });
    if (r.status === 401) { SITE.user = null; SITE.rentals = []; return; }
    const json = await r.json();
    if (r.ok && json.ok && json.user) { SITE.user = json.user; SITE.rentals = Array.isArray(json.rentals) ? json.rentals : []; } else { SITE.user = null; SITE.rentals = []; }
  } catch { SITE.user = null; SITE.rentals = []; }
}

function isPremium() { return SITE.user && (SITE.user.plan === 'premium' || SITE.user.plan === 'anual'); }
function trackInfo(albumId, trackIndexOrId) { if (SITE.tracks[trackIndexOrId]) return SITE.tracks[trackIndexOrId]; return SITE.tracks[`${albumId}:${trackIndexOrId}`] || null; }
function isRented(albumId, trackIndex) { const key = `${albumId}:${trackIndex}`; const now = Date.now(); return SITE.rentals.some((r) => r.trackKey === key && new Date(r.expiresAt).getTime() > now); }
function ownsTrack(albumId, trackIndex) { return isRented(albumId, trackIndex); }
function isLocked(albumId, trackIndex) { return !isPremium() && !ownsTrack(albumId, trackIndex); }
function findAlbum(albumId) { return SITE.albums.find((a) => String(a.id) === String(albumId)) || null; }
function findTrackByIndex(albumId, realTrackIndexOrId) { const album = findAlbum(albumId); if (!album) return null; const tracks = Array.isArray(album.tracks) ? album.tracks : []; return tracks.find((t) => String(t.id) === String(realTrackIndexOrId) || Number(t.trackNumber) === Number(realTrackIndexOrId)) || null; }

function applyContentToSite() { const c = SITE.content; if (!c) return; document.title = c.branding?.meta?.title || 'Joseph Matthos'; const logo = document.getElementById('siteLogo'); if (logo) logo.innerHTML = esc(c.branding?.nameParts?.first || 'Joseph') + ' <span>' + esc(c.branding?.nameParts?.accent || 'Matthos') + '</span>'; const footer = document.getElementById('footerText'); if (footer) footer.textContent = c.branding?.footer || ''; const a = c.aparencia || {}; const root = document.documentElement.style; if (a.bg) root.setProperty('--bg', a.bg); if (a.accent) root.setProperty('--accent', a.accent); if (a.text) root.setProperty('--text', a.text); if (a.accentDark) root.setProperty('--accent-dark', a.accentDark); if (a.border) root.setProperty('--border', a.border); applyBackgroundImage(c.branding?.bgImage); const sobreText = document.getElementById('sobreText'); if (sobreText) { const paragraphs = String(c.sobre?.paragraphs || '').split('\n').filter((p) => p.trim()); sobreText.innerHTML = paragraphs.map((p) => `<p>${sanitizeHtml(p)}</p>`).join('') + (c.sobre?.quote ? `<div class="quote">${esc(c.sobre.quote)}</div>` : ''); } }

function renderArtistHero() { const avatar = document.getElementById('artistAvatar'); if (avatar) { const imageUrl = 'https://f005.backblazeb2.com/file/joseph.matthos/assets/img/avatarjm.jpg'; const safe = safeMediaUrl(imageUrl); if (safe) { avatar.style.display = 'block'; avatar.style.backgroundImage = `url('${safe}')`; avatar.classList.add('visible'); } } }

function bindArtistTabs() { document.querySelectorAll('.artist-tab').forEach((tab) => { if (tab.dataset.bound === '1') return; tab.dataset.bound = '1'; tab.addEventListener('click', () => { document.querySelectorAll('.artist-tab').forEach((t) => t.classList.remove('active')); tab.classList.add('active'); const target = tab.dataset.artistTab || 'todos'; SITE.artistTab = target; applyArtistTabFilter(target); }); }); }

function applyArtistTabFilter(tab) { const secLancamentos = document.getElementById('secao-lancamentos'); const secMaisOuvidos = document.getElementById('secao-mais-ouvidos'); const secDiscografia = document.getElementById('discografia'); const allSections = [secLancamentos, secMaisOuvidos, secDiscografia].filter(Boolean); allSections.forEach((el) => { el.style.display = 'none'; }); if (tab === 'todos') allSections.forEach((el) => { el.style.display = ''; }); else if (tab === 'lancamentos' && secLancamentos) secLancamentos.style.display = ''; else if (tab === 'discografia' && secDiscografia) secDiscografia.style.display = ''; else if (tab === 'mais-ouvidos' && secMaisOuvidos) secMaisOuvidos.style.display = ''; }

function initCarousels() {}

function renderSpotifySections() {
  const albums = SITE.albums || [];
  console.log('🔥 RENDERIZANDO CARDS. Álbuns:', albums.length);
  const lancamentosEl = document.getElementById('gridLancamentos');
  if (lancamentosEl) {
    if (albums.length === 0) { lancamentosEl.innerHTML = '<p style="color:white;">Nenhum álbum encontrado na API.</p>'; }
    else { lancamentosEl.innerHTML = albums.map((a) => `<div class="spotify-card" style="cursor:pointer; margin-bottom: 15px;" onclick="window.location.href='/player.html?album=${a.id}'"><div class="spotify-card-cover"><img src="${safeMediaUrl(a.coverUrl) || 'assets/img/tema.webp'}" alt="${esc(a.title)}" style="width:100%; border-radius:8px;"></div><div class="spotify-card-title" style="color:white; font-weight:bold; margin-top:8px;">${esc(a.title)}</div><div class="spotify-card-sub" style="color:#aaa;">Joseph Matthos</div></div>`).join(''); }
  }
}

function renderDiscography() {
  const container = document.getElementById('discographyContainer');
  if (!container) return;
  const albums = SITE.albums || [];
  if (!albums.length) { container.innerHTML = '<p class="album-empty">Nada encontrado.</p>'; return; }
  const html = albums.map((album) => `<div class="album-card" onclick="window.location.href='/player.html?album=${album.id}'" style="cursor:pointer;"><div class="album-card__cover"><img src="${esc(safeMediaUrl(album.coverUrl))}" style="width:100%;"></div><div class="album-card__title">${esc(album.title)}</div></div>`).join('');
  container.innerHTML = `<div class="album-grid">${html}</div>`;
}

function renderPlaylists() {}
function renderPlans() {}
function initPlayer() { audio = document.getElementById('audio'); if (!audio) return; audio.volume = lastVolume; audio.addEventListener('timeupdate', onTimeUpdate); audio.addEventListener('play', onPlay); audio.addEventListener('pause', onPause); audio.addEventListener('error', onError); audio.addEventListener('ended', onEnded); bindPlayerControls(); updateMuteButtons(); }
function bindPlayerControls() { const bind = (id, fn) => { const el = document.getElementById(id); if (el && el.dataset.bound !== '1') { el.dataset.bound = '1'; el.addEventListener('click', fn); } }; bind('playBtn', togglePlay); bind('nextBtn', nextTrack); bind('prevBtn', prevTrack); bind('muteBtn', toggleMute); }
function togglePlay() { if (!audio || !audio.src) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); }
function nextTrack() {}
function prevTrack() {}
function onEnded() {}
function toggleMute() { if (!audio) return; if (muted) { audio.volume = lastVolume || 0.8; muted = false; } else { lastVolume = audio.volume; audio.volume = 0; muted = true; } updateMuteButtons(); }
function updateMuteButtons() { const btn = document.getElementById('muteBtn'); if (btn) btn.textContent = muted || audio?.volume === 0 ? '🔇' : '🔊'; }
function onTimeUpdate() {}
function onPlay() { const btn = document.getElementById('playBtn'); if (btn) btn.textContent = '⏸'; }
function onPause() { const btn = document.getElementById('playBtn'); if (btn) btn.textContent = '▶'; }
function onError(e) { console.error('[player] erro:', audio?.error); }

async function playFromDiscography(albumId, trackIndexOrId) {
  const album = findAlbum(albumId);
  if (!album) return;
  const track = findTrackByIndex(albumId, trackIndexOrId);
  if (!track) return;
  const trackId = track.id;
  const src = `/api/stream?trackId=${encodeURIComponent(trackId)}`;
  currentTrackIdentity = { albumId, trackIndex: Number(track.trackNumber) || 0, trackId, identity: `${albumId}:${track.trackNumber}` };
  const titleEl = document.getElementById('nowTitle');
  if (titleEl) titleEl.textContent = track.title;
  audio.pause(); audio.removeAttribute('src'); audio.load(); audio.src = src;
  try { await audio.play(); } catch (e) { console.warn(e); }
}

function openAlbumModal(albumId) { window.location.href = `/player.html?album=${albumId}`; }
function openExpandedPlayer(albumId, trackIndexOrId) { const track = findTrackByIndex(albumId, trackIndexOrId); if (track && track.id) window.location.href = `/player.html?id=${track.id}`; }
function bindGlobalEvents() { document.getElementById('loginBtn')?.addEventListener('click', () => openModal('loginModal')); document.getElementById('signupBtn')?.addEventListener('click', () => openModal('signupModal')); }
function updateAuthUI() { const u = SITE.user; const chip = document.getElementById('userChip'); const loginBtn = document.getElementById('loginBtn'); const signupBtn = document.getElementById('signupBtn'); if (u) { if (loginBtn) loginBtn.style.display = 'none'; if (signupBtn) signupBtn.style.display = 'none'; if (chip) chip.classList.add('visible'); } else { if (loginBtn) loginBtn.style.display = ''; if (signupBtn) signupBtn.style.display = ''; if (chip) chip.classList.remove('visible'); } }
function openModal(id) { const el = document.getElementById(id); if (el) el.classList.add('open'); }
function closeModal(id) { const el = document.getElementById(id); if (el) el.classList.remove('open'); }
function applyBackgroundImage(url) { const safe = safeMediaUrl(url); if (safe) document.body.style.backgroundImage = `url('${safe}')`; }
function checkAlbumHash() {}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
