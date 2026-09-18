/* ============================================================
   api/public.js — Endpoints públicos consolidados
   ------------------------------------------------------------
   GET /api/public                    → { ok, content, tracks, plans }
   GET /api/public?resource=content   → { ok, data, version, updatedAt }
   GET /api/public?resource=tracks    → { ok, tracks: [...] }
   GET /api/public?resource=plans     → { ok, currency, plans: [...] }
   HEAD /api/public[?resource=...]    → mesmos headers, sem body

   - Só GET e HEAD
   - Cache HTTP por recurso
   - Rate limit por IP (opcional)
   - Nunca expõe dados sensíveis
   ============================================================ */

'use strict';

const {
  sendJson,
  supabaseAdminRequest,
  checkAndIncrement,
  clientIp
} = require('./_lib');

const CONTENT_KEY = 'default';
const MAX_TRACKS = 1000;

const RATE_MAX_REQUESTS = 120;
const RATE_WINDOW_MS = 60_000;

const CACHE_AGGREGATE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400';
const CACHE_PLANS = 'public, max-age=300, s-maxage=300, stale-while-revalidate=3600';

const VALID_RESOURCES = new Set(['content', 'tracks', 'plans']);

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
    resource === 'plans' ? CACHE_PLANS : CACHE_AGGREGATE
  );

  try {
    if (!resource) {
      const [content, tracks, plans] = await Promise.all([
        fetchContent(),
        fetchTracks(),
        fetchPlans()
      ]);

      if (!content.ok) return fail(res, method, 502, 'Conteúdo indisponível.');
      if (!tracks.ok) return fail(res, method, 502, 'Catálogo indisponível.');

      const payload = {
        ok: true,
        content: content.data,
        contentVersion: content.version,
        contentUpdatedAt: content.updatedAt,
        tracks: tracks.tracks,
        plans: plans.plans,
        currency: plans.currency
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
// Tracks
// ─────────────────────────────────────────────────────────────
async function fetchTracks() {
  const result = await supabaseAdminRequest(
    `/rest/v1/tracks?published=eq.true` +
      `&select=album_id,track_index,title,duration,` +
      `preview_start,preview_duration,price_cents,for_sale,` +
      `full_audio,preview_audio,lyrics` +
      `&order=album_id.asc,track_index.asc` +
      `&limit=${MAX_TRACKS}`,
    { method: 'GET' }
  );

  if (!result.response.ok) return { ok: false };

  const rows = Array.isArray(result.body) ? result.body : [];

  return {
    ok: true,
    tracks: rows.map((t) => ({
      albumId: t.album_id,
      trackIndex: t.track_index,
      title: t.title || '',
      duration: t.duration || '',
      previewStart: Number(t.preview_start) || 0,
      previewDuration: Number(t.preview_duration) || 30,
      priceCents: Number(t.price_cents) || 0,
      forSale: t.for_sale !== false,
      fullAudio: safeMediaUrl(t.full_audio),
      previewAudio: safeMediaUrl(t.preview_audio),
      lyrics: Array.isArray(t.lyrics) ? t.lyrics : []
    }))
  };
}

// ─────────────────────────────────────────────────────────────
// Plans
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
// Helpers
// ─────────────────────────────────────────────────────────────
function parseResource(query) {
  if (!query) return null;
  const raw = String(query.resource || '').trim().toLowerCase();
  if (!raw || raw === 'all') return null;
  return VALID_RESOURCES.has(raw) ? raw : null;
}

function safeMediaUrl(url) {
  if (!url) return '';
  const s = String(url).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

function parsePriceCents(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
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
