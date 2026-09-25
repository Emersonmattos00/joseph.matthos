/* ============================================================
   SERVICE WORKER — Joseph Matthos
   ------------------------------------------------------------
   - Cache estático para assets (CSS, JS público, imagens)
   - HTML: network-first (fallback offline.html)
   - JS do admin: network-first (NUNCA cacheado)
   - API: NUNCA cacheada (incluindo /api/stream)
   - Range requests (áudio): passam direto, sem interceptação
   - Cross-origin (Supabase Storage): passam direto
   - Imagens: fallback para placeholder SVG em caso de falha

   ⚠️  Ao fazer deploy de mudanças nos assets, bumpe CACHE_VERSION
   ⚠️  Arquivos em /js/admin/** NÃO entram no cache — sempre frescos
   ⚠️  /api/** NUNCA é interceptada — sempre vai à rede

   🛡️  SEGURANÇA
   ------------------------------------------------------------
   - URLs assinadas do Supabase (fullUrl) NUNCA são cacheadas
   - O player pede /api/stream toda vez → URL nova a cada request
   - Se o SW cacheasse /api/stream, uma URL expirada seria servida
   - Por isso há 3 guardas redundantes abaixo:
       1. url.pathname.startsWith('/api/')
       2. url.origin !== self.location.origin
       3. req.headers.get('range')
   ============================================================ */

const CACHE_VERSION = 'jm-v18';

// ─────────────────────────────────────────────────────────────
// Precache — assets estáticos do site público
// ⚠️  NÃO incluir /js/admin/** — esses são network-first
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Placeholder SVG — usado como fallback de imagem quebrada
// (retornar HTML para <img> quebra o layout; SVG é aceito)
// ─────────────────────────────────────────────────────────────
const IMAGE_PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none">
  <rect width="200" height="200" fill="#131216"/>
  <circle cx="100" cy="100" r="60" fill="none" stroke="#2b272f" stroke-width="2"/>
  <text x="100" y="110" text-anchor="middle" fill="#b0a9a0" font-family="system-ui, sans-serif" font-size="14">♪</text>
</svg>`;

// ─────────────────────────────────────────────────────────────
// INSTALL — precacheia assets estáticos
// ─────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      const results = await Promise.allSettled(
        CACHE_STATIC.map((url) => cache.add(url))
      );

      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          console.warn(
            '[SW] Falha ao cachear:',
            CACHE_STATIC[i],
            r.reason?.message
          );
        }
      });

      await self.skipWaiting();
    })()
  );
});

// ─────────────────────────────────────────────────────────────
// ACTIVATE — limpa caches antigos e assume controle
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// FETCH — roteia por tipo de requisição
// ─────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 1) Só intercepta GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 2) Guarda: NUNCA intercepta cross-origin (Supabase, CDNs, MP)
  //    O áudio vem de *.supabase.co — o SW nem vê.
  if (url.origin !== self.location.origin) return;

  // 3) Guarda: NUNCA intercepta /api/* (inclui /api/stream)
  //    URLs assinadas precisam ser geradas a cada request.
  if (url.pathname.startsWith('/api/')) return;

  // 4) Guarda: NUNCA intercepta Range requests (áudio com seek)
  if (req.headers.get('range')) return;

  // ── Navegação (HTML) → network-first + fallback offline
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // ── JS do admin → network-first (nunca cacheia)
  if (url.pathname.startsWith('/js/admin/')) {
    event.respondWith(handleAdminAsset(req));
    return;
  }

  // ── Assets estáticos → cache-first + revalidate em background
  event.respondWith(handleAsset(req));
});

// ─────────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────────

/**
 * Navegação (HTML):
 * - network-first (busca versão fresca)
 * - fallback para cache
 * - fallback final para offline.html
 */
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
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Offline</title></head><body style="background:#0b0a0c;color:#eee9e0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:2rem;"><div><h1 style="color:#d4af37;">Sem conexão</h1><p>Verifique sua internet e tente novamente.</p></div></body></html>`,
      {
        status: 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }
    );
  }
}

/**
 * JS do admin:
 * - network-first puro
 * - SEM cache de escrita (nunca guarda versão antiga)
 * - se offline e não tem cache, retorna erro claro
 */
async function handleAdminAsset(req) {
  try {
    return await fetch(req);
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;

    return new Response('', {
      status: 504,
      statusText: 'Offline'
    });
  }
}

/**
 * Assets estáticos (CSS, JS público, imagens):
 * - cache-first
 * - revalidate em background se online
 * - fallback de imagem → placeholder SVG
 */
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
    // Offline e não cacheado
    if (req.destination === 'image') {
      // SVG é seguro como resposta de <img>
      return new Response(IMAGE_PLACEHOLDER_SVG, {
        status: 200,
        headers: {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store'
        }
      });
    }

    return new Response('', {
      status: 504,
      statusText: 'Offline'
    });
  }
}

/**
 * Revalida um asset em background, atualizando o cache se mudou.
 */
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

// ─────────────────────────────────────────────────────────────
// MESSAGE — permite ao cliente forçar skipWaiting
// ─────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
