'use strict';

/* ============================================================
   api/public.js — Catálogo Público (Versão Final — Encerrada)
   ------------------------------------------------------------
   - safeColor() rejeita entradas > 30 chars (sem truncar)
   - ipv4FromMappedIpv6() valida cada octeto com isIP
   - normalizeLyrics() aceita letras sem timestamp (modo texto)
   - audioPath: 'ready' preservado (player usa /api/stream)
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const { isIP } = require('node:net');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

/* ─── Helpers ────────────────────────────────────────────── */

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function toFiniteNumber(v) {
  if (typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeString(v, max = 500) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

function safeColor(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || s.length > 30) return '';

  if (/^#[0-9a-f]{3}$/i.test(s)) return s;
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{8}$/i.test(s)) return s;

  const rgb = s.match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
  if (rgb) {
    const [r, g, b] = rgb.slice(1).map(Number);
    return r <= 255 && g <= 255 && b <= 255 ? s : '';
  }

  const rgba = s.match(/^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+)\s*\)$/i);
  if (rgba) {
    const [r, g, b, a] = rgba.slice(1).map(Number);
    return r <= 255 && g <= 255 && b <= 255 && a <= 1 ? s : '';
  }

  return '';
}

/* ─── IP / URL ───────────────────────────────────────────── */

function stripBrackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
}

function ipv4FromMappedIpv6(raw) {
  if (!raw.startsWith('::ffff:')) return null;
  const suffix = raw.slice(7);

  let result = null;

  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(suffix)) {
    result = suffix;
  } else {
    const hex = suffix.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      result = [
        (hi >> 8) & 255,
        hi & 255,
        (lo >> 8) & 255,
        lo & 255
      ].join('.');
    }
  }

  return result && isIP(result) === 4 ? result : null;
}

function isPrivateHost(hostname) {
  const raw = stripBrackets(hostname);
  if (!raw) return true;

  if (raw === 'localhost' || raw.endsWith('.localhost')) return true;

  const mapped = ipv4FromMappedIpv6(raw);
  if (mapped) return isPrivateHost(mapped);

  if (isIP(raw) === 4) {
    const m = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return true;
    const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 198 && b >= 18 && b <= 19) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 255) return true;
    if (a >= 224) return true;
    return false;
  }

  if (isIP(raw) === 6) {
    if (raw === '::' || raw === '::1') return true;
    if (raw.startsWith('fc') || raw.startsWith('fd')) return true;
    if (raw.startsWith('fe8') || raw.startsWith('fe9') || raw.startsWith('fea') || raw.startsWith('feb')) return true;
    if (raw.startsWith('fec') || raw.startsWith('fed') || raw.startsWith('fee') || raw.startsWith('fef')) return true;
    if (raw.startsWith('ff')) return true;
    return false;
  }

  return false;
}

function safeUrl(v, max = 500) {
  if (typeof v !== 'string') return '';
  const value = v.trim();
  if (!value || value.length > max) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!url.hostname || url.username || url.password) return '';
    if (isPrivateHost(url.hostname)) return '';
    const normalized = url.href;
    return normalized.length <= max ? normalized : '';
  } catch {
    return '';
  }
}

function safeInt(v, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = toFiniteNumber(v);
  return n !== null && Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/* ─── Projeções ──────────────────────────────────────────── */

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

/* ─── Sanitizadores ──────────────────────────────────────── */

function sanitizeBranding(b) {
  if (!isPlainRecord(b)) return {};
  return {
    nameParts: isPlainRecord(b.nameParts) ? {
      first: safeString(b.nameParts.first, 60),
      accent: safeString(b.nameParts.accent, 60)
    } : { first: '', accent: '' },
    footer: safeString(b.footer, 300),
    bgImage: safeUrl(b.bgImage, 1000),
    meta: isPlainRecord(b.meta) ? {
      title: safeString(b.meta.title, 200),
      description: safeString(b.meta.description, 300)
    } : { title: '', description: '' }
  };
}

function sanitizeHero(h) {
  if (!isPlainRecord(h)) return {};
  return {
    title: safeString(h.title, 200),
    subtitle: safeString(h.subtitle, 500),
    primaryBtn: isPlainRecord(h.primaryBtn) ? {
      text: safeString(h.primaryBtn.text, 60),
      link: safeUrl(h.primaryBtn.link, 500)
    } : { text: '', link: '' },
    secondaryBtn: isPlainRecord(h.secondaryBtn) ? {
      text: safeString(h.secondaryBtn.text, 60)
    } : { text: '' }
  };
}

function sanitizeSobre(s) {
  if (!isPlainRecord(s)) return {};
  return {
    title: safeString(s.title, 200),
    subtitle: safeString(s.subtitle, 300),
    paragraphs: safeString(s.paragraphs, 10000),
    quote: safeString(s.quote, 300),
    image: safeUrl(s.image, 1000)
  };
}

function sanitizeFilosofia(f) {
  if (!isPlainRecord(f)) return {};
  const frases = Array.isArray(f.frases)
    ? f.frases.slice(0, 500)
        .filter(x => isPlainRecord(x))
        .map(x => ({
          text: safeString(x.text, 500),
          author: safeString(x.author, 120)
        }))
        .filter(x => x.text)
    : [];
  return {
    title: safeString(f.title, 200),
    subtitle: safeString(f.subtitle, 300),
    frases
  };
}

function sanitizeDiscografia(d) {
  if (!isPlainRecord(d)) return {};
  return {
    title: safeString(d.title, 200),
    subtitle: safeString(d.subtitle, 300)
  };
}

function sanitizePlanosVisuais(p) {
  if (!isPlainRecord(p)) return {};
  const plans = Array.isArray(p.plans)
    ? p.plans.slice(0, 10)
        .filter(x => isPlainRecord(x))
        .map(x => ({
          id: safeString(x.id, 40),
          name: safeString(x.name, 80),
          desc: safeString(x.desc, 300),
          badge: safeString(x.badge, 40),
          cta: safeString(x.cta, 60),
          suffix: safeString(x.suffix, 20),
          featured: x.featured === true,
          disabled: x.disabled === true,
          features: Array.isArray(x.features)
            ? x.features.slice(0, 30)
                .filter(f => isPlainRecord(f))
                .map(f => ({ text: safeString(f.text, 160), ok: f.ok !== false }))
            : []
        }))
        .filter(x => x.id && x.name)
    : [];
  return {
    title: safeString(p.title, 200),
    subtitle: safeString(p.subtitle, 300),
    plans
  };
}

function sanitizeSocials(raw) {
  if (!Array.isArray(raw)) return [];
  const valid = new Set(['spotify','youtube','amazon','facebook','tiktok','apple','audiomack','deezer','soundcloud','instagram','x']);
  return raw.slice(0, 20)
    .filter(s => isPlainRecord(s) && typeof s.network === 'string' && valid.has(s.network))
    .map(s => ({
      network: s.network,
      label: safeString(s.label, 80),
      url: safeUrl(s.url, 500)
    }))
    .filter(s => s.url);
}

function sanitizeContato(c) {
  if (!isPlainRecord(c)) return {};
  return {
    title: safeString(c.title, 200),
    subtitle: safeString(c.subtitle, 300),
    heading: safeString(c.heading, 200),
    description: safeString(c.description, 500),
    socials: sanitizeSocials(c.socials)
  };
}

function sanitizePlaylists(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 100)
    .filter(p => isPlainRecord(p))
    .map(p => {
      const cover = safeString(p.cover, 500).trim();
      return {
        id: safeString(p.id, 80),
        title: safeString(p.title, 120),
        description: safeString(p.description, 300),
        cover: /^https?:\/\//i.test(cover) ? safeUrl(cover, 500) : (safeString(cover, 10) || '♪'),
        tracks: Array.isArray(p.tracks)
          ? p.tracks.slice(0, 500)
              .filter(t =>
                (typeof t === 'string' && t.trim() !== '') ||
                (typeof t === 'number' && Number.isSafeInteger(t))
              )
              .map(String)
          : []
      };
    })
    .filter(p => p.id.trim() && p.title.trim());
}

function sanitizeAparencia(a) {
  if (!isPlainRecord(a)) return {};
  return {
    bg: safeColor(a.bg),
    accent: safeColor(a.accent),
    text: safeColor(a.text),
    accentDark: safeColor(a.accentDark),
    border: safeColor(a.border)
  };
}

function sanitizeRentalPlansVisual(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50)
    .filter(p => isPlainRecord(p))
    .map(p => {
      const days = safeInt(p.days, 0, 365) ?? 0;
      const hours = safeInt(p.hours, 0, 23) ?? 0;
      if (days * 24 + hours <= 0) return null;

      const priceCents = safeInt(p.priceCents, 1);
      if (priceCents === null) return null;

      const currency = (safeString(p.currency, 3) || 'BRL').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) return null;

      return {
        id: safeString(p.id, 80),
        label: safeString(p.label, 120),
        days,
        hours,
        priceCents,
        price: priceCents / 100,
        currency,
        available: p.available !== false
      };
    })
    .filter(p => p && p.id && p.label);
}

function filterPublicContent(data) {
  if (!isPlainRecord(data)) return {};
  return {
    branding: sanitizeBranding(data.branding),
    hero: sanitizeHero(data.hero),
    sobre: sanitizeSobre(data.sobre),
    filosofia: sanitizeFilosofia(data.filosofia),
    discografia: sanitizeDiscografia(data.discografia),
    planos: sanitizePlanosVisuais(data.planos),
    contato: sanitizeContato(data.contato),
    playlists: sanitizePlaylists(data.playlists),
    aparencia: sanitizeAparencia(data.aparencia),
    rentalPlans: sanitizeRentalPlansVisual(data.rentalPlans)
  };
}

/* ─── Letras (aceita com ou sem timestamp) ───────────────── */

const MAX_LYRIC_TIME = 3600;

function normalizeTime(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '')) {
    return null;
  }
  const time = Number(value);
  if (!Number.isFinite(time) || time < 0 || time > MAX_LYRIC_TIME) return null;
  return time;
}

function normalizeLyrics(raw) {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try { return normalizeLyrics(JSON.parse(trimmed)); } catch { /* cai no modo texto */ }
    }
    // Modo texto: cada linha vira um item com time=null (frontend decide)
    return trimmed.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, 500)
      .map(text => ({ time: null, text: safeString(text, 500) }));
  }

  if (Array.isArray(raw)) {
    return raw.slice(0, 500)
      .filter(l => isPlainRecord(l))
      .map(l => ({
        time: normalizeTime(l.time),
        text: safeString(l.text, 500)
      }))
      .filter(l => l.text); // aceita time null (letra sem timestamp)
  }

  if (isPlainRecord(raw)) {
    if (Array.isArray(raw.lines)) return normalizeLyrics(raw.lines);
    if (Array.isArray(raw.verses)) return normalizeLyrics(raw.verses);
    if (typeof raw.text === 'string') return normalizeLyrics(raw.text);
  }
  return [];
}

/* ─── Planos ─────────────────────────────────────────────── */

const VALID_INTERVAL_UNITS = new Set(['day', 'month', 'year']);

function normalizePlan(raw) {
  if (!isPlainRecord(raw)) return null;
  if (!validUuid(raw.id)) return null;

  const name = safeString(raw.name, 120).trim();
  const currency = (safeString(raw.currency, 3) || '').toUpperCase();
  const intervalUnit = safeString(raw.intervalUnit, 20).toLowerCase();
  const priceCents = toFiniteNumber(raw.priceCents);
  const intervalCount = toFiniteNumber(raw.intervalCount);

  if (!name) return null;
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  if (!VALID_INTERVAL_UNITS.has(intervalUnit)) return null;
  if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents <= 0) return null;
  if (intervalCount === null || !Number.isSafeInteger(intervalCount) || intervalCount < 1) return null;

  return { id: raw.id, name, priceCents, currency, intervalUnit, intervalCount };
}

/* ─── Consultas ──────────────────────────────────────────── */

async function getAlbumsPublic() {
  return db.select(albumFields()).from(schema.albums)
    .where(eq(schema.albums.published, true))
    .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt), asc(schema.albums.id));
}

async function getTracksPublic(albumIds) {
  if (!Array.isArray(albumIds) || albumIds.length === 0) return [];
  return db.select(trackFields()).from(schema.tracks)
    .where(and(
      inArray(schema.tracks.albumId, albumIds),
      eq(schema.tracks.status, 'PUBLISHED')
    ))
    .orderBy(
      asc(schema.tracks.albumId),
      asc(schema.tracks.trackNumber),
      asc(schema.tracks.createdAt),
      asc(schema.tracks.id)
    );
}

/* ─── Handler ────────────────────────────────────────────── */

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

  if (trackId && albumId) return sendJson(res, 400, { ok: false, error: 'INVALID_QUERY' });

  try {
    if (trackId) {
      if (!validUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });

      const [track] = await db.select({
        ...trackFields(),
        lyrics: schema.tracks.lyrics,
        streamKey: schema.tracks.streamKey,
        previewKey: schema.tracks.previewKey
      }).from(schema.tracks)
        .where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.status, 'PUBLISHED')))
        .limit(1);

      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const [album] = await db.select(albumFields()).from(schema.albums)
        .where(and(eq(schema.albums.id, track.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const albumTracks = await getTracksPublic([album.id]);
      const hasAudio = Boolean(track.streamKey || track.previewKey);

      return sendJson(res, 200, {
        ok: true,
        id: track.id,
        albumId: track.albumId,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        trackNumber: track.trackNumber,
        durationSeconds: track.durationSeconds,
        locked: track.locked,
        audioPath: hasAudio ? 'ready' : '',
        lyrics: normalizeLyrics(track.lyrics),
        albumTracks
      });
    }

    if (albumId) {
      if (!validUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });

      const [album] = await db.select(albumFields()).from(schema.albums)
        .where(and(eq(schema.albums.id, albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await getTracksPublic([album.id]);
      return sendJson(res, 200, { ok: true, album, tracks });
    }

    const albums = await getAlbumsPublic();
    const albumIds = albums.map(a => a.id);
    const tracks = await getTracksPublic(albumIds);

    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    const albumsWithTracks = albums.map(a => ({ ...a, tracks: byAlbum.get(a.id) || [] }));

    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = filterPublicContent(row.data);
    } catch (err) {
      console.warn('[public] site_content indisponível:', err.message);
    }

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
          if (!validUuid(p.id)) return null;
          const name = safeString(p.name, 120).trim();
          const currency = (safeString(p.currency, 3) || 'BRL').toUpperCase();
          const hours = toFiniteNumber(p.durationHours);
          const cents = toFiniteNumber(p.priceCents);

          if (!name) return null;
          if (!/^[A-Z]{3}$/.test(currency)) return null;
          if (hours === null || !Number.isSafeInteger(hours) || hours <= 0) return null;
          if (cents === null || !Number.isSafeInteger(cents) || cents <= 0) return null;

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