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
  10. NOVO: Rádio Joseph Matthos (exclusiva para assinantes)
  11. NOVO: Rádio com capa do álbum + botões Pausar/Próxima
  12. NOVO: Ícones de redes sociais em SVG inline (sem Font Awesome)
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

import {
  initRadio,
  openRadioModal,
  onRadioTrackEnded,
  syncRadioOnTrackChange,
  isRadioActive,
  resetRadio
} from './radio.js';

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

    // ── Inicializa a rádio (injeta dependências) — por último
    try {
      initRadio({
        isPremium,
        findAlbum,
        findTrackByIndex,
        playFromDiscography,
        shuffleArray,
        collectAllTracks,
        openModal,
        closeModal,
        esc,
        safeMediaUrl,
        setQueue: (queue) => {
          playerQueue = queue.map((t) => ({
            albumId: t.albumId,
            trackIndex: t.trackIndex
          }));
          playerQueueIndex = 0;
        },
        getQueue: () => playerQueue.slice(),
        getQueueIndex: () => playerQueueIndex,
        setQueueIndex: (idx) => {
          if (Number.isInteger(idx) && idx >= 0 && idx < playerQueue.length) {
            playerQueueIndex = idx;
          }
        }
      });
    } catch (err) {
      console.error('[radio] initRadio falhou:', err);
    }

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

      try {
        initRadio({
          isPremium,
          findAlbum,
          findTrackByIndex,
          playFromDiscography,
          shuffleArray,
          collectAllTracks,
          openModal,
          closeModal,
          esc,
          safeMediaUrl,
          setQueue: (queue) => {
            playerQueue = queue.map((t) => ({
              albumId: t.albumId,
              trackIndex: t.trackIndex
            }));
            playerQueueIndex = 0;
          },
          getQueue: () => playerQueue.slice(),
          getQueueIndex: () => playerQueueIndex,
          setQueueIndex: (idx) => {
            if (Number.isInteger(idx) && idx >= 0 && idx < playerQueue.length) {
              playerQueueIndex = idx;
            }
          }
        });
      } catch (err) {
        console.error('[radio] initRadio falhou (fallback):', err);
      }
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

function collectAllTracks() {
  const out = [];
  for (const album of SITE.albums || []) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    for (const track of tracks) {
      const idx = Number(track.trackIndex);
      if (!Number.isInteger(idx) || idx < 0) continue;
      out.push({
        albumId: album.id,
        trackIndex: idx,
        title: track.title || '—',
        albumTitle: album.title || ''
      });
    }
  }
  return out;
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
    const socials = Array.isArray(c.contato?.socials) ? c.contato.socials : [];

    if (!socials.length) {
      socialLinks.innerHTML = '';
    } else {
      socialLinks.innerHTML = socials
        .map((s) => {
          if (!s || typeof s !== 'object') return '';

          const network = normalizeNetwork(
            s.network || s.icon || s.type || s.name || 'link'
          );

          const label =
            s.label ||
            s.name ||
            SOCIAL_LABELS[network] ||
            SOCIAL_LABELS[s.network] ||
            network;

          const url = safeExternalUrl(s.url || s.link || s.href || '#');

          if (!url || url === '#') return '';

          return `
            <a href="${esc(url)}"
               target="_blank" rel="noopener noreferrer"
               class="ad-social-icon ${esc(network)}"
               data-label="${esc(label)}"
               aria-label="${esc(label)}">${getSocialIconHTML(network)}</a>`;
        })
        .filter(Boolean)
        .join('');
    }
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

      if (isCurrent && isManageView) {
        ctaText = 'Gerenciar assinatura';
        disabled = false;
        dataAttrs = 'data-manage="true"';
      } else if (isCurrent) {
        ctaText = 'Plano atual';
        disabled = true;
        dataAttrs = '';
      } else if (isManageView) {
        ctaText = 'Mudar para este plano';
        disabled = false;
        dataAttrs = `data-plan="${esc(p.id)}"`;
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

  if (SITE.user.plan === planId) {
    closeModal('plansModal');
    openManageModal();
    return;
  }

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

  // ── RÁDIO — botão no header
  document.getElementById('navRadioLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    openRadioModal();
  });

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
    resetRadio();
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

/**
 * Normaliza o nome da rede social para uma chave canônica.
 * Aceita variações como:
 *   "Spotify", "spotify ", "fa-spotify", "icon-spotify",
 *   "twitter", "x-twitter", "itunes", "apple-music", etc.
 */
function normalizeNetwork(network) {
  let k = String(network ?? '')
    .toLowerCase()
    .trim()
    .replace(/^fa[bsr]?-/, '')
    .replace(/^icon-/, '')
    .replace(/\s+/g, '');

  const aliases = {
    'twitter': 'x',
    'x-twitter': 'x',
    'itunes': 'apple',
    'apple-music': 'apple',
    'music-apple': 'apple',
    'amazon-music': 'amazon',
    'fb': 'facebook',
    'insta': 'instagram',
    'ig': 'instagram',
    'yt': 'youtube',
    'whats': 'whatsapp',
    'whatsapp-business': 'whatsapp',
    'tg': 'telegram'
  };

  if (aliases[k]) k = aliases[k];
  return k;
}

/**
 * Retorna o SVG inline do ícone da rede.
 * NÃO depende do Font Awesome — sempre renderiza.
 */
function getSocialIconHTML(network) {
  const k = normalizeNetwork(network);

  const icons = {
    spotify: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/></svg>`,

    youtube: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,

    amazon: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M.045 18.02c.072-.116.187-.124.348-.022 3.636 2.11 7.594 3.166 11.87 3.166 2.852 0 5.668-.533 8.447-1.595l.315-.101c.178-.051.377.021.377.234 0 .115-.104.199-.208.256-2.68 1.586-5.688 2.38-9.024 2.38-3.801 0-7.173-1.16-10.115-3.482-.148-.115-.16-.26-.01-.836zM6.582 9.53c0-1.141.286-2.093.86-2.854.574-.762 1.32-1.142 2.239-1.142.732 0 1.36.229 1.882.687.522.458.877 1.086 1.066 1.884h.045c.234-.798.6-1.426 1.098-1.884.499-.458 1.127-.687 1.884-.687.92 0 1.667.38 2.24 1.142.574.761.86 1.713.86 2.854 0 1.172-.297 2.14-.892 2.904-.595.765-1.36 1.147-2.295 1.147-.757 0-1.388-.232-1.894-.696-.505-.464-.86-1.114-1.065-1.951h-.046c-.219.843-.574 1.494-1.065 1.951-.49.464-1.122.696-1.893.696-.936 0-1.7-.382-2.295-1.147-.596-.765-.893-1.732-.893-2.904z"/></svg>`,

    facebook: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,

    tiktok: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`,

    apple: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z"/></svg>`,

    instagram: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/></svg>`,

    x: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,

    deezer: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38H6.27zm6.54 0v3.027h5.189V8.38h-5.189zM0 12.634v3.027h5.189v-3.027H0zm6.27 0v3.027h5.189v-3.027H6.27zm6.54 0v3.027h5.189v-3.027h-5.189zm6 0v3.027H24v-3.027h-5.19zM0 16.927v3.026h5.189v-3.026H0zm6.27 0v3.026h5.189v-3.026H6.27zm6.54 0v3.026h5.189v-3.026h-5.189z"/></svg>`,

    soundcloud: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M1.175 12.225c-.051 0-.094.046-.101.1l-.233 2.154.233 2.105c.007.058.05.098.101.098.05 0 .09-.04.099-.098l.255-2.105-.27-2.154c0-.057-.045-.1-.09-.1m-.899.828c-.06 0-.091.037-.104.094L0 14.479l.165 1.308c0 .055.045.094.09.094s.089-.045.104-.104l.21-1.319-.21-1.334c0-.061-.044-.09-.09-.09m1.83-1.229c-.061 0-.12.045-.12.104l-.21 2.563.225 2.458c0 .06.045.12.119.12.061 0 .105-.061.121-.12l.254-2.474-.254-2.548c-.016-.06-.061-.12-.121-.12m.945-.089c-.075 0-.135.06-.15.135l-.193 2.64.21 2.544c.016.077.075.138.149.138.075 0 .135-.061.15-.15l.24-2.532-.24-2.623c0-.075-.06-.135-.135-.135l-.031-.017zm1.155.36c-.005-.09-.075-.149-.159-.149-.09 0-.158.06-.164.149l-.217 2.43.2 2.563c0 .09.075.157.159.157.074 0 .148-.068.148-.158l.227-2.563-.227-2.444.033.015zm.809-1.709c-.101 0-.18.09-.18.181l-.21 3.957.187 2.563c0 .09.08.164.18.164.094 0 .174-.09.18-.18l.209-2.563-.209-3.972c-.008-.104-.088-.18-.18-.18m.959-.914c-.105 0-.195.09-.203.194l-.18 4.872.165 2.548c0 .12.09.209.195.209.104 0 .194-.089.21-.209l.193-2.548-.192-4.856c-.016-.12-.105-.21-.21-.21m.989-.449c-.121 0-.211.089-.225.209l-.165 5.275.165 2.52c.014.119.104.225.225.225.119 0 .225-.105.225-.225l.195-2.52-.196-5.275c0-.12-.105-.225-.225-.225m1.245.045c0-.135-.105-.24-.24-.24-.119 0-.24.105-.24.24l-.149 5.441.149 2.503c.016.135.121.24.256.24s.24-.105.24-.24l.164-2.503-.164-5.456-.016.015zm.749-.134c-.135 0-.255.119-.255.254l-.15 5.322.15 2.473c0 .15.12.255.255.255s.255-.12.255-.27l.15-2.474-.165-5.307c0-.148-.12-.253-.24-.253"/></svg>`,

    bandcamp: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M0 18.75l7.437-13.5H24l-7.438 13.5H0z"/></svg>`,

    whatsapp: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z"/></svg>`,

    telegram: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>`,

    linkedin: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,

    threads: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>`,

    email: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/></svg>`,

    website: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2 0 .68.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 0 1 5.08 16zm2.95-8H5.08a7.987 7.987 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2 0-.68.07-1.35.16-2h4.68c.09.65.16 1.32.16 2 0 .68-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2 0-.68-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z"/></svg>`,

    link: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`
  };

  return icons[k] || icons.link;
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

  // ── Sincroniza modal da rádio se estiver aberto
  syncRadioOnTrackChange(albumId, realIndex);

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

function onEnded() {
  // ── Rádio: loop infinito
  if (isRadioActive() && onRadioTrackEnded()) return;

  // ── Player normal
  nextTrack();
}

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

  const playerEl = document.querySelector('#expandedPlayerModal .music-player');
  if (playerEl) {
    const safeCover = safeMediaUrl(album.coverImage);

    if (safeCover) {
      playerEl.style.setProperty('--player-bg', `url('${safeCover}')`);
      playerEl.setAttribute('data-has-bg', '1');
    } else {
      playerEl.style.removeProperty('--player-bg');
      playerEl.removeAttribute('data-has-bg');
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
