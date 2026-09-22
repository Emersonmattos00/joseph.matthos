/* ============================================================
   SERVICE WORKER — Joseph Matthos
   ------------------------------------------------------------
   - Cache estático para assets (CSS, JS público, imagens)
   - HTML: network-first (fallback offline.html)
   - JS do admin: network-first (NUNCA cacheado — muda com frequência)
   - API: nunca cacheada
   - Range requests (áudio): passam direto
   ------------------------------------------------------------
   ⚠️  Ao fazer deploy de mudanças nos assets, bumpe CACHE_VERSION
   ⚠️  Arquivos em /js/admin/** NÃO entram no cache — sempre frescos
   ============================================================ */

const CACHE_VERSION = 'jm-v15';

// ─────────────────────────────────────────────────────────────
// Assets estáticos
// ------------------------------------------------------------
// Liste TODOS os arquivos que precisam estar disponíveis offline.
// ⚠️  NÃO incluir arquivos de /js/admin/** aqui — eles usam
//     network-first e nunca são cacheados.
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
  '/assets/img/josephmatthos.webp',
  '/assets/img/placeholder.webp'
];

// ─────────────────────────────────────────────────────────────
// INSTALL — faz cache individual (resiliente a 404)
// ─────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      // addAll é atômico: se um arquivo falha, NADA é cacheado.
      // Por isso adicionamos individualmente.
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

  // Só GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Ignora cross-origin (CDN, fontes, AdSense, MP, etc.)
  if (url.origin !== self.location.origin) return;

  // Nunca cacheia API (sessão, compras, admin)
  if (url.pathname.startsWith('/api/')) return;

  // Nunca intercepta Range requests (áudio/vídeo com seek)
  if (req.headers.get('range')) return;

  // ── Navegação (HTML)
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // ── JS do admin: NUNCA cacheia (network-first puro)
  if (url.pathname.startsWith('/js/admin/')) {
    event.respondWith(handleAdminAsset(req));
    return;
  }

  // ── Assets (CSS, JS público, imagens, fontes locais)
  event.respondWith(handleAsset(req));
});

// ─────────────────────────────────────────────────────────────
// Estratégia: HTML — network-first com fallback offline
// ─────────────────────────────────────────────────────────────
async function handleNavigation(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok && !res.redirected) {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch {
    // Offline: tenta cache exato da URL, depois offline.html
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

// ─────────────────────────────────────────────────────────────
// Estratégia: admin assets — network-first, NUNCA cacheia
// ------------------------------------------------------------
// Motivo: arquivos do painel mudam com frequência durante
// manutenção. Cachear causa "corrigi mas não mudou nada".
// Se a rede falhar, ainda tenta o cache como último recurso.
// ─────────────────────────────────────────────────────────────
async function handleAdminAsset(req) {
  try {
    return await fetch(req);
  } catch {
    // Offline: se por acaso estiver em cache, usa; senão, erro
    const cached = await caches.match(req);
    if (cached) return cached;

    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// ─────────────────────────────────────────────────────────────
// Estratégia: assets — cache-first com atualização em background
// ─────────────────────────────────────────────────────────────
async function handleAsset(req) {
  const cached = await caches.match(req);

  // Se está em cache, retorna imediatamente e revalida em background
  if (cached) {
    // Só revalida se houver conexão (evita fetch inútil offline)
    if (navigator.onLine) {
      revalidate(req).catch(() => {});
    }
    return cached;
  }

  // Não está em cache: busca na rede
  try {
    const res = await fetch(req);

    // Só cacheia respostas válidas (evita cachear 404/500)
    if (res && res.ok && res.status === 200 && res.type === 'basic') {
      const clone = res.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(req, clone)).catch(() => {});
    }

    return res;
  } catch {
    // Offline e não cacheado: fallback para imagens
    if (req.destination === 'image') {
      const placeholder = await caches.match('/assets/img/placeholder.webp');
      if (placeholder) return placeholder;
    }

    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

// ─────────────────────────────────────────────────────────────
// Revalida em background (stale-while-revalidate)
// ─────────────────────────────────────────────────────────────
async function revalidate(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok && res.status === 200 && res.type === 'basic') {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(req, res.clone());
    }
  } catch {
    // Silencioso — se falhar, mantém o cache antigo
  }
}

// ─────────────────────────────────────────────────────────────
// MESSAGE — permite ao cliente forçar update
// ─────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
