/* ============================================================
   SERVICE WORKER — Joseph Matthos
   ------------------------------------------------------------
   - Cache estático para assets (CSS, JS público, imagens)
   - HTML: network-first (fallback offline.html)
   - JS do admin: network-first (NUNCA cacheado — muda com frequência)
   - API: nunca cacheada
   - Range requests (áudio): passam direto
   - Imagens: fallback para /offline.html (universal)
   ------------------------------------------------------------
   ⚠️  Ao fazer deploy de mudanças nos assets, bumpe CACHE_VERSION
   ⚠️  Arquivos em /js/admin/** NÃO entram no cache — sempre frescos
   ============================================================ */

const CACHE_VERSION = 'jm-v16';

const CACHE_STATIC = [
  // Páginas
  '/',
  '/index.html',
  '/offline.html',
  '/politica-privacidade.html',
  '/termos-uso.html',

  // CSS
  '/css/style.css',

  // JS — site público
  '/js/utils.js',
  '/js/config.js',
  '/js/site.js',

  // Imagens padrão (fallback de layout)
  '/assets/img/tema.webp',
  '/assets/img/vinil.webp',
  '/assets/img/josephmatthos.webp'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      const results = await Promise.allSettled(
        CACHE_STATIC.map((url) => cache.add(url))
      );

      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn('[SW] Falha ao cachear:', CACHE_STATIC[i], r.reason?.message);
        }
      });

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (req.headers.get('range')) return;

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  if (url.pathname.startsWith('/js/admin/')) {
    event.respondWith(handleAdminAsset(req));
    return;
  }

  event.respondWith(handleAsset(req));
});

async function handleNavigation(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok && !res.redirected) {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch {
    const cached =
      (await caches.match(req)) ||
      (await caches.match('/offline.html'));

    if (cached) return cached;

    return new Response(
      '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Offline</title></head><body><h1>Sem conexão</h1><p>Verifique sua internet e tente novamente.</p></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
    );
  }
}

async function handleAdminAsset(req) {
  try {
    return await fetch(req);
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;

    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function handleAsset(req) {
  const cached = await caches.match(req);

  if (cached) {
    if (navigator.onLine) {
      revalidate(req).catch(() => {});
    }
    return cached;
  }

  try {
    const res = await fetch(req);

    if (res && res.ok && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
    }

    return res;
  } catch {
    // Offline e não cacheado: fallback universal (HTML ou erro)
    if (req.destination === 'image') {
      const fallback = await caches.match('/offline.html');
      if (fallback) return fallback;
    }

    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function revalidate(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok && res.status === 200 && res.type === 'basic') {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(req, res.clone());
    }
  } catch {
    // Silencioso
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
