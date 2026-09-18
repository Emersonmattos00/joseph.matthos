/* ============================================================
   SITE.JS — Joseph Matthos
   ------------------------------------------------------------
   - Conteúdo, faixas e planos vêm de /api/public (1 request)
   - Usuário + aluguéis vêm de /api/auth?action=me
   - Login/signup/logout via /api/auth?action=*
   - Compra de faixa via /api/payments?type=rental → MP checkout
   - Assinatura via /api/payments?type=subscription → MP checkout
   - Nenhum localStorage para dados de negócio
   - Sem onclick inline; tudo via data-action + delegação
   - ?admin dispara evento 'jm:admin-open' para o painel
   ============================================================ */

import { DEFAULT_CONTENT, SOCIAL_LABELS } from './config.js';

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
// ESTADO GLOBAL — declarado no TOPO para evitar TDZ
// ─────────────────────────────────────────────────────────────
export const SITE = {
  content: null,
  tracks: {},
  plans: {},
  user: null,
  rentals: [],
  viewMode: 'cards',
  filter: 'all',
  expandedAlbumId: null,
  shopSearch: ''
};

// Estado do player — movido para cá (era declarado no fim do arquivo)
let audio = null;
let currentTrackIdentity = null;
let previewState = { active: false, start: 0, end: Infinity };
let previewNoticeTrackKey = '';
let isSeeking = false;
let lastVolume = 0.8;
let muted = false;

// ─────────────────────────────────────────────────────────────
// GATILHO ?admin — apenas dispara evento; o painel decide o que fazer
// ─────────────────────────────────────────────────────────────
function maybeOpenAdmin() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('admin')) return;

  // Notifica o admin/index.js (que tem sua própria lógica de auth)
  document.dispatchEvent(new CustomEvent('jm:admin-open'));

  // Limpa o parâmetro da URL sem quebrar o histórico
  // (o admin já foi notificado via evento, então pode limpar)
  if (window.history.replaceState) {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.hash
    );
  }
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
async function boot() {
  try {
    await Promise.allSettled([
      loadPublicData(),
      loadUser()
    ]);

    if (!SITE.content) SITE.content = clone(DEFAULT_CONTENT);

    initPlayer();
    applyContentToSite();
    renderDiscography();
    renderPlaylists();
    updateAuthUI();
    updateCartBadge();
    bindGlobalEvents();

    // Só agora trata o ?admin, com DOM pronto e painel carregado
    maybeOpenAdmin();

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
      updateCartBadge();
      bindGlobalEvents();
      maybeOpenAdmin();
    } catch (inner) {
      console.error('❌ Fallback também falhou:', inner);
    }
  }
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
      SITE.tracks = {};
      SITE.plans = {};
      return;
    }

    SITE.content =
      json.content && typeof json.content === 'object'
        ? json.content
        : clone(DEFAULT_CONTENT);

    SITE.tracks = {};
    if (Array.isArray(json.tracks)) {
      for (const t of json.tracks) {
        if (!t || !t.albumId) continue;
        SITE.tracks[`${t.albumId}:${t.trackIndex}`] = t;
      }
    }

    SITE.plans = {};
    if (Array.isArray(json.plans)) {
      for (const p of json.plans) {
        if (p && p.id) SITE.plans[p.id] = p;
      }
    }
  } catch (err) {
    console.warn('[public] falha, usando DEFAULT_CONTENT:', err?.message);
    SITE.content = clone(DEFAULT_CONTENT);
    SITE.tracks = {};
    SITE.plans = {};
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
  return (
    SITE.user &&
    (SITE.user.plan === 'premium' || SITE.user.plan === 'anual')
  );
}

function trackInfo(albumId, trackIndex) {
  return SITE.tracks[`${albumId}:${trackIndex}`] || null;
}

function trackPriceCents(albumId, trackIndex) {
  const info = trackInfo(albumId, trackIndex);
  return info && Number.isFinite(info.priceCents) ? info.priceCents : 0;
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

// ─────────────────────────────────────────────────────────────
// APLICA CONTEÚDO NO DOM
// ─────────────────────────────────────────────────────────────
function applyContentToSite() {
  const c = SITE.content;
  if (!c) return;

  // Branding
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

  // Aparência
  const a = c.aparencia || {};
  const root = document.documentElement.style;
  if (a.bg) root.setProperty('--bg', a.bg);
  if (a.accent) root.setProperty('--accent', a.accent);
  if (a.text) root.setProperty('--text', a.text);
  if (a.accentDark) root.setProperty('--accent-dark', a.accentDark);
  if (a.border) root.setProperty('--border', a.border);
  if (a.fontSerif) root.setProperty('--font-serif', a.fontSerif);
  if (a.fontSans) root.setProperty('--font-sans', a.fontSans);

  applyBackgroundImage(c.branding?.bgImage);

  // Hero
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

  // Sobre
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
      (c.sobre?.quote
        ? `<div class="quote">${esc(c.sobre.quote)}</div>`
        : '');
  }

  // Filosofia
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

  // Discografia — títulos
  const discoTitle = document.getElementById('discoTitle');
  if (discoTitle) discoTitle.innerHTML = sanitizeRichText(c.discografia?.title);
  const discoSub = document.getElementById('discoSub');
  if (discoSub) discoSub.textContent = c.discografia?.subtitle || '';

  // Planos
  const plansTitle = document.getElementById('plansModalTitle');
  if (plansTitle) plansTitle.innerHTML = sanitizeRichText(c.planos?.title);
  const plansSub = document.getElementById('plansModalSub');
  if (plansSub) plansSub.textContent = c.planos?.subtitle || '';

  renderPlans();

  // Contato
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
// PLANOS
// ─────────────────────────────────────────────────────────────
function renderPlans() {
  const grid = document.getElementById('plansGrid');
  if (!grid) return;

  const plans = SITE.content?.planos?.plans || [];
  grid.innerHTML = plans
    .map((p) => {
      const priceInfo = SITE.plans[p.id] || {};
      const cents = priceInfo.priceCents || 0;
      const interval = priceInfo.interval;

      const priceText = cents > 0 ? formatPrice(cents / 100) : 'R$ 0';
      const suffixText =
        interval === 'month' ? '/mês' : interval === 'year' ? '/ano' : '';

      return `
        <div class="plan-card ${p.featured ? 'featured' : ''}">
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
                  ${p.disabled ? 'disabled style="opacity:0.6;cursor:default;"' : `data-plan="${esc(p.id)}"`}>
            ${esc(p.cta)}
          </button>
        </div>`;
    })
    .join('');

  grid.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => subscribe(btn.dataset.plan));
  });
}

// ─────────────────────────────────────────────────────────────
// DISCOGRAFIA
// ─────────────────────────────────────────────────────────────
function renderDiscography() {
  const container = document.getElementById('discographyContainer');
  if (!container) return;

  const albums = SITE.content?.discografia?.albums || [];
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
      const tracks = album.tracks
        .map((track, trackIndex) => ({ track, trackIndex }))
        .filter(
          ({ track }) =>
            !q ||
            track.title.toLowerCase().includes(q) ||
            album.title.toLowerCase().includes(q)
        );

      if (!tracks.length && q) return '';

      const isExpanded = q ? true : SITE.expandedAlbumId === album.id;

      return `
        <div class="album-block ${isExpanded ? 'expanded' : ''}" data-album="${esc(album.id)}">
          <div class="album-header" data-action="toggle-album" data-album="${esc(album.id)}">
            <div class="album-cover" ${
              album.coverImage
                ? `style="background-image:url('${esc(safeMediaUrl(album.coverImage))}')"`
                : ''
            }>
              ${album.coverImage ? '' : esc(album.cover || '♪')}
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
                · ${tracks.length} faixa${tracks.length === 1 ? '' : 's'}
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
                tracks.length
                  ? tracks
                      .map(({ track, trackIndex }) =>
                        renderTrackCard(album, track, trackIndex)
                      )
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
  updatePlayingHighlight();
}

function renderTrackCard(album, track, trackIndex) {
  const info = trackInfo(album.id, trackIndex);
  const priceCents = trackPriceCents(album.id, trackIndex);
  const hasPriceInfo = !!info && priceCents > 0;
  const forSale = info ? info.forSale !== false && hasPriceInfo : false;
  const premium = isPremium();
  const rented = isRented(album.id, trackIndex);
  const locked = isLocked(album.id, trackIndex);

  const identity = `${album.id}:${trackIndex}`;
  const isPlaying =
    currentTrackIdentity && currentTrackIdentity.identity === identity;

  const coverStyle = album.coverImage
    ? `style="background-image:url('${esc(safeMediaUrl(album.coverImage))}')"`
    : '';
  const coverText = album.coverImage ? '' : esc(album.cover || '♪');

  const priceHTML = premium
    ? '<div class="discography-track-price">✓<small>Premium ativo</small></div>'
    : rented
    ? '<div class="discography-track-price">✓<small>Alugada</small></div>'
    : forSale
    ? `<div class="discography-track-price">${esc(
        formatPrice(priceCents / 100)
      )}<small>pagamento único</small></div>`
    : '<div class="discography-track-price">🔒<small>exclusivo Premium</small></div>';

  const actionButtons = (() => {
    if (premium || rented) return '';
    if (!forSale) return '';
    return `
      <button class="track-action-icon buy"
              type="button"
              data-tooltip="Comprar"
              data-action="buy-track"
              data-album="${esc(album.id)}"
              data-track="${trackIndex}">🛒</button>`;
  })();

  return `
    <div class="discography-track-card ${isPlaying ? 'playing' : ''}"
         data-album="${esc(album.id)}"
         data-track="${esc(track.title)}"
         data-track-index="${trackIndex}"
         data-identity="${esc(identity)}"
         data-action="open-player">
      ${rented ? '<span class="discography-owned-badge">✓ Sua</span>' : ''}
      <div class="discography-track-cover" ${coverStyle}>${coverText}</div>
      <div class="discography-track-body">
        <div class="discography-track-title">${esc(track.title)}</div>
        <div class="discography-track-meta">
          <span>${esc(track.duration || '—')}</span>
          <span>·</span>
          <span>${locked ? (track.previewDuration || 30) + 's prévia' : 'Completa'}</span>
        </div>
        <div class="discography-track-footer">
          ${priceHTML}
          ${actionButtons ? `<div class="track-actions">${actionButtons}</div>` : ''}
        </div>
      </div>
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
  const albums = SITE.content?.discografia?.albums || [];
  return (playlist?.tracks || [])
    .map((ref) => {
      const [albumId, idxStr] = String(ref).split(':');
      const album = albums.find((a) => a.id === albumId);
      const idx = Number(idxStr);
      if (!album || !Number.isInteger(idx) || !album.tracks[idx]) return null;
      return { album, track: album.tracks[idx], trackIndex: idx };
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// COMPRA (rental) — MP checkout
// ─────────────────────────────────────────────────────────────
async function buyTrack(albumId, trackIndex) {
  if (!SITE.user) {
    toast('Entre na sua conta para comprar.', 'ℹ');
    openModal('loginModal');
    return;
  }
  if (isPremium() || isRented(albumId, trackIndex)) {
    toast('Você já tem acesso a esta faixa.', '✓');
    return;
  }

  try {
    toast('Abrindo checkout seguro...', '✦');
    const r = await fetch('/api/payments?type=rental', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId, trackIndex })
    });
    const json = await r.json();
    if (!r.ok || !json.ok || !json.checkoutUrl) {
      toast(json.error || 'Não foi possível iniciar o pagamento.', '⚠');
      return;
    }
    window.location.assign(json.checkoutUrl);
  } catch (err) {
    console.error('[buy-track]', err);
    toast('Gateway de pagamento indisponível.', '⚠');
  }
}

// ─────────────────────────────────────────────────────────────
// ASSINATURA — MP checkout
// ─────────────────────────────────────────────────────────────
async function subscribe(planId) {
  if (!SITE.user) {
    toast('Crie uma conta para assinar.', 'ℹ');
    openModal('signupModal');
    return;
  }
  if (SITE.user.plan === planId) {
    toast('Você já tem este plano.', 'ℹ');
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
// DELEGAÇÃO GLOBAL DE EVENTOS
// ─────────────────────────────────────────────────────────────
function bindGlobalEvents() {
  document.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;

    switch (action) {
      case 'toggle-album': {
        const albumId = e.target.closest('[data-album]')?.dataset.album;
        if (!albumId) break;
        SITE.expandedAlbumId = SITE.expandedAlbumId === albumId ? null : albumId;
        renderDiscography();
        break;
      }
      case 'open-player': {
        const card = e.target.closest('[data-action="open-player"]');
        if (!card || e.target.closest('button')) break;
        const albumId = card.dataset.album;
        const trackIndex = Number(card.dataset.trackIndex);
        openExpandedPlayer(albumId, trackIndex);
        break;
      }
      case 'buy-track': {
        const btn = e.target.closest('[data-action="buy-track"]');
        if (!btn) break;
        e.stopPropagation();
        await buyTrack(btn.dataset.album, Number(btn.dataset.track));
        break;
      }
      case 'open-playlist': {
        const card = e.target.closest('[data-action="open-playlist"]');
        if (!card) break;
        openPlaylistPlayer(Number(card.dataset.playlistIndex));
        break;
      }
      case 'open-plans': {
        e.preventDefault();
        openModal('plansModal');
        break;
      }
    }
  });

  const shopSearch = document.getElementById('shopSearch');
  if (shopSearch && shopSearch.dataset.bound !== '1') {
    shopSearch.dataset.bound = '1';
    shopSearch.addEventListener(
      'input',
      debounce(() => {
        SITE.shopSearch = shopSearch.value;
        renderDiscography();
      }, 250)
    );
  }

  const filterBar = document.getElementById('filterBar');
  if (filterBar && filterBar.dataset.bound !== '1') {
    filterBar.dataset.bound = '1';
    filterBar.addEventListener('click', (e) => {
      const viewBtn = e.target.closest('.view-mode-btn');
      if (viewBtn) {
        filterBar
          .querySelectorAll('.view-mode-btn')
          .forEach((b) => b.classList.remove('active'));
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

  document
    .getElementById('loginBtn')
    ?.addEventListener('click', () => openModal('loginModal'));
  document
    .getElementById('signupBtn')
    ?.addEventListener('click', () => openModal('signupModal'));
  document
    .getElementById('userChip')
    ?.addEventListener('click', openAccountModal);

  document.getElementById('switchToSignup')?.addEventListener('click', () => {
    closeModal('loginModal');
    openModal('signupModal');
  });
  document.getElementById('switchToLogin')?.addEventListener('click', () => {
    closeModal('signupModal');
    openModal('loginModal');
  });

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    try {
      await fetch('/api/auth?action=logout', {
        method: 'POST',
        credentials: 'same-origin'
      });
    } catch {}
    SITE.user = null;
    SITE.rentals = [];
    closeModal('accountModal');
    updateAuthUI();
    renderDiscography();
    toast('Você saiu da conta.', 'ℹ');
  });

  document
    .getElementById('loginForm')
    ?.addEventListener('submit', onLoginSubmit);
  document
    .getElementById('signupForm')
    ?.addEventListener('submit', onSignupSubmit);

  document
    .getElementById('newsletterForm')
    ?.addEventListener('submit', (e) => {
      e.preventDefault();
      toast('Obrigado! Em breve novidades.', '✦');
      e.target.reset();
    });

  document.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => {
      el.closest('.modal-overlay')?.classList.remove('open');
      document.body.style.overflow = '';
    });
  });

  document.querySelectorAll('.modal-overlay').forEach((o) => {
    o.addEventListener('click', (e) => {
      if (e.target === o) {
        o.classList.remove('open');
        document.body.style.overflow = '';
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    document
      .querySelectorAll('.modal-overlay.open')
      .forEach((m) => m.classList.remove('open'));
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
// HANDLERS DE AUTH
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
    toast(
      `Bem-vindo, ${(json.user.name || json.user.email).split(' ')[0]}!`,
      '✦'
    );
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

  if (name.length < 2) {
    errEl.textContent = 'Informe seu nome.';
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errEl.textContent = 'E-mail inválido.';
    return;
  }
  if (password.length < 8) {
    errEl.textContent = 'Senha deve ter pelo menos 8 caracteres.';
    return;
  }

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

      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        continue;
      }

      const tag = child.tagName;
      const isBr = tag === 'BR';
      const isGoldSpan =
        tag === 'SPAN' && child.getAttribute('class') === 'gold';

      if (!isBr && !isGoldSpan) {
        child.replaceWith(doc.createTextNode(child.textContent || ''));
        continue;
      }

      for (const attr of Array.from(child.attributes)) {
        if (isGoldSpan && attr.name === 'class' && attr.value === 'gold') {
          continue;
        }
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
    if (avatar) {
      avatar.textContent = (u.name || u.email || '?').charAt(0).toUpperCase();
    }
    const nameMini = document.getElementById('userNameMini');
    if (nameMini) {
      nameMini.textContent = (u.name || u.email || '').split(' ')[0];
    }
    const planMini = document.getElementById('userPlanMini');
    if (planMini) {
      planMini.textContent =
        u.plan === 'anual'
          ? 'Premium Anual'
          : u.plan === 'premium'
          ? 'Premium'
          : 'Free';
    }
  } else {
    if (loginBtn) loginBtn.style.display = '';
    if (signupBtn) signupBtn.style.display = '';
    if (chip) chip.classList.remove('visible');
  }
}

function updateCartBadge() {
  const cartLink = document.getElementById('navCartLink');
  if (cartLink) cartLink.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────
// MODAL DE CONTA
// ─────────────────────────────────────────────────────────────
function openAccountModal() {
  const u = SITE.user;
  if (!u) {
    openModal('loginModal');
    return;
  }

  const avatar = document.getElementById('accountAvatar');
  if (avatar) {
    avatar.textContent = (u.name || u.email || '?').charAt(0).toUpperCase();
  }

  const name = document.getElementById('accountName');
  if (name) name.textContent = u.name || 'Usuário';

  const email = document.getElementById('accountEmail');
  if (email) email.textContent = u.email || '';

  const planValue = document.getElementById('accountPlanValue');
  if (planValue) {
    planValue.textContent =
      u.plan === 'anual'
        ? 'Premium Anual'
        : u.plan === 'premium'
        ? 'Premium'
        : 'Free';
  }
  const planDesc = document.getElementById('accountPlanDesc');
  if (planDesc) {
    planDesc.textContent =
      u.plan === 'free'
        ? 'Acesso a prévias + loja de faixas.'
        : 'Acesso completo + downloads.';
  }

  const actions = document.getElementById('accountActions');
  if (actions) {
    const isFree = u.plan === 'free';
    actions.innerHTML = `
      <button class="btn ${isFree ? 'btn-primary' : 'btn-outline'} btn-block" id="accountUpgradeBtn">
        ${isFree ? 'Fazer upgrade para Premium' : 'Gerenciar assinatura'}
      </button>
    `;
    document
      .getElementById('accountUpgradeBtn')
      ?.addEventListener('click', () => {
        closeModal('accountModal');
        openModal('plansModal');
      });
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
  audio.addEventListener('ended', nextTrack);
  audio.addEventListener('loadedmetadata', syncProgress);
  audio.addEventListener('loadedmetadata', syncExpandedProgress);

  bindPlayerControls();
  updateMuteButtons();
}

function bindPlayerControls() {
  const bind = (id, fn) =>
    document.getElementById(id)?.addEventListener('click', fn);

  bind('playBtn', togglePlay);
  bind('nextBtn', nextTrack);
  bind('prevBtn', prevTrack);
  bind('muteBtn', toggleMute);
  bind('downloadBtn', onDownloadClick);
  bind('lyricsBtn', () =>
    document.getElementById('lyricsDrawer')?.classList.toggle('open')
  );

  bind('closeExpandedPlayer', closeExpandedPlayer);
  bind('expandedPlayBtn', togglePlay);
  bind('expandedNextBtn', nextTrack);
  bind('expandedPrevBtn', prevTrack);
  bind('expandedMuteBtn', toggleMute);
  bind('expandedDownloadBtn', onDownloadClick);
  bind('closeLyrics', () =>
    document.getElementById('lyricsDrawer')?.classList.remove('open')
  );

  bindProgressBar('progressBar');
  bindProgressBar('expandedProgressBar');
  bindVolumeBar('volumeBar');
}

async function playFromDiscography(albumId, trackIndex) {
  const album = SITE.content?.discografia?.albums?.find(
    (a) => a.id === albumId
  );
  if (!album) return;
  const track = album.tracks[trackIndex];
  if (!track) return;

  const unlocked = isPremium() || isRented(albumId, trackIndex);
  const cfg = computePlaybackConfig(track, unlocked);
  if (!cfg.src) {
    toast('Faixa sem áudio cadastrado.', '⚠');
    return;
  }

  currentTrackIdentity = {
    albumId,
    trackIndex,
    trackTitle: track.title,
    identity: `${albumId}:${trackIndex}`
  };
  previewState = { active: cfg.isPreview, start: cfg.start, end: cfg.end };
  previewNoticeTrackKey = '';

  audio.src = cfg.src;
  audio.load();

  const onLoaded = () => {
    if (previewState.active && previewState.start > 0) {
      try {
        audio.currentTime = previewState.start;
      } catch {}
    }
    audio.removeEventListener('loadedmetadata', onLoaded);
  };
  audio.addEventListener('loadedmetadata', onLoaded);

  const titleEl = document.getElementById('nowTitle');
  if (titleEl) titleEl.textContent = track.title;
  const artistEl = document.getElementById('nowArtist');
  if (artistEl) {
    artistEl.textContent = `Joseph Matthos · ${album.title}${
      unlocked ? '' : ' (prévia)'
    }`;
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

  document
    .getElementById('previewBadge')
    ?.classList.toggle('visible', !unlocked);
  document
    .getElementById('expandedPreviewBadge')
    ?.classList.toggle('visible', !unlocked);

  renderLyrics(track);
  syncExpandedPlayer(track, album, unlocked);
  updatePlayingHighlight();

  try {
    await audio.play();
  } catch (err) {
    console.debug('[player] autoplay bloqueado:', err?.message);
  }
}

function computePlaybackConfig(track, unlocked) {
  if (unlocked && track.fullAudio) {
    return { src: track.fullAudio, isPreview: false, start: 0, end: Infinity };
  }
  const dur = Math.max(5, parseInt(track.previewDuration) || 30);
  if (track.previewAudio) {
    return { src: track.previewAudio, isPreview: true, start: 0, end: dur };
  }
  if (track.fullAudio) {
    const start = Math.max(0, parseInt(track.previewStart) || 0);
    return { src: track.fullAudio, isPreview: true, start, end: start + dur };
  }
  return { src: '', isPreview: true, start: 0, end: 0 };
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
  if (!currentTrackIdentity) return;
  const albums = SITE.content?.discografia?.albums || [];
  for (const album of albums) {
    for (let i = 0; i < album.tracks.length; i++) {
      const isCurrent =
        currentTrackIdentity.albumId === album.id &&
        currentTrackIdentity.trackIndex === i;
      if (isCurrent) {
        if (i + 1 < album.tracks.length) {
          return playFromDiscography(album.id, i + 1);
        }
        return;
      }
    }
  }
}

function prevTrack() {
  if (!audio || !currentTrackIdentity) return;
  if (audio.currentTime > 3 && !previewState.active) {
    audio.currentTime = 0;
    return;
  }
  const albums = SITE.content?.discografia?.albums || [];
  for (const album of albums) {
    for (let i = 0; i < album.tracks.length; i++) {
      const isCurrent =
        currentTrackIdentity.albumId === album.id &&
        currentTrackIdentity.trackIndex === i;
      if (isCurrent && i > 0) {
        return playFromDiscography(album.id, i - 1);
      }
    }
  }
}

function toggleMute() {
  if (!audio) return;
  if (muted) {
    audio.volume = lastVolume || 0.8;
    muted = false;
  } else {
    lastVolume = audio.volume;
    audio.volume = 0;
    muted = true;
  }
  updateMuteButtons();
  updateVolumeFill();
}

function updateMuteButtons() {
  const icon =
    muted || audio?.volume === 0
      ? '🔇'
      : audio?.volume < 0.5
      ? '🔉'
      : '🔊';
  const btn = document.getElementById('muteBtn');
  if (btn) btn.textContent = icon;
  const exp = document.getElementById('expandedMuteBtn');
  if (exp) exp.textContent = icon;
}

function updateVolumeFill() {
  const fill = document.getElementById('volumeFill');
  if (fill && audio) {
    fill.style.width = audio.volume * 100 + '%';
  }
  const bar = document.getElementById('volumeBar');
  if (bar && audio) {
    bar.setAttribute('aria-valuenow', Math.round(audio.volume * 100));
  }
}

function onDownloadClick() {
  if (!currentTrackIdentity) {
    toast('Toque uma faixa primeiro.', 'ℹ');
    return;
  }
  const unlocked =
    isPremium() ||
    isRented(currentTrackIdentity.albumId, currentTrackIdentity.trackIndex);
  if (!unlocked) {
    toast('Compre ou assine para baixar.', '🔒');
    return;
  }
  const album = SITE.content?.discografia?.albums?.find(
    (a) => a.id === currentTrackIdentity.albumId
  );
  const track = album && album.tracks[currentTrackIdentity.trackIndex];
  if (!track?.fullAudio) {
    toast('Faixa sem áudio completo.', '⚠');
    return;
  }
  const a = document.createElement('a');
  a.href = track.fullAudio;
  a.download = `Joseph Matthos - ${track.title}.mp3`;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('Download iniciado.', '⬇');
}

function bindProgressBar(id) {
  const bar = document.getElementById(id);
  if (!bar) return;

  const seek = (clientX) => {
    if (!audio || !audio.duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    if (previewState.active) {
      audio.currentTime =
        previewState.start + pct * (previewState.end - previewState.start);
    } else {
      audio.currentTime = pct * audio.duration;
    }
    syncProgress();
    syncExpandedProgress();
  };

  bar.addEventListener('click', (e) => seek(e.clientX));

  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      seekBy(5);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seekBy(-5);
    }
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

  const setFromClientX = (clientX) => {
    if (!audio) return;
    const rect = bar.getBoundingClientRect();
    const v = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    audio.volume = v;
    lastVolume = v;
    muted = v === 0;
    updateVolumeFill();
    updateMuteButtons();
  };

  bar.addEventListener('click', (e) => setFromClientX(e.clientX));
}

function onTimeUpdate() {
  if (!audio || isSeeking) return;

  if (previewState.active && audio.currentTime >= previewState.end) {
    audio.pause();
    audio.currentTime = previewState.end;

    const key = currentTrackIdentity ? currentTrackIdentity.identity : '';
    if (previewNoticeTrackKey !== key) {
      toast('Prévia encerrada. Compre ou assine para ouvir completa.', '🎧');
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

  const total = previewState.active
    ? previewState.end - previewState.start
    : audio?.duration;
  const current = previewState.active
    ? Math.max(0, (audio?.currentTime || 0) - previewState.start)
    : audio?.currentTime || 0;

  const pct =
    Number.isFinite(total) && total > 0
      ? Math.min(100, (current / total) * 100)
      : 0;

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

  const total = previewState.active
    ? previewState.end - previewState.start
    : audio?.duration;
  const current = previewState.active
    ? Math.max(0, (audio?.currentTime || 0) - previewState.start)
    : audio?.currentTime || 0;

  const pct =
    Number.isFinite(total) && total > 0
      ? Math.min(100, (current / total) * 100)
      : 0;

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
    lines.forEach((line, index) => {
      if (Number(line.dataset.lyricTime) <= (audio?.currentTime || 0)) {
        active = index;
      }
    });

    lines.forEach((line, index) => {
      line.classList.toggle('active', index === active);
    });

    if (active >= 0 && lines[active].scrollIntoView) {
      lines[active].scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }
  }
}

function onPlay() {
  const btn = document.getElementById('playBtn');
  if (btn) btn.textContent = '⏸';
  const cover = document.getElementById('playerCover');
  if (cover) cover.classList.add('spinning');
  const expanded = document.getElementById('expandedPlayBtn');
  if (expanded) expanded.textContent = '⏸';
  updateMuteButtons();
}

function onPause() {
  const btn = document.getElementById('playBtn');
  if (btn) btn.textContent = '▶';
  const cover = document.getElementById('playerCover');
  if (cover) cover.classList.remove('spinning');
  const expanded = document.getElementById('expandedPlayBtn');
  if (expanded) expanded.textContent = '▶';
}

function onError(e) {
  if (audio && audio.error && audio.error.code === MediaError.MEDIA_ERR_ABORTED) {
    return;
  }
  toast('Erro ao carregar áudio.', '⚠');
  onPause();
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
  playFromDiscography(albumId, trackIndex);
  renderExpandedPlayerActions(albumId, trackIndex);
}

function closeExpandedPlayer() {
  const modal = document.getElementById('expandedPlayerModal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

function renderExpandedPlayerActions(albumId, trackIndex) {
  const wrap = document.getElementById('expandedPlayerActions');
  if (!wrap) return;

  const album = SITE.content?.discografia?.albums?.find(
    (a) => a.id === albumId
  );
  const track = album && album.tracks[trackIndex];
  if (!track) {
    wrap.innerHTML = '';
    return;
  }

  if (isPremium()) {
    wrap.innerHTML =
      '<span class="expanded-access">Premium: álbum completo liberado</span>';
    return;
  }
  if (isRented(albumId, trackIndex)) {
    wrap.innerHTML =
      '<span class="expanded-access">Você tem acesso a esta faixa</span>';
    return;
  }

  const cents = trackPriceCents(albumId, trackIndex);
  const priceText = cents > 0 ? formatPrice(cents / 100) : '';

  wrap.innerHTML = `
    <button class="btn btn-primary btn-sm"
            data-action="buy-track"
            data-album="${esc(albumId)}"
            data-track="${trackIndex}">
      ${priceText ? `Comprar ${esc(priceText)}` : 'Comprar'}
    </button>
    <button class="btn btn-ghost btn-sm"
            data-action="open-plans">
      Assinar Premium
    </button>`;
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
    if (safeCover) {
      cover.style.backgroundImage = `url('${safeCover}')`;
      cover.textContent = '';
    } else {
      cover.style.backgroundImage = '';
      cover.textContent = album.cover || '♪';
    }
  }
  if (badge) badge.classList.toggle('visible', !unlocked);
}

function renderLyrics(track) {
  const html = (() => {
    const lyrics = Array.isArray(track?.lyrics) ? track.lyrics : [];
    if (!lyrics.length) {
      return '<p class="lyrics-empty">Sem letra sincronizada.</p>';
    }
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

// ─────────────────────────────────────────────────────────────
// MODAIS GENÉRICOS
// ─────────────────────────────────────────────────────────────
function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
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

// Debug
window.__site = {
  get state() {
    return { ...SITE };
  },
  async reload() {
    await loadUser();
    applyContentToSite();
    renderDiscography();
  },
  openAdmin() {
    maybeOpenAdmin();
  }
};
