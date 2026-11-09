'use strict';

/* ============================================================
   api/public.js — Catálogo Público (Versão Final Absoluta)
   ------------------------------------------------------------
   - Whitelist profunda (playlists/socials validados)
   - Validação de intervalUnit com base no schema
   - Letras aceitam array, string JSON ou objeto {lines/verses}
   - rentalPlans mantido no content para compatibilidade visual
   - audioPath 'ready' (contrato do player via /api/stream)
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

/* ─── Projeções Públicas ─────────────────────────────────── */

function albumFields() {
  return {
    id: schema.albums.id,
    title: schema.albums.title,
    slug: schema.albums.slug,
    coverUrl: schema.albums.coverUrl,
    year: schema.albums.year,
    type: schema.albums.type,
    description: schema.albums.description,
    sortOrder: schema.albums.sortOrder,
    artist: schema.albums.artist
  };
}

function trackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    durationSeconds: schema.tracks.durationSeconds,
    locked: schema.tracks.locked
  };
}

/* ─── Whitelist profunda de conteúdo ─────────────────────── */

function sanitizePlaylists(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => p && typeof p === 'object')
    .map(p => ({
      id: typeof p.id === 'string' ? p.id : '',
      title: typeof p.title === 'string' ? p.title.slice(0, 120) : '',
      description: typeof p.description === 'string' ? p.description.slice(0, 300) : '',
      cover: typeof p.cover === 'string' ? p.cover.slice(0, 4) : '♪',
      tracks: Array.isArray(p.tracks) ? p.tracks.slice(0, 500) : []
    }))
    .filter(p => p.id && p.title);
}

function sanitizeSocials(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(['spotify','youtube','amazon','facebook','tiktok','apple','audiomack','deezer','soundcloud','instagram','x']);
  return raw
    .filter(s => s && typeof s === 'object' && valid.has(String(s.network || '')))
    .map(s => ({
      network: String(s.network),
      label: typeof s.label === 'string' ? s.label.slice(0, 80) : '',
      url: typeof s.url === 'string' && /^https?:\/\//i.test(s.url) ? s.url.slice(0, 500) : ''
    }))
    .filter(s => s.url);
}

function sanitizeRentalPlans(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(p => p && typeof p === 'object')
    .map(p => ({
      id: typeof p.id === 'string' ? p.id : '',
      label: typeof p.label === 'string' ? p.label.slice(0, 120) : '',
      days: Number.isSafeInteger(p.days) ? p.days : 0,
      hours: Number.isSafeInteger(p.hours) ? p.hours : 0,
      price: Number.isFinite(p.price) ? p.price : 0,
      priceCents: Number.isSafeInteger(p.priceCents) ? p.priceCents : 0,
      currency: typeof p.currency === 'string' ? p.currency.toUpperCase() : 'BRL',
      available: p.available !== false
    }))
    .filter(p => p.id && p.label && p.priceCents > 0);
}

function filterPublicContent(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};

  if (data.branding && typeof data.branding === 'object') {
    out.branding = {
      nameParts: data.branding.nameParts,
      footer: data.branding.footer,
      bgImage: data.branding.bgImage,
      meta: data.branding.meta
    };
  }

  if (data.hero && typeof data.hero === 'object') {
    out.hero = {
      title: data.hero.title,
      subtitle: data.hero.subtitle,
      primaryBtn: data.hero.primaryBtn,
      secondaryBtn: data.hero.secondaryBtn
    };
  }

  if (data.sobre && typeof data.sobre === 'object') {
    out.sobre = {
      title: data.sobre.title,
      subtitle: data.sobre.subtitle,
      paragraphs: typeof data.sobre.paragraphs === 'string'
        ? data.sobre.paragraphs.slice(0, 10000)
        : '',
      quote: data.sobre.quote,
      image: data.sobre.image
    };
  }

  if (data.filosofia && typeof data.filosofia === 'object') {
    out.filosofia = {
      title: data.filosofia.title,
      subtitle: data.filosofia.subtitle,
      frases: Array.isArray(data.filosofia.frases)
        ? data.filosofia.frases.slice(0, 500)
        : []
    };
  }

  if (data.discografia && typeof data.discografia === 'object') {
    out.discografia = {
      title: data.discografia.title,
      subtitle: data.discografia.subtitle
    };
  }

  if (data.planos && typeof data.planos === 'object') {
    out.planos = {
      title: data.planos.title,
      subtitle: data.planos.subtitle,
      plans: Array.isArray(data.planos.plans) ? data.planos.plans.slice(0, 10) : []
    };
  }

  if (data.contato && typeof data.contato === 'object') {
    out.contato = {
      title: data.contato.title,
      subtitle: data.contato.subtitle,
      heading: data.contato.heading,
      description: data.contato.description,
      socials: sanitizeSocials(data.contato.socials)
    };
  }

  if (Array.isArray(data.playlists)) {
    out.playlists = sanitizePlaylists(data.playlists);
  }

  if (data.aparencia && typeof data.aparencia === 'object') {
    out.aparencia = {
      bg: data.aparencia.bg,
      accent: data.aparencia.accent,
      text: data.aparencia.text,
      accentDark: data.aparencia.accentDark,
      border: data.aparencia.border
    };
  }

  // Mantido para compatibilidade visual (não é fonte de preço)
  if (Array.isArray(data.rentalPlans)) {
    out.rentalPlans = sanitizeRentalPlans(data.rentalPlans);
  }

  return out;
}

/* ─── Normalização de letras ─────────────────────────────── */

function normalizeLyrics(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter(l => l && typeof l === 'object')
      .map(l => ({ time: Number(l.time) || 0, text: String(l.text || '').slice(0, 500) }))
      .filter(l => l.text);
  }
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return normalizeLyrics(parsed);
    } catch { return []; }
  }
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.lines)) return normalizeLyrics(raw.lines);
    if (Array.isArray(raw.verses)) return normalizeLyrics(raw.verses);
  }
  return [];
}

/* ─── Buscas base ────────────────────────────────────────── */

async function getAlbumsPublic() {
  return db.select(albumFields()).from(schema.albums)
    .where(eq(schema.albums.published, true))
    .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));
}

async function getTracksPublic(albumIds) {
  if (!Array.isArray(albumIds) || albumIds.length === 0) return [];
  return db.select(trackFields()).from(schema.tracks)
    .where(and(
      inArray(schema.tracks.albumId, albumIds),
      eq(schema.tracks.status, 'PUBLISHED')
    ))
    .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber), asc(schema.tracks.createdAt));
}

/* ─── Validação de planos comerciais ─────────────────────── */

const VALID_INTERVAL_UNITS = new Set(['day', 'month', 'year']);

function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
  const intervalUnit = typeof raw.intervalUnit === 'string' ? raw.intervalUnit.trim().toLowerCase() : '';
  const priceCents = Number(raw.priceCents);
  const intervalCount = Number(raw.intervalCount);

  if (!name || name.length > 120) return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  if (!VALID_INTERVAL_UNITS.has(intervalUnit)) return null;
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) return null;
  if (!Number.isSafeInteger(intervalCount) || intervalCount < 1) return null;

  return {
    id: raw.id,
    name,
    priceCents,
    currency,
    intervalUnit,
    intervalCount
  };
}

/* ─── Handler Principal ──────────────────────────────────── */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const trackId = req.query?.track;
  const albumId = req.query?.album;

  if (trackId && albumId) {
    return sendJson(res, 400, { ok: false, error: 'INVALID_QUERY' });
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // 1. FAIXA INDIVIDUAL (Player)
    // ═══════════════════════════════════════════════════════════
    if (trackId) {
      if (!validUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });

      const [track] = await db.select({
        ...trackFields(),
        lyrics: schema.tracks.lyrics
      }).from(schema.tracks)
        .where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.status, 'PUBLISHED')))
        .limit(1);

      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const [album] = await db.select(albumFields()).from(schema.albums)
        .where(and(eq(schema.albums.id, track.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const albumTracks = await getTracksPublic([album.id]);

      const [meta] = await db.select({
        streamKey: schema.tracks.streamKey,
        previewKey: schema.tracks.previewKey
      }).from(schema.tracks).where(eq(schema.tracks.id, trackId)).limit(1);
      const hasAudio = Boolean(meta?.streamKey || meta?.previewKey);

      return sendJson(res, 200, {
        ok: true,
        id: track.id,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        audioPath: hasAudio ? 'ready' : '',
        lyrics: normalizeLyrics(track.lyrics),
        albumTracks
      });
    }

    // ═══════════════════════════════════════════════════════════
    // 2. ÁLBUM INDIVIDUAL
    // ═══════════════════════════════════════════════════════════
    if (albumId) {
      if (!validUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });

      const [album] = await db.select(albumFields()).from(schema.albums)
        .where(and(eq(schema.albums.id, albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await getTracksPublic([album.id]);
      return sendJson(res, 200, { ok: true, album, tracks });
    }

    // ═══════════════════════════════════════════════════════════
    // 3. HOME
    // ═══════════════════════════════════════════════════════════
    const albums = await getAlbumsPublic();
    const albumIds = albums.map(a => a.id);
    const tracks = await getTracksPublic(albumIds);

    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = filterPublicContent(row.data);
    } catch (err) {
      console.warn('[public] site_content indisponível:', err.message);
    }

    // ── Planos (falha isolada + validação + ordenação determinística) ─
    let plans = [];
    let plansError = false;
    try {
      const raw = await db.select({
        id: schema.plans.id,
        name: schema.plans.name,
        priceCents: schema.plans.priceCents,
        currency: schema.plans.currency,
        intervalUnit: schema.plans.intervalUnit,
        intervalCount: schema.plans.intervalCount
      }).from(schema.plans)
        .where(eq(schema.plans.active, true))
        .orderBy(asc(schema.plans.priceCents), asc(schema.plans.createdAt), asc(schema.plans.id));

      plans = raw.map(normalizePlan).filter(Boolean);
    } catch (err) {
      console.error('[public] Falha ao buscar planos:', err.message);
      plansError = true;
    }

    // ── Aluguéis (falha isolada + validação + ordenação determinística) ─
    let rentalPlans = [];
    let rentalsError = false;
    try {
      const products = await db.select({
        id: schema.rentalProducts.id,
        trackId: schema.rentalProducts.trackId,
        albumId: schema.rentalProducts.albumId,
        name: schema.rentalProducts.name,
        durationHours: schema.rentalProducts.durationHours,
        priceCents: schema.rentalProducts.priceCents,
        currency: schema.rentalProducts.currency
      }).from(schema.rentalProducts)
        .where(eq(schema.rentalProducts.active, true))
        .orderBy(
          asc(schema.rentalProducts.sortOrder),
          asc(schema.rentalProducts.durationHours),
          asc(schema.rentalProducts.id)
        );

      const validTracks = new Set(tracks.map(t => t.id));
      const validAlbums = new Set(albumIds);

      rentalPlans = products
        .filter(p => {
          const hasT = Boolean(p.trackId);
          const hasA = Boolean(p.albumId);
          if (hasT === hasA) return false;
          return hasT ? validTracks.has(p.trackId) : validAlbums.has(p.albumId);
        })
        .map(p => {
          const name = typeof p.name === 'string' ? p.name.trim() : '';
          const currency = typeof p.currency === 'string' ? p.currency.trim().toUpperCase() : 'BRL';
          const hours = Number(p.durationHours);
          const cents = Number(p.priceCents);

          if (!name || name.length > 120) return null;
          if (!/^[A-Z]{3}$/.test(currency)) return null;
          if (!Number.isSafeInteger(hours) || hours <= 0) return null;
          if (!Number.isSafeInteger(cents) || cents <= 0) return null;

          return {
            id: p.id, label: name,
            days: Math.floor(hours / 24), hours: hours % 24,
            durationHours: hours, price: cents / 100, priceCents: cents,
            currency, available: true,
            trackId: p.trackId || null, albumId: p.albumId || null
          };
        })
        .filter(Boolean);
    } catch (err) {
      console.error('[public] Falha ao buscar aluguéis:', err.message);
      rentalsError = true;
    }

    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans,
      plansError,
      rentalsError
    });

  } catch (err) {
    console.error('[public] Erro crítico:', err.message);
    return sendJson(res, 500, { ok: false, error: 'CATALOG_UNAVAILABLE' });
  }
};