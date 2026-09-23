/* ============================================================
   api/public.js — Endpoints públicos consolidados
   ------------------------------------------------------------
   GET /api/public                    → { ok, content, albums, tracks, plans, rentalPlans }
   GET /api/public?resource=content   → { ok, data, version, updatedAt }
   GET /api/public?resource=albums    → { ok, albums: [...] }
   GET /api/public?resource=tracks    → { ok, tracks: [...] }
   GET /api/public?resource=plans     → { ok, currency, plans: [...] }
   GET /api/public?resource=rental-plans → { ok, rentalPlans: [...] }
   HEAD /api/public[?resource=...]    → mesmos headers, sem body

   - Só GET e HEAD
   - Cache HTTP por recurso
   - Rate limit por IP (opcional)
   - NUNCA expõe URLs de áudio (vêm via /api/stream)
   - NUNCA expõe paths de áudio (preview_path / full_path)
   - NUNCA expõe dados sensíveis
   - Preços vêm das envs (fonte de verdade)

   🛡️ REGRA DE OURO
   ------------------------------------------------------------
   Este endpoint é CEGO ao áudio. Ele devolve apenas METADADOS
   da faixa (id, título, duração, preço, preview_start...).

   A resolução do áudio acontece em /api/stream, que verifica
   a permissão do usuário ANTES de gerar qualquer URL.

   ❌ NUNCA fazer aqui:
      fullUrl = supabaseStoragePublicUrl('audio-premium', track.full_path)
      previewUrl = supabaseStoragePublicUrl('audio-preview', track.preview_path)

   ✅ Fazemos aqui:
      hasPreview = !!track.preview_path   (booleano, não o path)
      hasFull    = !!track.full_path      (booleano, não o path)
   ============================================================ */

'use strict';

const {
  sendJson,
  supabaseAdminRequest,
  checkAndIncrement,
  clientIp
} = require('./_lib');

const CONTENT_KEY = 'default';
const MAX_ALBUMS = 200;
const MAX_TRACKS = 2000;

const RATE_MAX_REQUESTS = 120;
const RATE_WINDOW_MS = 60_000;

const CACHE_AGGREGATE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400';
const CACHE_PLANS = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600';

const VALID_RESOURCES = new Set([
  'content',
  'albums',
  'tracks',
  'plans',
  'rental-plans'
]);

// ─────────────────────────────────────────────────────────────
// Rental plans — apenas metadata de exibição
// ⚠️ Os PREÇOS vêm das envs (fonte de verdade).
// ─────────────────────────────────────────────────────────────
const RENTAL_PLAN_DEFS = [
  { id: '24h', envKey: 'RENTAL_PRICE_24H', label: '24 horas', days: 1,  popular: false },
  { id: '48h', envKey: 'RENTAL_PRICE_48H', label: '48 horas', days: 2,  popular: true  },
  { id: '3d',  envKey: 'RENTAL_PRICE_3D',  label: '3 dias',   days: 3,  popular: false },
  { id: '5d',  envKey: 'RENTAL_PRICE_5D',  label: '5 dias',   days: 5,  popular: false },
  { id: '10d', envKey: 'RENTAL_PRICE_10D', label: '10 dias',  days: 10, popular: false },
  { id: '15d', envKey: 'RENTAL_PRICE_15D', label: '15 dias',  days: 15, popular: false }
];

// ─────────────────────────────────────────────────────────────
// MIME por extensão (diagnóstico)
// ─────────────────────────────────────────────────────────────
const MIME_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  aac: 'audio/aac',
  webm: 'audio/webm',
  aif: 'audio/aiff',
  aiff: 'audio/aiff'
};

module.exports = async function handler(req, res) {
  res.setHeader('Allow', 'GET, HEAD');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Accept-Encoding');

  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
  }

  // ── Rate limit por IP (defesa contra scraping)
  const ip = clientIp(req);
  const rate = await checkAndIncrement(`public:${ip}`, RATE_MAX_REQUESTS, RATE_WINDOW_MS);
  if (rate.limited) {
    res.setHeader('Retry-After', String(rate.retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 429, { ok: false, error: 'Muitas requisições.' });
  }

  const resource = parseResource(req.query);

  res.setHeader(
    'Cache-Control',
    resource === 'plans' || resource === 'rental-plans' ? CACHE_PLANS : CACHE_AGGREGATE
  );

  try {
    if (!resource) {
      // ── Agregado: content + albums (com tracks) + tracks flat + plans + rentalPlans
      const [content, catalog, plans] = await Promise.all([
        fetchContent(),
        fetchAlbumsWithTracks(),
        fetchPlans()
      ]);

      if (!content.ok) return fail(res, method, 502, 'Conteúdo indisponível.');
      if (!catalog.ok) return fail(res, method, 502, 'Catálogo indisponível.');

      const rentals = fetchRentalPlans();

      const payload = {
        ok: true,
        content: content.data,
        contentVersion: content.version,
        contentUpdatedAt: content.updatedAt,
        albums: catalog.albums,
        tracks: catalog.tracks,
        plans: plans.plans,
        currency: plans.currency,
        rentalPlans: rentals.rentalPlans
      };

      return respond(res, method, payload);
    }

    if (resource === 'content') {
      const r = await fetchContent();
      if (!r.ok) return fail(res, method, 502, 'Conteúdo indisponível.');
      return respond(res, method, {
        ok: true,
        data: r.data,
        version: r.version,
        updatedAt: r.updatedAt
      });
    }

    if (resource === 'albums') {
      const r = await fetchAlbumsWithTracks();
      if (!r.ok) return fail(res, method, 502, 'Catálogo indisponível.');
      return respond(res, method, { ok: true, albums: r.albums });
    }

    if (resource === 'tracks') {
      const r = await fetchTracks();
      if (!r.ok) return fail(res, method, 502, 'Catálogo indisponível.');
      return respond(res, method, { ok: true, tracks: r.tracks });
    }

    if (resource === 'plans') {
      const r = await fetchPlans();
      return respond(res, method, {
        ok: true,
        currency: r.currency,
        plans: r.plans
      });
    }

    if (resource === 'rental-plans') {
      const r = fetchRentalPlans();
      return respond(res, method, {
        ok: true,
        rentalPlans: r.rentalPlans
      });
    }

    return fail(res, method, 400, 'Recurso inválido.');
  } catch (error) {
    console.error('[public] erro:', error.code || error.message);
    return fail(res, method, 502, 'Serviço indisponível.');
  }
};

// ─────────────────────────────────────────────────────────────
// Content
// ─────────────────────────────────────────────────────────────
async function fetchContent() {
  const result = await supabaseAdminRequest(
    `/rest/v1/site_content?key=eq.${CONTENT_KEY}&select=data,version,updated_at&limit=1`,
    { method: 'GET' }
  );

  if (!result.response.ok) return { ok: false };

  const row = Array.isArray(result.body) ? result.body[0] : null;

  return {
    ok: true,
    data: row?.data && typeof row.data === 'object' ? row.data : {},
    version: Number(row?.version) || 0,
    updatedAt: row?.updated_at || null
  };
}

// ─────────────────────────────────────────────────────────────
// Albums + Tracks (agregado)
// ------------------------------------------------------------
// Busca álbuns publicados e suas faixas publicadas, retornando
// a estrutura hierárquica esperada pelo site.js:
//   [{ id, title, type, year, coverImage, description, tracks: [...] }]
//
// ⚠️  NÃO retorna full_path nem preview_path.
//     URLs de áudio vêm via /api/stream (com verificação de permissão).
//
// ✅ Retorna hasPreview / hasFull como BOOLEANOS (seguro).
// ─────────────────────────────────────────────────────────────
async function fetchAlbumsWithTracks() {
  const [albumsRes, tracksRes] = await Promise.all([
    supabaseAdminRequest(
      `/rest/v1/albums?published=eq.true` +
        `&select=id,title,artist,year,type,cover_initials,cover_image,description,order_index` +
        `&order=order_index.asc,id.asc` +
        `&limit=${MAX_ALBUMS}`,
      { method: 'GET' }
    ),
    supabaseAdminRequest(
      `/rest/v1/tracks?published=eq.true` +
        `&select=id,album_id,track_index,title,duration,` +
        `preview_start,preview_duration,price_cents,for_sale,lyrics,` +
        `preview_path,full_path` +
        `&order=album_id.asc,track_index.asc` +
        `&limit=${MAX_TRACKS}`,
      { method: 'GET' }
    )
  ]);

  if (!albumsRes.response.ok || !tracksRes.response.ok) {
    return { ok: false };
  }

  const albumRows = Array.isArray(albumsRes.body) ? albumsRes.body : [];
  const trackRows = Array.isArray(tracksRes.body) ? tracksRes.body : [];

  // Agrupa tracks por album_id
  const byAlbum = new Map();
  for (const t of trackRows) {
    if (!byAlbum.has(t.album_id)) byAlbum.set(t.album_id, []);
    byAlbum.get(t.album_id).push(t);
  }

  const albums = albumRows.map((a) => ({
    id: a.id,
    title: a.title || '',
    artist: a.artist || 'Joseph Matthos',
    year: a.year,
    type: a.type || 'album',
    cover: a.cover_initials || '',
    coverInitials: a.cover_initials || '',
    coverImage: a.cover_image || '',
    description: a.description || '',
    orderIndex: Number(a.order_index) || 0,
    tracks: (byAlbum.get(a.id) || []).map((t) => mapTrack(t))
  }));

  // Lista flat (compatibilidade)
  const flatTracks = trackRows.map((t) => mapTrack(t));

  return { ok: true, albums, tracks: flatTracks };
}

// ─────────────────────────────────────────────────────────────
// Tracks (flat)
// ─────────────────────────────────────────────────────────────
async function fetchTracks() {
  const result = await supabaseAdminRequest(
    `/rest/v1/tracks?published=eq.true` +
      `&select=id,album_id,track_index,title,duration,` +
      `preview_start,preview_duration,price_cents,for_sale,lyrics,` +
      `preview_path,full_path` +
      `&order=album_id.asc,track_index.asc` +
      `&limit=${MAX_TRACKS}`,
    { method: 'GET' }
  );

  if (!result.response.ok) return { ok: false };

  const rows = Array.isArray(result.body) ? result.body : [];

  return {
    ok: true,
    tracks: rows.map((t) => mapTrack(t))
  };
}

// ─────────────────────────────────────────────────────────────
// Mapeia uma linha de `tracks` para o formato do cliente
// ------------------------------------------------------------
// ⚠️  NUNCA expõe:
//     - preview_path (path no bucket)
//     - full_path (path no bucket)
//     - URLs públicas ou assinadas
//
// ✅ Expõe:
//     - hasPreview / hasFull (booleanos) — segurança preservada
//     - previewStart / previewDuration (metadados)
//     - id (track.id) — obrigatório para playlists
// ─────────────────────────────────────────────────────────────
function mapTrack(t) {
  return {
    id: t.id,
    albumId: t.album_id,
    trackIndex: t.track_index,
    title: t.title || '',
    duration: t.duration || '',
    previewStart: Number(t.preview_start) || 0,
    previewDuration: Number(t.preview_duration) || 30,
    priceCents: Number(t.price_cents) || 0,
    forSale: t.for_sale !== false,
    lyrics: Array.isArray(t.lyrics) ? t.lyrics : [],

    // ── Booleanos de existência (seguros)
    //    Servem para UI: mostrar 🔒 se não tem full, etc.
    hasPreview: !!t.preview_path,
    hasFull: !!t.full_path,

    // ── MIME inferido (útil para diagnóstico; não expõe paths)
    previewMime: guessMime(t.preview_path),
    fullMime: guessMime(t.full_path)
  };
}

// ─────────────────────────────────────────────────────────────
// Plans (assinatura)
// ─────────────────────────────────────────────────────────────
async function fetchPlans() {
  const monthlyCents = parsePriceCents(process.env.MP_PREMIUM_MONTHLY_PRICE);
  const annualCents = parsePriceCents(process.env.MP_PREMIUM_ANNUAL_PRICE);

  const plans = [
    { id: 'free', priceCents: 0, interval: null, available: true }
  ];

  plans.push(monthlyCents !== null
    ? { id: 'premium', priceCents: monthlyCents, interval: 'month', available: true }
    : { id: 'premium', priceCents: 0, interval: 'month', available: false });

  plans.push(annualCents !== null
    ? { id: 'anual', priceCents: annualCents, interval: 'year', available: true }
    : { id: 'anual', priceCents: 0, interval: 'year', available: false });

  return { currency: 'BRL', plans };
}

// ─────────────────────────────────────────────────────────────
// Rental plans (aluguel de faixas)
// ------------------------------------------------------------
// Envs esperadas:
//   RENTAL_PRICE_24H, RENTAL_PRICE_48H, RENTAL_PRICE_3D,
//   RENTAL_PRICE_5D, RENTAL_PRICE_10D, RENTAL_PRICE_15D
// ─────────────────────────────────────────────────────────────
function fetchRentalPlans() {
  const rentalPlans = RENTAL_PLAN_DEFS
    .map((def) => {
      const raw = process.env[def.envKey];
      const price = Number(raw);
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        id: def.id,
        label: def.label,
        days: def.days,
        price,
        popular: def.popular
      };
    })
    .filter(Boolean);

  return { rentalPlans };
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function parseResource(query) {
  if (!query) return null;
  const raw = String(query.resource || '').trim().toLowerCase();
  if (!raw || raw === 'all') return null;
  return VALID_RESOURCES.has(raw) ? raw : null;
}

function parsePriceCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function guessMime(path) {
  if (!path) return null;
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || null;
}

function respond(res, method, payload) {
  if (method === 'HEAD') {
    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end();
  }
  return sendJson(res, 200, payload);
}

function fail(res, method, status, message) {
  res.setHeader('Cache-Control', 'no-store');
  if (method === 'HEAD') {
    res.status(status);
    return res.end();
  }
  return sendJson(res, status, { ok: false, error: message });
}
