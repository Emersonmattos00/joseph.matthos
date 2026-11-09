'use strict';

/* ============================================================
   api/public.js — Catálogo público seguro
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray, or } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/* ─── Seletores de Campos Públicos ────────────────────────── */

function publicTrackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    duration: schema.tracks.duration,
    durationSeconds: schema.tracks.durationSeconds,
    locked: schema.tracks.locked
    // Nunca expor streamKey, previewKey, fullPath, previewPath
  };
}

function publicAlbumFields() {
  return {
    id: schema.albums.id,
    title: schema.albums.title,
    slug: schema.albums.slug,
    artist: schema.albums.artist,
    artistId: schema.albums.artistId,
    releaseDate: schema.albums.releaseDate,
    year: schema.albums.year,
    type: schema.albums.type,
    description: schema.albums.description,
    coverUrl: schema.albums.coverUrl,
    coverInitials: schema.albums.coverInitials,
    sortOrder: schema.albums.sortOrder
  };
}

function publicPlanFields() {
  return {
    id: schema.plans.id,
    name: schema.plans.name,
    priceCents: schema.plans.priceCents,
    currency: schema.plans.currency,
    intervalUnit: schema.plans.intervalUnit,
    intervalCount: schema.plans.intervalCount
  };
}

function publicRentalPlan(product) {
  const hours = Number(product.durationHours);
  const cents = Number(product.priceCents);

  if (
    !Number.isSafeInteger(hours) ||
    hours <= 0 ||
    !Number.isSafeInteger(cents) ||
    cents <= 0
  ) {
    return null;
  }

  return {
    id: product.id,
    label: product.name,
    days: Math.floor(hours / 24),
    hours: hours % 24,
    durationHours: hours,
    price: cents / 100,
    priceCents: cents,
    currency: product.currency || 'BRL',
    popular: false,
    available: true,
    trackId: product.trackId || null,
    albumId: product.albumId || null
  };
}

/* ─── Buscas de Banco de Dados ────────────────────────────── */

async function getPublishedTrack(trackId) {
  const [track] = await db.select().from(schema.tracks)
    .where(and(
      eq(schema.tracks.id, trackId),
      // ★ BLINDAGEM: Aceita o status novo OU o published antigo
      or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
    ))
    .limit(1);
  return track || null;
}

async function getPublishedAlbum(albumId) {
  if (!albumId) return null;
  const [album] = await db.select(publicAlbumFields()).from(schema.albums)
    .where(eq(schema.albums.id, albumId))
    .limit(1);
  return album || null;
}

async function getPublishedAlbumTracks(albumId) {
  return db.select(publicTrackFields()).from(schema.tracks)
    .where(and(
      eq(schema.tracks.albumId, albumId),
      or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
    ))
    .orderBy(asc(schema.tracks.trackNumber), asc(schema.tracks.createdAt));
}

async function getPublicPlans() {
  return db.select(publicPlanFields()).from(schema.plans)
    .where(eq(schema.plans.active, true))
    .orderBy(asc(schema.plans.priceCents), asc(schema.plans.createdAt));
}

async function getPublicRentalPlans(albumIds, trackIds) {
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
    .orderBy(asc(schema.rentalProducts.sortOrder), asc(schema.rentalProducts.durationHours));

  const albumSet = new Set(albumIds);
  const trackSet = new Set(trackIds);

  return products
    .filter(product => {
      const hasTrack = Boolean(product.trackId);
      const hasAlbum = Boolean(product.albumId);
      if (hasTrack === hasAlbum) return false;
      if (hasTrack) return trackSet.has(product.trackId);
      return albumSet.has(product.albumId);
    })
    .map(publicRentalPlan)
    .filter(Boolean);
}

/* ─── Handler Principal ───────────────────────────────────── */

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
    // ========================================================
    // 1. Faixa específica — contrato do player
    // ========================================================
    if (trackId) {
      if (!validUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });

      const track = await getPublishedTrack(trackId);
      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const album = await getPublishedAlbum(track.albumId);
      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const albumTracks = await getPublishedAlbumTracks(album.id);

      return sendJson(res, 200, {
        ok: true,
        id: track.id,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        audioPath: track.streamKey || track.previewKey,
        lyrics: Array.isArray(track.lyrics) ? track.lyrics : [],
        albumTracks
      });
    }

    // ========================================================
    // 2. Álbum específico
    // ========================================================
    if (albumId) {
      if (!validUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });

      const album = await getPublishedAlbum(albumId);
      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await getPublishedAlbumTracks(album.id);

      return sendJson(res, 200, { ok: true, album, tracks });
    }

    // ========================================================
    // 3. Catálogo da página inicial (Blindado)
    // ========================================================
    let albums = await db.select(publicAlbumFields()).from(schema.albums);
    albums = albums
      .filter(a => a.published === true || a.published === null)
      .sort((a, b) => {
        const orderA = a.sortOrder || 0;
        const orderB = b.sortOrder || 0;
        if (orderA !== orderB) return orderA - orderB;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });

    const albumIds = albums.map(album => album.id);
    let tracks = [];

    if (albumIds.length > 0) {
      tracks = await db.select(publicTrackFields()).from(schema.tracks)
        .where(and(
          or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true)),
          inArray(schema.tracks.albumId, albumIds)
        ))
        .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber), asc(schema.tracks.createdAt));
    }

    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    
    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    // ========================================================
    // 4. Conteúdo editável do site
    // ========================================================
    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data && typeof row.data === 'object') {
        content = row.data;
      }
    } catch (error) {
      console.warn('[public] site_content indisponível:', error.code || error.message);
    }

    // ========================================================
    // 5. Planos e produtos de aluguel
    // ========================================================
    const plans = await getPublicPlans();
    const publishedTrackIds = tracks.map(track => track.id);
    
    let rentalPlans = await getPublicRentalPlans(albumIds, publishedTrackIds);

    // Fallback para os aluguéis salvos no site_content
    if (!rentalPlans.length && Array.isArray(content.rentalPlans)) {
      rentalPlans = content.rentalPlans;
    }

    // ========================================================
    // 6. Resposta pública
    // ========================================================
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans
    });

  } catch (error) {
    console.error('[public] Erro no catálogo:', error.code || error.message);
    return sendJson(res, 500, {
      ok: false,
      error: 'CATALOG_UNAVAILABLE',
      message: 'Não foi possível carregar o catálogo.'
    });
  }
};