/* ============================================================
   SITE.JS — Joseph Matthos
   ------------------------------------------------------------
   🔧 CORREÇÕES APLICADAS NESTA VERSÃO
   ------------------------------------------------------------
   1. `trackIndex` SEMPRE usa `track.trackIndex` (do banco)
   2. Deep merge de conteúdo remoto com DEFAULT_CONTENT
   3. Planos com `available: false` mostram "Pagamento indisponível"
   4. Aluguéis com `available: false` mostram "Indisponível"
   5. Título da faixa aparece IMEDIATAMENTE (antes do fetch)
   6. Player com previewStart, waitForAudioReady, onError detalhado,
      renovação automática de URL, AbortController
   7. NOVO: Botão de assinatura vai para o MP (como aluguel)
   8. NOVO: Assinantes veem "Gerenciar assinatura"
   9. NOVO: Modal de gerenciamento (status + cancelamento)
   ============================================================ */

import {
  DEFAULT_CONTENT,
  SOCIAL_LABELS,
  RENTAL_PLANS_FALLBACK
} from './config.js';

import {
  esc,
  sanitizeHtml,
  safeMediaUrl,
  safeExternalUrl,
  formatPrice,
  formatTime,
  debounce,
  isProductionMode,
  toast,
  clone
} from './utils.js';

// ─────────────────────────────────────────────────────────────
// ESTADO GLOBAL
// ─────────────────────────────────────────────────────────────
export const SITE = {
  content: null,
  albums: [],
  tracks: {},
  plans: {},
  rentalPlans: [],
  user: null,
  rentals: [],
  viewMode: 'cards',
  filter: 'all',
  expandedAlbumId: null,
  shopSearch: ''
};

let audio = null;
let currentTrackIdentity = null;
let previewState = { active: false, start: 0, end: Infinity };
let previewNoticeTrackKey = '';
let isSeeking = false;
let lastVolume = 0.8;
let muted = false;

let playerQueue = [];
let playerQueueIndex = -1;
let shuffleEnabled = false;

let currentStream = null;
let renewTimer = null;
let currentAbortController = null;
let isRenewing = false;

let _rentContext = { albumId: null, trackIndex: null, planId: null };

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
async function boot() {
  try {
    await Promise.allSettled([loadPublicData(), loadUser()]);
    if (!SITE.content) SITE.content = clone(DEFAULT_CONTENT);

    initPlayer();
    applyContentToSite();
    renderDiscography();
    renderPlaylists();
    updateAuthUI();
    bindGlobalEvents();

    console.log('✅ site.js pronto');
  } catch (err) {
    console.error('❌ Falha no boot:', err);
    try {
      SITE.content = SITE.content || clone(DEFAULT_CONTENT);
      initPlayer();
      applyContentToSite();
      renderDiscography();
      renderPlaylists();
      updateAuthUI();
      bindGlobalEvents();
    } catch (inner) {
      console.error('❌ Fallback também falhou:', inner);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Deep merge helper
// ─────────────────────────────────────────────────────────────
function deepMerge(target, source) {
  if (Array.isArray(source)) return JSON.parse(JSON.stringify(source));
  if (!source || typeof source !== 'object') return source === undefined ? target : source;

  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// FETCH DE DADOS
// ─────────────────────────────────────────────────────────────
async function loadPublicData() {
  try {
    const r = await fetch('/api/public', { credentials: 'same-origin' });
    const json = await r.json();

    if (!json || !json.ok) {
      SITE.content = clone(DEFAULT_CONTENT);
      SITE.albums = [];
      SITE.tracks = {};
      SITE.plans = {};
      SITE.rentalPlans = RENTAL_PLANS_FALLBACK.map((p) => ({ ...p, price: 0, available: false }));
      return;
    }

    SITE.content = json.content && typeof json.content === 'object'
      ? deepMerge(clone(DEFAULT_CONTENT), json.content)
      : clone(DEFAULT_CONTENT);

    SITE.albums = Array.isArray(json.albums) ? json.albums : [];

    SITE.tracks = {};
    if (Array.isArray(json.tracks)) {
      for (const t of json.tracks) {
        if (t && t.albumId) SITE.tracks[`${t.albumId}:${t.trackIndex}`] = t;
      }
    }

    SITE.plans = {};
    if (Array.isArray(json.plans)) {
      for (const p of json.plans) if (p && p.id) SITE.plans[p.id] = p;
    }

    SITE.rentalPlans = [];
    if (Array.isArray(json.rentalPlans)) {
      SITE.rentalPlans = json.rentalPlans
        .filter((p) => p && p.id)
        .map((p) => ({
          id: String(p.id),
          label: String(p.label || p.id),
          days: Number(p.days) || 1,
          hours: Number(p.hours) || 0,
          price: Number(p.price) || 0,
          popular: !!p.popular,
          available: p.available !== false && Number(p.price) > 0
        }));
    }

    if (!SITE.rentalPlans.length) {
      SITE.rentalPlans = RENTAL_PLANS_FALLBACK.map((p) => ({
        ...p,
        price: 0,
        available: false
      }));
    }
  } catch (err) {
    console.warn('[public] falha, usando DEFAULT_CONTENT:', err?.message);
    SITE.content = clone(DEFAULT_CONTENT);
    SITE.albums = [];
    SITE.tracks = {};
    SITE.plans = {};
    SITE.rentalPlans = RENTAL_PLANS_FALLBACK.map((p) => ({
      ...p,
      price: 0,
      available: false
    }));
  }
}

async function loadUser() {
  if (!isProductionMode()) {
    SITE.user = null;
    SITE.rentals = [];
    const loginBtn = document.getElementById('loginBtn');
    const signupBtn = document.getElementById('signupBtn');
    if (loginBtn) loginBtn.style.display = 'none';
    if (signupBtn) signupBtn.style.display = 'none';
    return;
  }
  try {
    const r = await fetch('/api/auth?action=me', { credentials: 'same-origin' });
    const json = await r.json();
    if (r.ok && json.ok && json.user) {
      SITE.user = json.user;
      SITE.rentals = Array.isArray(json.rentals) ? json.rentals : [];
    } else {
      SITE.user = null;
      SITE.rentals = [];
    }
  } catch {
    SITE.user = null;
    SITE.rentals = [];
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS DERIVADOS
// ─────────────────────────────────────────────────────────────
function isPremium() {
  return SITE.user && (SITE.user.plan === 'premium' || SITE.user.plan === 'anual');
}

function trackInfo(albumId, trackIndex) {
  return SITE.tracks[`${albumId}:${trackIndex}`] || null;
}

function isRented(albumId, trackIndex) {
  const key = `${albumId}:${trackIndex}`;
  const now = Date.now();
  return SITE.rentals.some(
    (r) => r.trackKey === key && new Date(r.expiresAt).getTime() > now
  );
}

function ownsTrack(albumId, trackIndex) {
  return isRented(albumId, trackIndex);
}

function isLocked(albumId, trackIndex) {
  return !isPremium() && !ownsTrack(albumId, trackIndex);
}

function findAlbum(albumId) {
  return SITE.albums.find((a) => a.id === albumId) || null;
}

function findTrackByIndex(albumId, realTrackIndex) {
  const album = findAlbum(albumId);
  if (!album) return null;
  const tracks = Array.isArray(album.tracks) ? album.tracks : [];
  return tracks.find((t) => Number(t.trackIndex) === Number(realTrackIndex)) || null;
}

// ─────────────────────────────────────────────────────────────
// APLICA CONTEÚDO NO DOM
// ─────────────────────────────────────────────────────────────
function applyContentToSite() {
  const c = SITE.content;
  if (!c) return;

  document.title = c.branding?.meta?.title || 'Joseph Matthos';
  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc && c.branding?.meta?.description) {
    metaDesc.setAttribute('content', c.branding.meta.description);
  }

  const logo = document.getElementById('siteLogo');
  if (logo) {
    logo.innerHTML =
      esc(c.branding?.nameParts?.first || 'Joseph') +
      ' <span>' +
      esc(c.branding?.nameParts?.accent || 'Matthos') +
      '</span>';
  }

  const footer = document.getElementById('footerText');
  if (footer) footer.textContent = c.branding?.footer || '';

  const a = c.aparencia || {};
  const root = document.documentElement.style;
  if (a.bg) root.setProperty('--bg', a.bg);
  if (a.accent) root.setProperty('--accent', a.accent);
  if (a.text) root.setProperty('--text', a.text);
  if (a.accentDark) root.setProperty('--accent-dark', a.accentDark);
  if (a.border) root.setProperty('--border', a.border);

  applyBackgroundImage(c.branding?.bgImage);

  const heroTitle = document.getElementById('heroTitle');
  if (heroTitle) heroTitle.innerHTML = sanitizeRichText(c.hero?.title);
  const heroSub = document.getElementById('heroSub');
  if (heroSub) heroSub.textContent = c.hero?.subtitle || '';

  const bp = document.getElementById('heroBtnPrimary');
  if (bp) {
    bp.textContent = c.hero?.primaryBtn?.text || '';
    bp.href = c.hero?.primaryBtn?.link || '#';
  }
  const bs = document.getElementById('heroBtnSecondary');
  if (bs) {
    bs.textContent = c.hero?.secondaryBtn?.text || '';
    bs.dataset.action = 'open-plans';
  }

  const lyricEl = document.getElementById('heroLyric');
  if (lyricEl) lyricEl.textContent = c.hero?.vinyl?.lyric || '';

  const vinyl = document.getElementById('heroVinyl');
  if (vinyl) {
    let coverDiv = vinyl.querySelector('.cover-img');
    if (!coverDiv) {
      coverDiv = document.createElement('div');
      coverDiv.className = 'cover-img';
      vinyl.prepend(coverDiv);
    }
    applyImageSafe(coverDiv, c.hero?.vinyl?.image, 'loaded');
    vinyl.classList.toggle('has-cover', !!c.hero?.vinyl?.image);
  }

  const sobreTitle = document.getElementById('sobreTitle');
  if (sobreTitle) sobreTitle.innerHTML = sanitizeRichText(c.sobre?.title);
  const sobreSub = document.getElementById('sobreSub');
  if (sobreSub) sobreSub.textContent = c.sobre?.subtitle || '';
  applyImageSafe(document.getElementById('sobreImg'), c.sobre?.image, 'has-img');

  const sobreText = document.getElementById('sobreText');
  if (sobreText) {
    const paragraphs = String(c.sobre?.paragraphs || '')
      .split('\n')
      .filter((p) => p.trim());
    sobreText.innerHTML =
      paragraphs.map((p) => `<p>${sanitizeHtml(p)}</p>`).join('') +
      (c.sobre?.quote ? `<div class="quote">${esc(c.sobre.quote)}</div>` : '');
  }

  const filTitle = document.getElementById('filosofiaTitle');
  if (filTitle) filTitle.innerHTML = sanitizeRichText(c.filosofia?.title);
  const filSub = document.getElementById('filosofiaSub');
  if (filSub) filSub.textContent = c.filosofia?.subtitle || '';

  const frasesGrid = document.getElementById('frasesGrid');
  if (frasesGrid) {
    frasesGrid.innerHTML = (c.filosofia?.frases || [])
      .map(
        (f) => `
        <div class="frase-card">
          <p>"${esc(f.text)}"</p>
          <span class="author">— ${esc(f.author)}</span>
        </div>`
      )
      .join('');
  }

  const discoTitle = document.getElementById('discoTitle');
  if (discoTitle) discoTitle.innerHTML = sanitizeRichText(c.discografia?.title);
  const discoSub = document.getElementById('discoSub');
  if (discoSub) discoSub.textContent = c.discografia?.subtitle || '';

  const plansTitle = document.getElementById('plansModalTitle');
  if (plansTitle) plansTitle.innerHTML = sanitizeRichText(c.planos?.title);
  const plansSub = document.getElementById('plansModalSub');
  if (plansSub) plansSub.textContent = c.planos?.subtitle || '';
  renderPlans();

  const cTitle = document.getElementById('contatoTitle');
  if (cTitle) cTitle.innerHTML = sanitizeRichText(c.contato?.title);
  const cSub = document.getElementById('contatoSub');
  if (cSub) cSub.textContent = c.contato?.subtitle || '';
  const cHeading = document.getElementById('contatoHeading');
  if (cHeading) cHeading.textContent = c.contato?.heading || '';
  const cDesc = document.getElementById('contatoDesc');
  if (cDesc) cDesc.textContent = c.contato?.description || '';

  const socialLinks = document.getElementById('socialLinks');
  if (socialLinks) {
    socialLinks.innerHTML = (c.contato?.socials || [])
      .map((s) => {
        const network = s.network || s.icon || 'link';
        const label = SOCIAL_LABELS[network] || network;
        return `
          <a href="${esc(safeExternalUrl(s.url))}"
             target="_blank" rel="noopener noreferrer"
             class="ad-social-icon ${esc(network)}"
             data-label="${esc(label)}"
             aria-label="${esc(label)}">${getSocialIconHTML(network)}</a>`;
      })
      .join('');
  }
}

// ─────────────────────────────────────────────────────────────
// PLANOS (assinatura)
// ─────────────────────────────────────────────────────────────
function renderPlans() {
  const grid = document.getElementById('plansGrid');
  if (!grid) return;

  const plans = SITE.content?.planos?.plans || [];
  const currentPlan = SITE.user?.plan || 'free';
  const userIsPremium = currentPlan === 'premium' || currentPlan === 'anual';

  grid.innerHTML = plans
    .map((p) => {
      const priceInfo = SITE.plans[p.id] || {};
      const cents = priceInfo.priceCents || 0;
      const interval = priceInfo.interval;
      const available = priceInfo.available !== false && (p.id === 'free' || cents > 0);

      const priceText = cents > 0 ? formatPrice(cents / 100) : 'R$ 0';
      const suffixText =
        interval === 'month' ? '/mês' : interval === 'year' ? '/ano' : '';

      const isCurrent = SITE.user && currentPlan === p.id;
      const isPaidPlan = p.id === 'premium' || p.id === 'anual';
      const isManageView = userIsPremium && isPaidPlan;

      let ctaText = p.cta;
      let disabled = p.disabled;
      let dataAttrs = `data-plan="${esc(p.id)}"`;

      if (isCurrent) {
        ctaText = 'Plano atual';
        disabled = true;
        dataAttrs = '';
      } else if (isManageView) {
        if (currentPlan === p.id) {
          ctaText = 'Gerenciar assinatura';
          dataAttrs = 'data-manage="true"';
        } else {
          ctaText = 'Mudar para este plano';
          dataAttrs = `data-plan="${esc(p.id)}"`;
        }
      } else if (!available) {
        ctaText = 'Pagamento indisponível';
        disabled = true;
        dataAttrs = '';
      }

      return `
        <div class="plan-card ${p.featured ? 'featured' : ''} ${isCurrent ? 'is-current' : ''}">
          ${p.badge ? `<div class="plan-badge">${esc(p.badge)}</div>` : ''}
          <div class="plan-name">${esc(p.name)}</div>
          <div class="plan-price">${esc(priceText)}<small>${esc(suffixText)}</small></div>
          <p class="plan-desc">${esc(p.desc)}</p>
          <ul class="plan-features">
            ${(p.features || [])
              .map((f) => `<li class="${f.ok ? '' : 'no'}">${esc(f.text)}</li>`)
              .join('')}
          </ul>
          <button class="btn ${p.featured ? 'btn-primary' : 'btn-outline'} btn-block"
                  ${disabled ? 'disabled style="opacity:0.6;cursor:default;"' : dataAttrs}>
            ${esc(ctaText)}
          </button>
        </div>`;
    })
    .join('');

  // Bind: assinar
  grid.querySelectorAll('[data-plan]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => subscribe(btn.dataset.plan));
  });

  // Bind: gerenciar
  grid.querySelectorAll('[data-manage]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      closeModal('plansModal');
      openManageModal();
    });
  });
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA
// ─────────────────────────────────────────────────────────────
function renderDiscography() {
  const container = document.getElementById('discographyContainer');
  if (!container) return;

  const albums = SITE.albums;
  const filtered =
    SITE.filter === 'all'
      ? albums
      : albums.filter((a) => a.type === SITE.filter);

  const q = SITE.shopSearch.trim().toLowerCase();
  const premium = isPremium();

  if (!filtered.length) {
    container.innerHTML =
      '<p class="album-empty">Nada encontrado neste filtro.</p>';
    return;
  }

  const html = filtered
    .map((album) => {
      const albumTracks = Array.isArray(album.tracks) ? album.tracks : [];
      const visibleTracks = albumTracks.filter(
        (track) =>
          !q ||
          (track.title || '').toLowerCase().includes(q) ||
          (album.title || '').toLowerCase().includes(q)
      );

      if (!visibleTracks.length && q) return '';

      const isExpanded = q ? true : SITE.expandedAlbumId === album.id;

      return `
        <div class="album-block ${isExpanded ? 'expanded' : ''}" data-album="${esc(album.id)}">
          <div class="album-header" data-action="toggle-album" data-album="${esc(album.id)}">
            <div class="album-cover" ${
              album.coverImage
                ? `style="background-image:url('${esc(safeMediaUrl(album.coverImage))}')"`
                : ''
            }>
              ${album.coverImage ? '' : esc(album.coverInitials || album.cover || '♪')}
            </div>
            <div class="album-info">
              <div class="album-title">
                ${esc(album.title)}
                <span class="album-badge ${premium ? 'premium' : ''}">${
                  premium ? 'Premium' : 'Prévia'
                }</span>
              </div>
              <div class="album-meta">
                <span class="gold">${esc((album.type || 'album').toUpperCase())}</span>
                · ${album.year || '—'}
                · ${visibleTracks.length} faixa${visibleTracks.length === 1 ? '' : 's'}
              </div>
              ${
                album.description
                  ? `<div class="album-desc">${esc(album.description)}</div>`
                  : ''
              }
            </div>
            <div class="album-actions">
              <button class="album-toggle" aria-label="Expandir/recolher"
                      data-action="toggle-album" data-album="${esc(album.id)}">▼</button>
            </div>
          </div>
          <div class="album-tracks">
            <div class="discography-scroll" data-album="${esc(album.id)}">
              ${
                visibleTracks.length
                  ? visibleTracks
                      .map((track) => renderTrackCard(album, track))
                      .join('')
                  : '<p class="album-empty">Nenhuma faixa cadastrada neste álbum.</p>'
              }
            </div>
          </div>
        </div>`;
    })
    .join('');

  container.dataset.viewMode = SITE.viewMode;
  container.classList.toggle('view-list', SITE.viewMode === 'list');
  container.innerHTML = html || '<p class="album-empty">Nada encontrado.</p>';

  container.querySelectorAll('[data-action="open-rent"]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openRentModal(btn.dataset.album, Number(btn.dataset.trackIndex));
    });
  });

  updatePlayingHighlight();
}

function renderTrackCard(album, track) {
  const realIndex = Number(track.trackIndex) || 0;
  const info = trackInfo(album.id, realIndex);
  const priceCents = info && Number.isFinite(info.priceCents) ? info.priceCents : 0;
  const hasPriceInfo = !!info && priceCents > 0;
  const forSale = info ? info.forSale !== false && hasPriceInfo : false;
  const premium = isPremium();
  const rented = isRented(album.id, realIndex);
  const locked = isLocked(album.id, realIndex);

  const identity = `${album.id}:${realIndex}`;
  const isPlaying =
    currentTrackIdentity && currentTrackIdentity.identity === identity;

  const coverStyle = album.coverImage
    ? `style="background-image:url('${esc(safeMediaUrl(album.coverImage))}')"`
    : '';
  const coverText = album.coverImage
    ? ''
    : esc(album.coverInitials || album.cover || '♪');

  const stateHTML = premium
    ? '<span class="track-state">✓ Premium</span>'
    : rented
    ? '<span class="track-state">✓ Sua</span>'
    : locked
    ? '<span class="track-state">🔒 Bloqueada</span>'
    : '<span class="track-state">▶</span>';

  const rentBtn = (premium || rented || !forSale)
    ? ''
    : `<button class="track-action-icon buy"
              type="button"
              data-action="open-rent"
              data-album="${esc(album.id)}"
              data-track-index="${realIndex}"
              title="Alugar">🎫</button>`;

  return `
    <div class="discography-track-card ${isPlaying ? 'playing' : ''}"
         data-album="${esc(album.id)}"
         data-track-index="${realIndex}"
         data-identity="${esc(identity)}"
         data-action="open-player">
      <span class="track-index">${isPlaying ? '▶' : realIndex + 1}</span>
      <span class="track-cover" ${coverStyle}>${coverText}</span>
      <span class="track-info">
        <span class="track-title">${esc(track.title)}</span>
        <span class="track-duration">${esc(track.duration || '—')}</span>
      </span>
      <span class="track-right">
        ${rentBtn}
        ${stateHTML}
      </span>
    </div>`;
}

// ─────────────────────────────────────────────────────────────
// PLAYLISTS
// ─────────────────────────────────────────────────────────────
function renderPlaylists() {
  const grid = document.getElementById('playlistsGrid');
  if (!grid) return;

  const playlists = Array.isArray(SITE.content?.playlists)
    ? SITE.content.playlists
    : [];

  if (!playlists.length) {
    grid.innerHTML = '<p class="lyrics-empty">Nenhuma playlist disponível.</p>';
    return;
  }

  grid.innerHTML = playlists
    .map((playlist, index) => {
      const tracks = resolvePlaylistTracks(playlist);
      return `
        <div class="playlist-card" role="button" tabindex="0"
             data-action="open-playlist" data-playlist-index="${index}">
          <span class="playlist-cover">${esc(playlist.cover || '♪')}</span>
          <span class="playlist-info">
            <strong>${esc(playlist.title || 'Playlist')}</strong>
            <small>${esc(playlist.description || '')}</small>
            <em>${tracks.length} faixa${tracks.length === 1 ? '' : 's'}</em>
          </span>
          <span class="playlist-play">▶</span>
        </div>`;
    })
    .join('');
}

function resolvePlaylistTracks(playlist) {
  if (!playlist || !Array.isArray(playlist.tracks)) return [];

  const index = new Map();
  for (const album of SITE.albums || []) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    tracks.forEach((track) => {
      if (track && track.id !== undefined && track.id !== null) {
        index.set(Number(track.id), {
          album,
          track,
          trackIndex: Number(track.trackIndex) || 0
        });
      }
    });
  }

  const out = [];
  for (const ref of playlist.tracks) {
    if (typeof ref === 'number' && Number.isFinite(ref)) {
      const entry = index.get(ref);
      if (entry) out.push(entry);
      continue;
    }
    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum) && String(asNum) === trimmed) {
        const entry = index.get(asNum);
        if (entry) out.push(entry);
      }
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// MODAL DE ALUGUEL
// ─────────────────────────────────────────────────────────────
function openRentModal(albumId, trackIndex) {
  const album = findAlbum(albumId);
  const track = findTrackByIndex(albumId, trackIndex);
  if (!album || !track) {
    toast('Faixa indisponível para aluguel.', '⚠');
    return;
  }

  if (isPremium()) {
    toast('Você já é Premium — ouça sem alugar.', '✓');
    return;
  }
  if (isRented(albumId, trackIndex)) {
    toast('Você já alugou esta faixa.', '✓');
    return;
  }

  const plans = SITE.rentalPlans;
  const firstAvailable = plans.find((p) => p.available && p.popular)
    || plans.find((p) => p.available);

  _rentContext = {
    albumId,
    trackIndex,
    planId: firstAvailable?.id || null
  };

  const cover = document.getElementById('rentTrackCover');
  if (cover) {
    cover.innerHTML = '';
    cover.style.backgroundImage = '';
    const safeCover = safeMediaUrl(album.coverImage);
    if (safeCover) {
      const img = document.createElement('img');
      img.src = safeCover;
      img.alt = album.title || 'Capa';
      cover.appendChild(img);
    } else {
      cover.textContent = album.coverInitials || album.cover || '♪';
    }
  }
  const titleEl = document.getElementById('rentTrackTitle');
  if (titleEl) titleEl.textContent = track.title;
  const albumEl = document.getElementById('rentTrackAlbum');
  if (albumEl) albumEl.textContent = `${album.title} · ${track.duration || ''}`.trim();

  const optionsEl = document.getElementById('rentOptions');
  if (optionsEl) {
    const hasAnyAvailable = plans.some((p) => p.available);

    if (!hasAnyAvailable) {
      optionsEl.innerHTML = `
        <p class="hint" style="color:var(--warning,#f0a100);text-align:center;padding:1rem;">
          Aluguel temporariamente indisponível. Tente novamente em instantes.
        </p>`;
      const errEl2 = document.getElementById('rentError');
      if (errEl2) errEl2.textContent = '';
      openModal('rentModal');
      return;
    }

    optionsEl.innerHTML = plans.map((p) => {
      const disabled = !p.available;
      const selected = p.id === _rentContext.planId;
      const priceText = p.available
        ? esc(formatPrice(p.price))
        : '<span style="color:var(--text-dim);font-size:0.85rem;">Indisponível</span>';

      return `
        <label class="rent-option ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}"
               data-plan="${esc(p.id)}"
               ${disabled ? 'style="opacity:0.55;cursor:not-allowed;"' : ''}>
          <input type="radio" name="rent-plan" value="${esc(p.id)}"
                 ${selected ? 'checked' : ''}
                 ${disabled ? 'disabled' : ''}>
          <span>
            <span class="rent-option-label">${esc(p.label)}</span>
            <span class="rent-option-sub">Acesso por ${p.days} dia${p.days > 1 ? 's' : ''}</span>
          </span>
          <span class="rent-option-price">${priceText}</span>
          ${p.popular && p.available ? '<span class="popular-tag">Mais popular</span>' : ''}
        </label>
      `;
    }).join('');

    optionsEl.querySelectorAll('input[name="rent-plan"]:not(:disabled)').forEach((radio) => {
      radio.addEventListener('change', () => {
        _rentContext.planId = radio.value;
        optionsEl.querySelectorAll('.rent-option').forEach((opt) => {
          opt.classList.toggle('selected', opt.dataset.plan === radio.value);
        });
      });
    });
  }

  const errEl = document.getElementById('rentError');
  if (errEl) errEl.textContent = '';

  openModal('rentModal');
}

async function confirmRent() {
  const errEl = document.getElementById('rentError');

  if (!SITE.user) {
    closeModal('rentModal');
    toast('Entre na sua conta para alugar.', 'ℹ');
    openModal('loginModal');
    return;
  }
  if (!_rentContext.albumId || !_rentContext.planId) {
    if (errEl) errEl.textContent = 'Escolha um período.';
    return;
  }

  const selected = SITE.rentalPlans.find((p) => p.id === _rentContext.planId);
  if (!selected || !selected.available) {
    if (errEl) errEl.textContent = 'Período indisponível. Escolha outro.';
    return;
  }

  try {
    if (errEl) errEl.textContent = 'Abrindo checkout...';
    const r = await fetch('/api/payments?type=rental', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        albumId: _rentContext.albumId,
        trackIndex: _rentContext.trackIndex,
        planId: _rentContext.planId
      })
    });
    const json = await r.json();
    if (!r.ok || !json.ok || !json.checkoutUrl) {
      if (errEl) errEl.textContent = json.error || 'Não foi possível iniciar o pagamento.';
      return;
    }
    window.location.assign(json.checkoutUrl);
  } catch (err) {
    console.error('[rent]', err);
    if (errEl) errEl.textContent = 'Gateway de pagamento indisponível.';
  }
}

// ─────────────────────────────────────────────────────────────
// ASSINATURA
// ─────────────────────────────────────────────────────────────
async function subscribe(planId) {
  if (!SITE.user) {
    toast('Crie uma conta para assinar.', 'ℹ');
    openModal('signupModal');
    return;
  }

  // Se já tem este plano → abre gerenciar
  if (SITE.user.plan === planId) {
    closeModal('plansModal');
    openManageModal();
    return;
  }

  // Se já é premium e quer outro plano pago → gerenciar (não permite duplicar)
  const currentIsPremium = ['premium', 'anual'].includes(SITE.user.plan);
  const wantsPaid = ['premium', 'anual'].includes(planId);

  if (currentIsPremium && wantsPaid) {
    toast('Você já tem uma assinatura ativa. Cancele antes de trocar.', 'ℹ');
    closeModal('plansModal');
    openManageModal();
    return;
  }

  const planInfo = SITE.plans[planId];
  if (planInfo && planInfo.available === false) {
    toast('Pagamento indisponível para este plano.', '⚠');
    return;
  }

  try {
    toast('Abrindo checkout seguro...', '✦');
    const r = await fetch('/api/payments?type=subscription', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: planId })
    });
    const json = await r.json();

    if (!r.ok || !json.ok || !json.checkoutUrl) {
      if (r.status === 409) {
        toast('Você já tem uma assinatura ativa.', 'ℹ');
        closeModal('plansModal');
        openManageModal();
        return;
      }
      toast(json.error || 'Pagamento indisponível.', '⚠');
      return;
    }

    window.location.assign(json.checkoutUrl);
  } catch (err) {
    console.error('[subscribe]', err);
    toast('Gateway de pagamento indisponível.', '⚠');
  }
}

// ─────────────────────────────────────────────────────────────
// GERENCIAR ASSINATURA
// ─────────────────────────────────────────────────────────────
async function openManageModal() {
  if (!SITE.user) {
    openModal('loginModal');
    return;
  }

  // Remove qualquer instância antiga
  document.getElementById('manageSubscriptionModal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'manageSubscriptionModal';
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" data-close-manage aria-label="Fechar modal">×</button>
      <h2>Gerenciar <span style="color:var(--accent);">assinatura</span></h2>
      <p class="sub">Veja e gerencie sua assinatura Premium.</p>

      <div id="manageContent">
        <div class="admin-loading">Carregando…</div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';

  const closeManage = () => {
    overlay.remove();
    document.body.style.overflow = '';
  };

  overlay.querySelector('[data-close-manage]').addEventListener('click', closeManage);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeManage();
  });

  const content = overlay.querySelector('#manageContent');

  try {
    const r = await fetch('/api/payments?type=manage', {
      credentials: 'same-origin',
      cache: 'no-store'
    });
    const json = await r.json();

    if (!r.ok || !json.ok) {
      content.innerHTML = `<p style="color:var(--danger);text-align:center;padding:1rem;">
        ${esc(json.error || 'Erro ao carregar.')}</p>`;
      return;
    }

    if (!json.subscription) {
      content.innerHTML = `
        <p class="hint" style="color:var(--text-dim);text-align:center;padding:1rem 0;">
          Você não tem assinatura ativa.
        </p>
        <button class="btn btn-primary btn-block" id="manageSubscribeBtn">
          Assinar Premium
        </button>
      `;
      overlay.querySelector('#manageSubscribeBtn')?.addEventListener('click', () => {
        closeManage();
        openModal('plansModal');
      });
      return;
    }

    const sub = json.subscription;
    const planLabel = sub.plan === 'anual' ? 'Premium Anual' : 'Premium Mensal';
    const statusLabel = {
      authorized: 'Ativa',
      trialing: 'Período de teste',
      canceled: 'Cancelada',
      paused: 'Pausada',
      pending: 'Pendente'
    }[sub.status] || sub.status;

    const fmt = (iso) => {
      if (!iso) return '—';
      try {
        return new Date(iso).toLocaleDateString('pt-BR', {
          day: '2-digit', month: 'long', year: 'numeric'
        });
      } catch { return '—'; }
    };

    const isActive = ['authorized', 'trialing'].includes(sub.status);

    content.innerHTML = `
      <div class="admin-card" style="padding:1rem;margin-bottom:1rem;">
        <div style="font-size:0.7rem;letter-spacing:0.1em;text-transform:uppercase;
                    color:var(--text-dim);font-weight:600;margin-bottom:0.4rem;">
          Plano
        </div>
        <div style="font-family:var(--font-serif);font-size:1.4rem;
                    font-weight:700;color:var(--accent);">
          ${esc(planLabel)}
        </div>
        <div style="font-size:0.85rem;color:var(--text-dim);margin-top:0.3rem;">
          Status: <strong style="color:${isActive ? 'var(--success)' : 'var(--danger)'};">
            ${esc(statusLabel)}
          </strong>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;">
        <div style="background:var(--card);border:1px solid var(--border);
                    border-radius:12px;padding:0.9rem;">
          <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);
                      font-weight:600;margin-bottom:0.3rem;">Início</div>
          <div style="font-size:0.9rem;color:var(--text);">
            ${esc(fmt(sub.startedAt || sub.createdAt))}
          </div>
        </div>
        <div style="background:var(--card);border:1px solid var(--border);
                    border-radius:12px;padding:0.9rem;">
          <div style="font-size:0.7rem;text-transform:uppercase;color:var(--text-dim);
                      font-weight:600;margin-bottom:0.3rem;">
            ${sub.status === 'canceled' ? 'Cancelada em' : 'Próxima cobrança'}
          </div>
          <div style="font-size:0.9rem;color:var(--text);">
            ${esc(fmt(sub.canceledAt || sub.currentPeriodEnd))}
          </div>
        </div>
      </div>

      ${isActive ? `
        <button class="btn btn-outline btn-block" id="cancelSubBtn"
                style="border-color:var(--danger);color:var(--danger);">
          Cancelar assinatura
        </button>
        <p class="hint" style="color:var(--text-dim);font-size:0.75rem;
                  text-align:center;margin-top:0.8rem;">
          Você mantém acesso até ${esc(fmt(sub.currentPeriodEnd))}.
        </p>
      ` : `
        <button class="btn btn-primary btn-block" id="renewSubBtn">
          Reativar assinatura
        </button>
      `}
    `;

    // Cancelar
    overlay.querySelector('#cancelSubBtn')?.addEventListener('click', async () => {
      if (!confirm('Tem certeza que deseja cancelar sua assinatura?\n\nVocê mantém acesso até o fim do período já pago.')) {
        return;
      }

      const btn = overlay.querySelector('#cancelSubBtn');
      btn.disabled = true;
      btn.textContent = 'Cancelando…';

      try {
        const cr = await fetch('/api/payments?type=manage', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'cancel' })
        });
        const cjson = await cr.json();

        if (!cr.ok || !cjson.ok) {
          toast(cjson.error || 'Falha ao cancelar.', '⚠');
          btn.disabled = false;
          btn.textContent = 'Cancelar assinatura';
          return;
        }

        toast(cjson.message || 'Assinatura cancelada.', '✓');
        closeManage();

        await loadUser();
        updateAuthUI();
        renderPlans();
      } catch (err) {
        console.error('[manage] cancel:', err);
        toast('Erro ao cancelar.', '⚠');
        btn.disabled = false;
        btn.textContent = 'Cancelar assinatura';
      }
    });

    // Reativar
    overlay.querySelector('#renewSubBtn')?.addEventListener('click', () => {
      closeManage();
      openModal('plansModal');
    });

  } catch (err) {
    console.error('[manage] erro:', err);
    content.innerHTML = `<p style="color:var(--danger);text-align:center;padding:1rem;">
      Erro ao carregar dados.</p>`;
  }
}

// ─────────────────────────────────────────────────────────────
// DELEGAÇÃO GLOBAL
// ─────────────────────────────────────────────────────────────
function bindGlobalEvents() {
  document.addEventListener('click', async (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;

    switch (action) {
      case 'toggle-album': {
        const albumId = actionEl.dataset.album;
        if (!albumId) break;
        SITE.expandedAlbumId = SITE.expandedAlbumId === albumId ? null : albumId;
        renderDiscography();
        break;
      }
      case 'open-player': {
        if (e.target.closest('button')) break;
        const albumId = actionEl.dataset.album;
        const trackIndex = Number(actionEl.dataset.trackIndex);
        openExpandedPlayer(albumId, trackIndex);
        break;
      }
      case 'open-rent': {
        e.preventDefault();
        e.stopPropagation();
        openRentModal(actionEl.dataset.album, Number(actionEl.dataset.trackIndex));
        break;
      }
      case 'open-plans': {
        e.preventDefault();
        e.stopPropagation();
        openModal('plansModal');
        break;
      }
      case 'play-queue': {
        const idx = Number(actionEl.dataset.queueIndex);
        if (!Number.isInteger(idx) || !playerQueue[idx]) break;
        playerQueueIndex = idx;
        const item = playerQueue[idx];
        playFromDiscography(item.albumId, item.trackIndex, { fromQueue: true });
        renderQueue();
        break;
      }
      case 'open-playlist': {
        openPlaylistPlayer(Number(actionEl.dataset.playlistIndex));
        break;
      }
    }
  });

  const shopSearch = document.getElementById('shopSearch');
  if (shopSearch && shopSearch.dataset.bound !== '1') {
    shopSearch.dataset.bound = '1';
    shopSearch.addEventListener('input', debounce(() => {
      SITE.shopSearch = shopSearch.value;
      renderDiscography();
    }, 250));
  }

  const filterBar = document.getElementById('filterBar');
  if (filterBar && filterBar.dataset.bound !== '1') {
    filterBar.dataset.bound = '1';
    filterBar.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('.view-mode-btn');
      if (viewBtn) {
        filterBar.querySelectorAll('.view-mode-btn').forEach((b) => b.classList.remove('active'));
        viewBtn.classList.add('active');
        SITE.viewMode = viewBtn.dataset.viewMode === 'list' ? 'list' : 'cards';
        renderDiscography();
        return;
      }
      const filterBtn = e.target.closest('.filter-btn');
      if (!filterBtn) return;
      filterBar.querySelectorAll('.filter-btn').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      filterBtn.classList.add('active');
      filterBtn.setAttribute('aria-selected', 'true');
      SITE.filter = filterBtn.dataset.filter || 'all';
      renderDiscography();
    });
  }

  document.getElementById('loginBtn')?.addEventListener('click', () => openModal('loginModal'));
  document.getElementById('signupBtn')?.addEventListener('click', () => openModal('signupModal'));
  document.getElementById('userChip')?.addEventListener('click', openAccountModal);

  document.getElementById('switchToSignup')?.addEventListener('click', () => {
    closeModal('loginModal');
    openModal('signupModal');
  });
  document.getElementById('switchToLogin')?.addEventListener('click', () => {
    closeModal('signupModal');
    openModal('loginModal');
  });

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try { await fetch('/api/auth?action=logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    SITE.user = null;
    SITE.rentals = [];
    closeModal('accountModal');
    updateAuthUI();
    renderDiscography();
    toast('Você saiu da conta.', 'ℹ');
  });

  document.getElementById('loginForm')?.addEventListener('submit', onLoginSubmit);
  document.getElementById('signupForm')?.addEventListener('submit', onSignupSubmit);

  document.getElementById('newsletterForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    toast('Obrigado! Em breve novidades.', '✦');
    e.target.reset();
  });

  document.getElementById('rentConfirmBtn')?.addEventListener('click', confirmRent);

  document.querySelectorAll('[data-close]').forEach((el) => {
    if (el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    el.addEventListener('click', () => {
      el.closest('.modal-overlay')?.classList.remove('open');
      document.body.style.overflow = '';
    });
  });

  document.querySelectorAll('.modal-overlay').forEach((o) => {
    if (o.dataset.bound === '1') return;
    o.dataset.bound = '1';
    o.addEventListener('click', (e) => {
      if (e.target === o) {
        o.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('.modal-overlay.open').forEach((m) => m.classList.remove('open'));
    document.body.style.overflow = '';
  });

  document.addEventListener('keydown', (e) => {
    const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
    const pub = document.getElementById('publicSite');
    const publicVisible = pub && pub.style.display !== 'none';
    if (e.code === 'Space' && !inField && publicVisible) {
      e.preventDefault();
      togglePlay();
    }
  });
}

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────
async function onLoginSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('loginError');
  const email = document.getElementById('loginEmail').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;

  if (!email || !password) {
    errEl.textContent = 'Preencha e-mail e senha.';
    return;
  }

  errEl.textContent = 'Validando...';
  try {
    const r = await fetch('/api/auth?action=login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const json = await r.json();
    if (!r.ok || !json.ok) {
      errEl.textContent = json.error || 'E-mail ou senha incorretos.';
      return;
    }
    errEl.textContent = '';
    SITE.user = json.user;
    e.target.reset();
    closeModal('loginModal');
    await loadUser();
    updateAuthUI();
    renderDiscography();
    toast(`Bem-vindo, ${(json.user.name || json.user.email).split(' ')[0]}!`, '✦');
  } catch (err) {
    console.error('[login]', err);
    errEl.textContent = 'Serviço indisponível.';
  }
}

async function onSignupSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('signupError');
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim().toLowerCase();
  const password = document.getElementById('signupPassword').value;

  if (name.length < 2) { errEl.textContent = 'Informe seu nome.'; return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'E-mail inválido.'; return; }
  if (password.length < 8) { errEl.textContent = 'Senha deve ter pelo menos 8 caracteres.'; return; }

  errEl.textContent = 'Criando conta...';
  try {
    const r = await fetch('/api/auth?action=signup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password })
    });
    const json = await r.json();
    if (!r.ok || !json.ok) {
      errEl.textContent = json.error || 'Não foi possível criar a conta.';
      return;
    }
    if (json.requiresEmailConfirmation) {
      errEl.textContent = 'Verifique seu e-mail para ativar a conta.';
      return;
    }
    SITE.user = json.user;
    e.target.reset();
    closeModal('signupModal');
    await loadUser();
    updateAuthUI();
    renderDiscography();
    toast('Conta criada. Bem-vindo!', '✦');
  } catch (err) {
    console.error('[signup]', err);
    errEl.textContent = 'Serviço indisponível.';
  }
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────
function sanitizeRichText(html) {
  const raw = String(html || '');
  if (typeof DOMParser === 'undefined') return esc(raw);

  const doc = new DOMParser().parseFromString(`<div>${raw}</div>`, 'text/html');
  const container = doc.body.firstChild;

  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }

      const tag = child.tagName;
      const isBr = tag === 'BR';
      const isGoldSpan = tag === 'SPAN' && child.getAttribute('class') === 'gold';

      if (!isBr && !isGoldSpan) {
        child.replaceWith(doc.createTextNode(child.textContent || ''));
        continue;
      }

      for (const attr of Array.from(child.attributes)) {
        if (isGoldSpan && attr.name === 'class' && attr.value === 'gold') continue;
        child.removeAttribute(attr.name);
      }

      walk(child);
    }
  };

  walk(container);
  return container.innerHTML;
}

function getSocialIconHTML(network) {
  const k = String(network || '').toLowerCase().trim();

  if (k === 'audiomack') {
    return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="12" fill="currentColor"/>
      <path d="M6.185 13.703l6.518-3.719-6.518-3.72a.687.687 0 1 1 .703-1.174l6.518 3.719 6.518-3.719a.687.687 0 1 1 .703 1.174l-6.518 3.72 6.518 3.719a.687.687 0 1 1-.703 1.174l-6.518-3.72-6.518 3.72a.687.687 0 1 1-.703-1.174z" fill="#000"/>
    </svg>`;
  }

  const map = {
    spotify: 'fab fa-spotify',
    youtube: 'fab fa-youtube',
    amazon: 'fab fa-amazon',
    facebook: 'fab fa-facebook-f',
    tiktok: 'fab fa-tiktok',
    apple: 'fab fa-apple',
    itunes: 'fab fa-itunes',
    instagram: 'fab fa-instagram',
    twitter: 'fab fa-x-twitter',
    x: 'fab fa-x-twitter',
    deezer: 'fab fa-deezer',
    soundcloud: 'fab fa-soundcloud',
    bandcamp: 'fab fa-bandcamp',
    whatsapp: 'fab fa-whatsapp',
    telegram: 'fab fa-telegram',
    linkedin: 'fab fa-linkedin-in',
    threads: 'fab fa-threads',
    email: 'fas fa-envelope',
    website: 'fas fa-globe',
    link: 'fas fa-link'
  };

  const cls = map[k] || 'fas fa-link';
  return `<i class="${cls}" aria-hidden="true"></i>`;
}

function applyBackgroundImage(url) {
  const safe = safeMediaUrl(url);
  if (!safe) {
    document.body.style.backgroundImage = '';
    return;
  }
  document.body.style.backgroundImage =
    `linear-gradient(rgba(11,10,12,0.85), rgba(11,10,12,0.85)), url('${safe}')`;
  document.body.style.backgroundSize = 'cover';
  document.body.style.backgroundAttachment = 'fixed';
}

function applyImageSafe(el, url, cls, onFail) {
  if (!el) return;
  const safe = safeMediaUrl(url);
  if (!safe) {
    el.classList.remove(cls);
    el.style.backgroundImage = '';
    if (onFail) onFail();
    return;
  }
  el.classList.add(cls);
  el.style.backgroundImage = `url('${safe}')`;
}

function updateAuthUI() {
  const u = SITE.user;
  const chip = document.getElementById('userChip');
  const loginBtn = document.getElementById('loginBtn');
  const signupBtn = document.getElementById('signupBtn');

  if (u) {
    if (loginBtn) loginBtn.style.display = 'none';
    if (signupBtn) signupBtn.style.display = 'none';
    if (chip) chip.classList.add('visible');
    const avatar = document.getElementById('userAvatar');
    if (avatar) avatar.textContent = (u.name || u.email || '?').charAt(0).toUpperCase();
    const nameMini = document.getElementById('userNameMini');
    if (nameMini) nameMini.textContent = (u.name || u.email || '').split(' ')[0];
    const planMini = document.getElementById('userPlanMini');
    if (planMini) {
      planMini.textContent = u.plan === 'anual' ? 'Premium Anual'
        : u.plan === 'premium' ? 'Premium' : 'Free';
    }
  } else {
    if (loginBtn) loginBtn.style.display = '';
    if (signupBtn) signupBtn.style.display = '';
    if (chip) chip.classList.remove('visible');
  }
}

// ─────────────────────────────────────────────────────────────
// MODAL DE CONTA
// ─────────────────────────────────────────────────────────────
function openAccountModal() {
  const u = SITE.user;
  if (!u) { openModal('loginModal'); return; }

  const avatar = document.getElementById('accountAvatar');
  if (avatar) avatar.textContent = (u.name || u.email || '?').charAt(0).toUpperCase();

  const name = document.getElementById('accountName');
  if (name) name.textContent = u.name || 'Usuário';

  const email = document.getElementById('accountEmail');
  if (email) email.textContent = u.email || '';

  const planValue = document.getElementById('accountPlanValue');
  if (planValue) {
    planValue.textContent = u.plan === 'anual' ? 'Premium Anual'
      : u.plan === 'premium' ? 'Premium' : 'Free';
  }
  const planDesc = document.getElementById('accountPlanDesc');
  if (planDesc) {
    planDesc.textContent = u.plan === 'free'
      ? 'Acesso a prévias + loja de faixas.'
      : 'Acesso completo + downloads.';
  }

  const actions = document.getElementById('accountActions');
  if (actions) {
    const isFree = u.plan === 'free';

    if (isFree) {
      actions.innerHTML = `
        <button class="btn btn-primary btn-block" id="accountUpgradeBtn">
          Fazer upgrade para Premium
        </button>
      `;
      document.getElementById('accountUpgradeBtn')?.addEventListener('click', () => {
        closeModal('accountModal');
        openModal('plansModal');
      });
    } else {
      actions.innerHTML = `
        <button class="btn btn-primary btn-block" id="accountManageBtn">
          Gerenciar assinatura
        </button>
      `;
      document.getElementById('accountManageBtn')?.addEventListener('click', () => {
        closeModal('accountModal');
        openManageModal();
      });
    }
  }

  openModal('accountModal');
}

// ─────────────────────────────────────────────────────────────
// PLAYER
// ─────────────────────────────────────────────────────────────
function initPlayer() {
  audio = document.getElementById('audio');
  if (!audio) return;

  audio.volume = lastVolume;

  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('play', onPlay);
  audio.addEventListener('pause', onPause);
  audio.addEventListener('error', onError);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('loadedmetadata', syncProgress);
  audio.addEventListener('loadedmetadata', syncExpandedProgress);

  bindPlayerControls();
  bindMobileTabs();
  bindFullscreenBtn();
  updateMuteButtons();
}

function bindPlayerControls() {
  const bind = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

  bind('playBtn', togglePlay);
  bind('nextBtn', nextTrack);
  bind('prevBtn', prevTrack);
  bind('muteBtn', toggleMute);
  bind('lyricsBtn', () => document.getElementById('lyricsDrawer')?.classList.toggle('open'));

  bind('closeExpandedPlayer', closeExpandedPlayer);
  bind('expandedPlayBtn', togglePlay);
  bind('expandedNextBtn', nextTrack);
  bind('expandedPrevBtn', prevTrack);
  bind('expandedMuteBtn', toggleMute);
  bind('expandedShuffleBtn', toggleShuffle);
  bind('closeLyrics', () => document.getElementById('lyricsDrawer')?.classList.remove('open'));

  bindProgressBar('progressBar');
  bindProgressBar('expandedProgressBar');
  bindVolumeBar('volumeBar');
}

function bindMobileTabs() {
  const player = document.querySelector('#expandedPlayerModal .music-player');
  const tabs = document.querySelectorAll('#expandedPlayerModal .mobile-tab');
  if (!player || !tabs.length) return;

  tabs.forEach((tab) => {
    if (tab.dataset.bound === '1') return;
    tab.dataset.bound = '1';
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      const isLyrics = target === 'lyrics';
      tabs.forEach((t) => {
        const active = t.dataset.tab === target;
        t.classList.toggle('active', active);
        t.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      player.classList.toggle('mobile-lyrics', isLyrics);
    });
  });
}

function bindFullscreenBtn() {
  const btn = document.getElementById('expandedFullscreenBtn');
  const player = document.querySelector('#expandedPlayerModal .music-player');
  if (!btn || !player) return;
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const supportsFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  if (isIOS || !supportsFullscreen) { btn.style.display = 'none'; return; }

  const getFsElement = () => document.fullscreenElement || document.webkitFullscreenElement;
  const requestFs = (el) => {
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
  };
  const exitFs = () => {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
  };

  btn.addEventListener('click', async () => {
    try {
      if (getFsElement()) await exitFs();
      else await requestFs(player);
    } catch (err) {
      console.warn('[fullscreen]', err?.message);
    }
  });
}

function getAudioErrorMessage(audioElement) {
  const error = audioElement?.error;
  if (!error) return 'Erro desconhecido ao carregar o áudio.';

  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'O carregamento do áudio foi interrompido.';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'Erro de rede ao acessar o áudio.';
    case MediaError.MEDIA_ERR_DECODE:
      return 'O navegador não conseguiu decodificar o áudio.';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Formato de áudio não suportado ou arquivo indisponível.';
    default:
      return 'Erro ao carregar o áudio.';
  }
}

function waitForAudioReady(audioElement, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    if (!audioElement) {
      reject(new Error('Elemento de áudio não encontrado.'));
      return;
    }

    if (audioElement.readyState >= 3) {
      resolve();
      return;
    }

    let finished = false;

    const cleanup = () => {
      audioElement.removeEventListener('canplay', onReady);
      audioElement.removeEventListener('canplaythrough', onReady);
      audioElement.removeEventListener('error', onError);
      clearTimeout(timeoutId);
    };

    const onReady = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve();
    };

    const onError = () => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error(getAudioErrorMessage(audioElement)));
    };

    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error('Tempo limite ao carregar o áudio.'));
    }, timeoutMs);

    audioElement.addEventListener('canplay', onReady);
    audioElement.addEventListener('canplaythrough', onReady);
    audioElement.addEventListener('error', onError);
  });
}

function clearRenewTimer() {
  if (renewTimer) {
    clearTimeout(renewTimer);
    renewTimer = null;
  }
}

function scheduleRenewal() {
  clearRenewTimer();

  if (!currentStream || currentStream.source !== 'full') return;
  if (!currentStream.expiresIn || currentStream.expiresIn <= 0) return;

  const renewAfterMs = Math.floor(currentStream.expiresIn * 1000 * 0.8);

  renewTimer = setTimeout(() => {
    renewSignedUrl().catch((err) => {
      console.warn('[player] renovação preventiva falhou:', err?.message);
    });
  }, renewAfterMs);
}

async function renewSignedUrl() {
  if (isRenewing) return;
  if (!currentStream || currentStream.source !== 'full') return;

  isRenewing = true;

  const { albumId, trackIndex } = currentStream;
  const wasPlaying = audio && !audio.paused;
  const savedTime = audio?.currentTime || 0;
  const savedVolume = audio?.volume ?? lastVolume;

  try {
    const r = await fetch(
      `/api/stream?albumId=${encodeURIComponent(albumId)}&trackIndex=${encodeURIComponent(trackIndex)}`,
      { credentials: 'same-origin', cache: 'no-store' }
    );
    const json = await r.json();

    if (!r.ok || !json?.ok || !json.fullUrl) {
      throw new Error(json?.error || 'URL não renovada');
    }

    currentStream.url = json.fullUrl;
    currentStream.expiresIn = Number(json.expiresIn) || currentStream.expiresIn;
    currentStream.loadedAt = Date.now();

    audio.src = json.fullUrl;
    audio.volume = savedVolume;
    audio.load();

    const restore = () => {
      try {
        if (Number.isFinite(audio.duration) && savedTime < audio.duration) {
          audio.currentTime = savedTime;
        }
      } catch (err) {
        console.debug('[player] falha ao restaurar posição:', err);
      }
      if (wasPlaying) audio.play().catch(() => {});
    };

    audio.addEventListener('loadedmetadata', restore, { once: true });

    scheduleRenewal();

    console.log('[player] URL renovada');
  } catch (err) {
    console.warn('[player] renovação falhou:', err?.message);
  } finally {
    isRenewing = false;
  }
}

function buildQueueForAlbum(albumId, startIndex) {
  const album = findAlbum(albumId);
  if (!album) { playerQueue = []; playerQueueIndex = -1; return; }
  const albumTracks = Array.isArray(album.tracks) ? album.tracks : [];

  const realIndexes = albumTracks.map((t) => Number(t.trackIndex) || 0);

  let indices = realIndexes.slice();
  if (shuffleEnabled && indices.length > 1) {
    indices = shuffleArray(indices);
    const clickedPos = indices.indexOf(startIndex);
    if (clickedPos > 0) [indices[0], indices[clickedPos]] = [indices[clickedPos], indices[0]];
  }

  playerQueue = indices.map((i) => ({ albumId, trackIndex: i }));
  playerQueueIndex = playerQueue.findIndex(
    (q) => q.albumId === albumId && q.trackIndex === startIndex
  );

  const shuffleBtn = document.getElementById('expandedShuffleBtn');
  if (shuffleBtn) {
    shuffleBtn.hidden = albumTracks.length <= 1;
    shuffleBtn.classList.toggle('active', shuffleEnabled && albumTracks.length > 1);
  }
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toggleShuffle() {
  shuffleEnabled = !shuffleEnabled;
  const shuffleBtn = document.getElementById('expandedShuffleBtn');
  if (shuffleBtn) shuffleBtn.classList.toggle('active', shuffleEnabled);
  if (currentTrackIdentity) {
    buildQueueForAlbum(currentTrackIdentity.albumId, currentTrackIdentity.trackIndex);
    renderQueue();
  }
  toast(shuffleEnabled ? 'Aleatório ativado.' : 'Aleatório desativado.', '🔀');
}

function renderQueue() {
  const wrap = document.getElementById('expandedPlayerQueue');
  const list = document.getElementById('expandedQueueList');
  const count = document.getElementById('expandedQueueCount');
  if (!wrap || !list) return;

  if (playerQueue.length <= 1) {
    wrap.hidden = true;
    list.innerHTML = '';
    return;
  }

  wrap.hidden = false;
  if (count) count.textContent = `${playerQueue.length} faixas`;

  list.innerHTML = playerQueue
    .map((item, idx) => {
      const album = findAlbum(item.albumId);
      if (!album) return '';
      const track = findTrackByIndex(item.albumId, item.trackIndex);
      if (!track) return '';

      const isCurrent = idx === playerQueueIndex;
      const locked = isLocked(item.albumId, item.trackIndex);

      const coverStyle = album.coverImage
        ? `style="background-image:url('${esc(safeMediaUrl(album.coverImage))}')"`
        : '';
      const coverText = album.coverImage
        ? ''
        : esc(album.coverInitials || album.cover || '♪');

      return `
        <button class="queue-track ${isCurrent ? 'playing' : ''}"
                type="button"
                data-action="play-queue"
                data-queue-index="${idx}">
          <span class="queue-track-index">${isCurrent ? '▶' : idx + 1}</span>
          <span class="queue-track-cover" ${coverStyle}>${coverText}</span>
          <span class="queue-track-info">
            <span class="queue-track-title">${esc(track.title)}</span>
            <span class="queue-track-duration">${esc(track.duration || '—')}</span>
          </span>
          <span class="queue-track-lock">${locked ? '🔒' : '▶'}</span>
        </button>`;
    })
    .join('');
}

async function playFromDiscography(albumId, trackIndex, opts = {}) {
  const album = findAlbum(albumId);
  if (!album) return;

  const track = findTrackByIndex(albumId, trackIndex);
  if (!track) {
    console.warn('[player] faixa não encontrada:', albumId, trackIndex);
    return;
  }

  const realIndex = Number(track.trackIndex) || 0;

  if (!opts.fromQueue) {
    buildQueueForAlbum(albumId, realIndex);
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }
  currentAbortController = new AbortController();

  clearRenewTimer();
  isRenewing = false;

  currentTrackIdentity = {
    albumId,
    trackIndex: realIndex,
    trackTitle: track.title,
    identity: `${albumId}:${realIndex}`
  };

  const titleEl = document.getElementById('nowTitle');
  if (titleEl) titleEl.textContent = track.title;
  const artistEl = document.getElementById('nowArtist');
  if (artistEl) {
    artistEl.textContent = `Joseph Matthos · ${album.title}`;
  }
  syncExpandedPlayer(track, album, false);
  updatePlayingHighlight();

  let streamData;
  try {
    const r = await fetch(
      `/api/stream?albumId=${encodeURIComponent(albumId)}&trackIndex=${encodeURIComponent(realIndex)}`,
      {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: currentAbortController.signal
      }
    );

    let json = null;
    try { json = await r.json(); } catch { json = null; }

    if (!r.ok || !json?.ok) {
      throw new Error(json?.error || `Falha ao obter áudio (${r.status})`);
    }

    streamData = json;
  } catch (err) {
    if (err?.name === 'AbortError') return;

    console.error('[player] erro ao obter stream:', err);
    toast(err?.message || 'Não foi possível carregar a música.', '⚠');
    return;
  }

  const unlocked = Boolean(streamData.unlocked);
  const source = streamData.source || (unlocked ? 'full' : 'preview');
  const src = source === 'full' ? streamData.fullUrl : streamData.previewUrl;

  if (!src) {
    console.error('[player] nenhuma URL de áudio:', streamData);
    toast(
      streamData.warning ||
        (unlocked
          ? 'O áudio completo não está disponível.'
          : 'Esta música não possui uma prévia cadastrada.'),
      '⚠'
    );
    return;
  }

  if (source === 'full') {
    previewState = { active: false, start: 0, end: Infinity };
  } else {
    const start = Math.max(0, Number(streamData.previewStart) || 0);
    const duration = Math.max(1, Number(streamData.previewDuration) || 30);
    previewState = { active: true, start, end: start + duration };
  }

  previewNoticeTrackKey = '';

  currentStream = {
    albumId,
    trackIndex: realIndex,
    unlocked,
    source,
    url: src,
    expiresIn: Number(streamData.expiresIn) || null,
    loadedAt: Date.now()
  };

  audio.pause();
  audio.removeAttribute('src');
  audio.preload = 'auto';
  audio.load();
  audio.src = src;

  if (source === 'preview' && previewState.start > 0) {
    const setPreviewStart = () => {
      try {
        if (Number.isFinite(audio.duration) && audio.duration > previewState.start) {
          audio.currentTime = previewState.start;
        }
      } catch (err) {
        console.debug('[player] não foi possível posicionar prévia:', err);
      }
    };
    audio.addEventListener('loadedmetadata', setPreviewStart, { once: true });
  }

  audio.load();

  const artistEl2 = document.getElementById('nowArtist');
  if (artistEl2) {
    artistEl2.textContent =
      `Joseph Matthos · ${album.title}` +
      (source === 'preview' ? ' (prévia)' : '');
  }

  const cover = document.getElementById('playerCover');
  if (cover) {
    const safeCover = safeMediaUrl(album.coverImage);
    if (safeCover) {
      cover.classList.add('has-cover');
      cover.style.backgroundImage = `url('${safeCover}')`;
    } else {
      cover.classList.remove('has-cover');
      cover.style.backgroundImage = '';
    }
  }

  document.getElementById('previewBadge')?.classList.toggle('visible', source === 'preview');
  document.getElementById('expandedPreviewBadge')?.classList.toggle('visible', source === 'preview');

  renderLyrics(track);
  syncExpandedPlayer(track, album, unlocked);
  renderExpandedPlayerActions(albumId, realIndex);
  renderQueue();
  updatePlayingHighlight();

  try {
    await waitForAudioReady(audio);
    await audio.play();

    if (source === 'full') scheduleRenewal();
  } catch (err) {
    console.error('[player] falha na reprodução:', err);

    const code = audio?.error?.code;
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
      toast('O formato deste áudio não é suportado pelo navegador.', '⚠');
    } else if (code === MediaError.MEDIA_ERR_NETWORK) {
      toast('Não foi possível acessar o arquivo de áudio.', '⚠');
    } else {
      console.debug('[player] reprodução não iniciada:', err?.message);
    }
  }
}

function togglePlay() {
  if (!audio || !audio.src) return;
  if (audio.paused) {
    if (previewState.active && audio.currentTime >= previewState.end - 0.5) {
      audio.currentTime = previewState.start;
    }
    audio.play().catch(() => {});
  } else {
    audio.pause();
  }
}

function nextTrack() {
  if (!playerQueue.length || playerQueueIndex < 0) return;
  if (playerQueueIndex + 1 >= playerQueue.length) { audio.pause(); return; }
  playerQueueIndex++;
  const item = playerQueue[playerQueueIndex];
  playFromDiscography(item.albumId, item.trackIndex, { fromQueue: true });
}

function prevTrack() {
  if (!audio || !playerQueue.length || playerQueueIndex < 0) return;
  if (audio.currentTime > 3 && !previewState.active) { audio.currentTime = 0; return; }
  if (playerQueueIndex - 1 < 0) return;
  playerQueueIndex--;
  const item = playerQueue[playerQueueIndex];
  playFromDiscography(item.albumId, item.trackIndex, { fromQueue: true });
}

function onEnded() { nextTrack(); }

function toggleMute() {
  if (!audio) return;
  if (muted) { audio.volume = lastVolume || 0.8; muted = false; }
  else { lastVolume = audio.volume; audio.volume = 0; muted = true; }
  updateMuteButtons();
  updateVolumeFill();
}

function updateMuteButtons() {
  const icon = muted || audio?.volume === 0 ? '🔇' : audio?.volume < 0.5 ? '🔉' : '🔊';
  const btn = document.getElementById('muteBtn');
  if (btn) btn.textContent = icon;

  const expBtn = document.getElementById('expandedMuteBtn');
  if (expBtn) {
    const svg = expBtn.querySelector('svg');
    if (svg) {
      const isMuted = muted || audio?.volume === 0;
      svg.innerHTML = isMuted
        ? '<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>'
        : '<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>';
    }
  }
}

function updateVolumeFill() {
  const fill = document.getElementById('volumeFill');
  if (fill && audio) fill.style.width = audio.volume * 100 + '%';
  const bar = document.getElementById('volumeBar');
  if (bar && audio) bar.setAttribute('aria-valuenow', Math.round(audio.volume * 100));
}

function bindProgressBar(id) {
  const bar = document.getElementById(id);
  if (!bar) return;

  const seek = (clientX) => {
    if (!audio || !audio.duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (previewState.active) {
      audio.currentTime = previewState.start + pct * (previewState.end - previewState.start);
    } else {
      audio.currentTime = pct * audio.duration;
    }
    syncProgress();
    syncExpandedProgress();
  };

  bar.addEventListener('click', (e) => seek(e.clientX));
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); seekBy(5); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seekBy(-5); }
  });
}

function seekBy(seconds) {
  if (!audio || !audio.duration) return;
  let t = audio.currentTime + seconds;
  if (previewState.active) {
    t = Math.min(t, previewState.end - 0.1);
    t = Math.max(t, previewState.start);
  } else {
    t = Math.min(Math.max(t, 0), audio.duration);
  }
  audio.currentTime = t;
  syncProgress();
  syncExpandedProgress();
}

function bindVolumeBar(id) {
  const bar = document.getElementById(id);
  if (!bar) return;
  bar.addEventListener('click', (e) => {
    if (!audio) return;
    const rect = bar.getBoundingClientRect();
    const v = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.volume = v;
    lastVolume = v;
    muted = v === 0;
    updateVolumeFill();
    updateMuteButtons();
  });
}

function onTimeUpdate() {
  if (!audio || isSeeking) return;

  if (previewState.active && audio.currentTime >= previewState.end) {
    audio.pause();
    audio.currentTime = previewState.end;
    const key = currentTrackIdentity ? currentTrackIdentity.identity : '';
    if (previewNoticeTrackKey !== key) {
      toast('Prévia encerrada. Alugue ou assine para ouvir completa.', '🎧');
      previewNoticeTrackKey = key;
    }
  }

  syncProgress();
  syncExpandedProgress();
  updateLyricsPosition();
}

function syncProgress() {
  const fill = document.getElementById('progressFill');
  const currentTimeEl = document.getElementById('currentTime');
  const durationEl = document.getElementById('duration');
  const bar = document.getElementById('progressBar');

  const total = previewState.active ? previewState.end - previewState.start : audio?.duration;
  const current = previewState.active
    ? Math.max(0, (audio?.currentTime || 0) - previewState.start)
    : audio?.currentTime || 0;
  const pct = Number.isFinite(total) && total > 0 ? Math.min(100, (current / total) * 100) : 0;

  if (fill) fill.style.width = pct + '%';
  if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
  if (durationEl) durationEl.textContent = formatTime(total);
  if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
}

function syncExpandedProgress() {
  const fill = document.getElementById('expandedProgressFill');
  const currentTimeEl = document.getElementById('expandedCurrentTime');
  const durationEl = document.getElementById('expandedDuration');
  const bar = document.getElementById('expandedProgressBar');

  const total = previewState.active ? previewState.end - previewState.start : audio?.duration;
  const current = previewState.active
    ? Math.max(0, (audio?.currentTime || 0) - previewState.start)
    : audio?.currentTime || 0;
  const pct = Number.isFinite(total) && total > 0 ? Math.min(100, (current / total) * 100) : 0;

  if (fill) fill.style.width = pct + '%';
  if (currentTimeEl) currentTimeEl.textContent = formatTime(current);
  if (durationEl) durationEl.textContent = formatTime(total);
  if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
}

function updateLyricsPosition() {
  const containers = [
    document.getElementById('lyricsContent'),
    document.getElementById('expandedLyricsContent')
  ];

  for (const container of containers) {
    if (!container) continue;
    const lines = container.querySelectorAll('.lyric-line');
    if (!lines.length) continue;

    let active = -1;
    const t = audio?.currentTime || 0;

    lines.forEach((line, index) => {
      if (Number(line.dataset.lyricTime) <= t) active = index;
    });

    lines.forEach((line, index) => line.classList.toggle('active', index === active));

    if (active >= 0 && lines[active].scrollIntoView) {
      lines[active].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function onPlay() {
  const btn = document.getElementById('playBtn');
  if (btn) btn.textContent = '⏸';
  const cover = document.getElementById('playerCover');
  if (cover) cover.classList.add('spinning');

  const expandedBtn = document.getElementById('expandedPlayBtn');
  const expandedIcon = document.getElementById('expandedPlayIcon');
  if (expandedBtn) expandedBtn.classList.add('playing');
  if (expandedIcon) expandedIcon.innerHTML = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';

  updateMuteButtons();
}

function onPause() {
  const btn = document.getElementById('playBtn');
  if (btn) btn.textContent = '▶';
  const cover = document.getElementById('playerCover');
  if (cover) cover.classList.remove('spinning');

  const expandedBtn = document.getElementById('expandedPlayBtn');
  const expandedIcon = document.getElementById('expandedPlayIcon');
  if (expandedBtn) expandedBtn.classList.remove('playing');
  if (expandedIcon) expandedIcon.innerHTML = '<path d="M8 5v14l11-7z"/>';
}

async function onError(e) {
  if (!audio || !audio.error) return;

  const code = audio.error.code;
  if (code === MediaError.MEDIA_ERR_ABORTED) return;

  const message = getAudioErrorMessage(audio);

  console.error('[player] erro de áudio:', {
    code,
    message,
    src: audio.currentSrc || audio.src,
    identity: currentTrackIdentity,
    stream: currentStream
  });

  if (
    currentStream &&
    currentStream.source === 'full' &&
    (code === MediaError.MEDIA_ERR_NETWORK ||
     code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED)
  ) {
    console.warn('[player] tentando renovar URL assinada...');
    try {
      await renewSignedUrl();
      return;
    } catch (err) {
      console.warn('[player] renovação falhou:', err?.message);
    }
  }

  onPause();

  switch (code) {
    case MediaError.MEDIA_ERR_NETWORK:
      toast('Não foi possível acessar o arquivo de música.', '⚠');
      break;
    case MediaError.MEDIA_ERR_DECODE:
      toast('O arquivo de música não pôde ser decodificado.', '⚠');
      break;
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      toast('Formato de áudio não suportado ou arquivo inexistente.', '⚠');
      break;
    default:
      toast('Erro ao carregar áudio.', '⚠');
  }
}

function updatePlayingHighlight() {
  const current = currentTrackIdentity?.identity;
  document.querySelectorAll('.discography-track-card').forEach((card) => {
    const isPlaying = current && current === card.dataset.identity;
    card.classList.toggle('playing', !!isPlaying);
  });
}

function openExpandedPlayer(albumId, trackIndex) {
  const modal = document.getElementById('expandedPlayerModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  const player = modal.querySelector('.music-player');
  const musicTab = modal.querySelector('.mobile-tab[data-tab="music"]');
  if (player && musicTab) {
    player.classList.remove('mobile-lyrics');
    modal.querySelectorAll('.mobile-tab').forEach((t) => {
      const isMusic = t.dataset.tab === 'music';
      t.classList.toggle('active', isMusic);
      t.setAttribute('aria-selected', isMusic ? 'true' : 'false');
    });
  }

  playFromDiscography(albumId, trackIndex);
}

function closeExpandedPlayer() {
  const modal = document.getElementById('expandedPlayerModal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';

  playerQueue = [];
  playerQueueIndex = -1;

  clearRenewTimer();

  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}

function renderExpandedPlayerActions(albumId, trackIndex) {
  const wrap = document.getElementById('expandedPlayerActions');
  if (!wrap) return;

  const album = findAlbum(albumId);
  const track = findTrackByIndex(albumId, trackIndex);
  if (!track) { wrap.innerHTML = ''; return; }

  if (isPremium()) {
    wrap.innerHTML = '<span class="expanded-access">✓ Premium: acesso completo</span>';
    return;
  }
  if (isRented(albumId, trackIndex)) {
    wrap.innerHTML = '<span class="expanded-access">✓ Você alugou esta faixa</span>';
    return;
  }

  wrap.innerHTML = `
    <button class="btn btn-primary btn-sm" type="button" id="expandedRentBtn">Alugar</button>
    <button class="btn btn-ghost btn-sm" type="button" id="expandedPlansBtn">Assinar Premium</button>`;

  document.getElementById('expandedRentBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openRentModal(albumId, trackIndex);
  });

  document.getElementById('expandedPlansBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openModal('plansModal');
  });
}

function syncExpandedPlayer(track, album, unlocked) {
  const title = document.getElementById('expandedPlayerTitle');
  const albumEl = document.getElementById('expandedPlayerAlbum');
  const cover = document.getElementById('expandedPlayerCover');
  const badge = document.getElementById('expandedPreviewBadge');

  if (title) title.textContent = track.title;
  if (albumEl) albumEl.textContent = `Joseph Matthos · ${album.title}`;

  if (cover) {
    const safeCover = safeMediaUrl(album.coverImage);
    cover.style.backgroundImage = '';
    cover.innerHTML = '';

    if (safeCover) {
      const img = document.createElement('img');
      img.src = safeCover;
      img.alt = album.title || 'Capa do álbum';
      img.loading = 'eager';
      cover.appendChild(img);
    } else {
      cover.textContent = album.coverInitials || album.cover || '♪';
    }
  }
  if (badge) badge.classList.toggle('visible', !unlocked);
}

function renderLyrics(track) {
  const html = (() => {
    const lyrics = Array.isArray(track?.lyrics) ? track.lyrics : [];
    if (!lyrics.length) return '<p class="lyrics-empty">Sem letra sincronizada.</p>';
    return lyrics
      .map(
        (line, i) =>
          `<button class="lyric-line" data-lyric-index="${i}" data-lyric-time="${
            Number(line.time) || 0
          }">${esc(line.text)}</button>`
      )
      .join('');
  })();

  const main = document.getElementById('lyricsContent');
  if (main) main.innerHTML = html;
  const expanded = document.getElementById('expandedLyricsContent');
  if (expanded) expanded.innerHTML = html;
  const title = document.getElementById('lyricsTitle');
  if (title) title.textContent = track?.title || 'Nenhuma faixa tocando';
}

function openPlaylistPlayer(playlistIndex) {
  const playlist = SITE.content?.playlists?.[playlistIndex];
  if (!playlist) return;

  const queue = resolvePlaylistTracks(playlist);
  if (!queue.length) {
    toast('Esta playlist não tem faixas válidas.', '⚠');
    return;
  }

  const first = queue[0];
  openExpandedPlayer(first.album.id, first.trackIndex);
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.zIndex = '800';
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

window.__site = {
  get state() { return { ...SITE }; },
  get rentalPlans() { return SITE.rentalPlans.slice(); },
  get currentStream() { return currentStream ? { ...currentStream } : null; },
  async reload() {
    await loadUser();
    applyContentToSite();
    renderDiscography();
  },
  openManageModal
};
