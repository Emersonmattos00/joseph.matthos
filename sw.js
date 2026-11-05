'use strict';

/* ============================================================
   SERVICE WORKER — Joseph Matthos
   ------------------------------------------------------------
   - Pré-cache de páginas públicas e recursos essenciais
   - HTML público: network-first com fallback offline
   - Recursos estáticos: cache-first com revalidação em background
   - JS administrativo: network-only (nunca cache)
   - API: nunca interceptada
   - Áudio e Range requests: nunca interceptados
   - CDN e armazenamento externo: nunca interceptados
   - Caches isolados por prefixo (jm-)
   ============================================================ */

const CACHE_PREFIX = 'jm-';
const CACHE_VERSION = 'jm-v26'; // bump quando assets mudarem

const MAX_CACHE_ENTRIES = 150;

// ============================================================
// PRÉ-CACHE
// ============================================================

const CACHE_STATIC = [
  '/',
  '/index.html',
  '/offline.html',
  '/politica-privacidade.html',
  '/termos-uso.html',

  '/css/style.css',

  '/js/utils.js',
  '/js/config.js',
  '/js/site.js',

  '/assets/img/tema.webp',
  '/assets/img/vinil.webp',
  '/assets/img/josephmatthos.webp'
];

const ALLOWED_PAGES = new Set([
  '/',
  '/index.html',
  '/offline.html',
  '/politica-privacidade.html',
  '/termos-uso.html'
]);

// ============================================================
// PLACEHOLDER SVG
// ============================================================

const IMAGE_PLACEHOLDER_SVG = `
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 200 200"
     fill="none">
  <rect width="200" height="200" fill="#131216"/>
  <circle cx="100" cy="100" r="60"
          fill="none"
          stroke="#2b272f"
          stroke-width="2"/>
  <text x="100" y="110"
        text-anchor="middle"
        fill="#b0a9a0"
        font-family="system-ui, sans-serif"
        font-size="14">♪</text>
</svg>`.trim();

// ============================================================
// UTILITÁRIOS
// ============================================================

function isAdminAsset(url) {
  return url.pathname.startsWith('/js/admin/');
}

function isApiRequest(url) {
  return (
    url.pathname === '/api' ||
    url.pathname.startsWith('/api/')
  );
}

function isAllowedPage(url) {
  return ALLOWED_PAGES.has(url.pathname) && !url.search;
}

function isStaticAsset(url) {
  const pathname = url.pathname;

  if (isAdminAsset(url)) return false;
  if (url.search) return false;

  if (pathname.startsWith('/css/') && /\.css$/i.test(pathname)) {
    return true;
  }

  if (pathname.startsWith('/js/') && /\.js$/i.test(pathname)) {
    return true;
  }

  if (
    pathname.startsWith('/assets/img/') &&
    /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(pathname)
  ) {
    return true;
  }

  if (
    pathname.startsWith('/assets/fonts/') &&
    /\.(woff2?|ttf|otf)$/i.test(pathname)
  ) {
    return true;
  }

  return false;
}

function isCacheableResponse(response) {
  if (!response || !response.ok) return false;
  if (response.status !== 200) return false;
  if (response.type !== 'basic') return false;

  const cacheControl = response.headers.get('Cache-Control') || '';

  if (/\b(no-store|private)\b/i.test(cacheControl)) {
    return false;
  }

  if (response.headers.get('Vary') === '*') {
    return false;
  }

  return true;
}

function isCacheableRequest(request) {
  if (request.method !== 'GET') return false;
  if (request.headers.has('Authorization')) return false;
  if (request.headers.has('Range')) return false;
  if (request.cache === 'no-store') return false;
  return true;
}

// ============================================================
// ACESSO ISOLADO AO CACHE (nunca caches.match global)
// ============================================================

async function openCache() {
  return caches.open(CACHE_VERSION);
}

async function cacheMatch(request) {
  const cache = await openCache();
  return cache.match(request);
}

// ============================================================
// CONTROLE DO TAMANHO
// ============================================================

async function trimCache() {
  const cache = await openCache();
  const keys = await cache.keys();

  if (keys.length <= MAX_CACHE_ENTRIES) return;

  const excess = keys.length - MAX_CACHE_ENTRIES;

  await Promise.all(
    keys.slice(0, excess).map(request => cache.delete(request))
  );
}

// ============================================================
// INSTALL
// ============================================================

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await openCache();

      // Se algum essencial falhar, a instalação falha.
      // Assim, não ficamos com cache parcial.
      try {
        await cache.addAll(CACHE_STATIC);
      } catch (error) {
        await caches.delete(CACHE_VERSION);
        console.error('[SW] Pré-cache obrigatório falhou:', error);
        throw error;
      }

      console.log('[SW] Instalação concluída.');
    })()
  );
});

// ============================================================
// ACTIVATE — limpa apenas caches da plataforma (prefixo jm-)
// ============================================================

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();

      await Promise.all(
        keys
          .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
          .map(key => caches.delete(key))
      );

      await self.clients.claim();
      console.log('[SW] Ativado:', CACHE_VERSION);
    })()
  );
});

// ============================================================
// FETCH
// ============================================================

self.addEventListener('fetch', event => {
  const request = event.request;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin: CDN, B2, MP — nunca intercepta
  if (url.origin !== self.location.origin) return;

  // API — nunca intercepta
  if (isApiRequest(url)) return;

  // Áudio e Range — nunca intercepta
  if (
    request.headers.has('Range') ||
    request.destination === 'audio' ||
    url.pathname.startsWith('/assets/audio/')
  ) {
    return;
  }

  // JS admin — network only
  if (isAdminAsset(url)) {
    event.respondWith(handleAdminAsset(request));
    return;
  }

  // Navegação
  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Estáticos públicos
  if (isStaticAsset(url) && isCacheableRequest(request)) {
    event.respondWith(handleStaticAsset(request));
  }
});

// ============================================================
// NAVEGAÇÃO — NETWORK FIRST
// ============================================================

async function handleNavigation(request) {
  const url = new URL(request.url);
  const cacheable = isAllowedPage(url);

  try {
    const response = await fetch(request);

    if (cacheable && isCacheableResponse(response) && !response.redirected) {
      const cache = await openCache();
      await cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    console.warn('[SW] Navegação offline:', url.pathname);

    if (cacheable) {
      const cached = await cacheMatch(request);
      if (cached) return cached;
    }

    const offlinePage = await cacheMatch('/offline.html');
    if (offlinePage) return offlinePage;

    return new Response(
      'Sem conexão. Verifique sua internet e tente novamente.',
      {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}

// ============================================================
// ADMIN — NETWORK ONLY
// ============================================================

async function handleAdminAsset(request) {
  try {
    return await fetch(request);
  } catch {
    return new Response(
      'Recurso administrativo indisponível offline.',
      {
        status: 504,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}

// ============================================================
// ESTÁTICOS — CACHE FIRST + REVALIDAÇÃO
// ============================================================

async function handleStaticAsset(request) {
  const cached = await cacheMatch(request);

  if (cached) {
    revalidate(request).catch(error => {
      console.warn('[SW] Revalidação falhou:', error);
    });

    return cached;
  }

  try {
    const response = await fetch(request);

    if (isCacheableResponse(response)) {
      const cache = await openCache();
      await cache.put(request, response.clone());
      await trimCache();
    }

    return response;
  } catch {
    if (request.destination === 'image') {
      return new Response(IMAGE_PLACEHOLDER_SVG, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      });
    }

    return new Response(
      'Recurso indisponível offline.',
      {
        status: 504,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );
  }
}

// ============================================================
// REVALIDAÇÃO EM BACKGROUND
// ============================================================

async function revalidate(request) {
  if (!isCacheableRequest(request)) return;

  const response = await fetch(request);

  if (!isCacheableResponse(response)) return;

  const cache = await openCache();
  await cache.put(request, response.clone());
  await trimCache();
}

// ============================================================
// MENSAGENS DO CLIENTE
// ============================================================

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});