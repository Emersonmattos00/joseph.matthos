'use strict';

/* ============================================================
   api/public.js — Catálogo Público (Versão Final Blindada)
   ------------------------------------------------------------
   - SEM fallback com select() sem campos (evita vazar B2)
   - Falhas retornam HTTP 500 em vez de listas vazias
   - Regra única: usa tracks.status = 'PUBLISHED'
   - Consulta plans e rentalProducts com ordenação
   - Faixa individual busca álbum direto pelo ID
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function publicTrackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    duration: schema.tracks.duration,
    locked: schema.tracks.locked
    // ❌ NÃO incluir: streamKey, previewKey, fullPath, previewPath
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

// ── Busca segura, sem fallback cego ─────────────────────────
async function selectAlbumsPublic() {
  return db.select(publicAlbumFields()).from(schema.albums)
    .where(eq(schema.albums.published, true))
    .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));
}

async function selectTracksPublic(albumIds) {
  if (!Array.isArray(albumIds) || albumIds.length === 0) return [];
  return db.select(publicTrackFields()).from(schema.tracks)
    .where(and(
      eq(schema.tracks.status, 'PUBLISHED'),
      inArray(schema.tracks.albumId, albumIds)
    ))
    .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber), asc(schema.tracks.createdAt));
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
    .orderBy(asc(schema.rentalProducts.durationHours));

  const albumSet = new Set(albumIds);
  const trackSet = new Set(trackIds);

  return products
    .filter(p => {
      const hasT = Boolean(p.trackId);
      const hasA = Boolean(p.albumId);
      if (hasT === hasA) return false;
      return hasT ? trackSet.has(p.trackId) : albumSet.has(p.albumId);
    })
    .map(p => {
      const hours = Number(p.durationHours);
      const cents = Number(p.priceCents);
      if (!Number.isSafeInteger(hours) || hours <= 0) return null;
      if (!Number.isSafeInteger(cents) || cents <= 0) return null;
      return {
        id: p.id,
        label: p.name,
        days: Math.floor(hours / 24),
        hours: hours % 24,
        durationHours: hours,
        price: cents / 100,
        priceCents: cents,
        currency: p.currency || 'BRL',
        available: true,
        trackId: p.trackId || null,
        albumId: p.albumId || null
      };
    })
    .filter(Boolean);
}

// ── Handler ────────────────────────────────────────────────
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
    // ── 1. Faixa individual ────────────────────────────────
    if (trackId) {
      if (!validUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });

      const [track] = await db.select({
        id: schema.tracks.id,
        albumId: schema.tracks.albumId,
        title: schema.tracks.title,
        lyrics: schema.tracks.lyrics
      }).from(schema.tracks)
        .where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.status, 'PUBLISHED')))
        .limit(1);

      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const [album] = await db.select(publicAlbumFields()).from(schema.albums)
        .where(and(eq(schema.albums.id, track.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const albumTracks = await selectTracksPublic([album.id]);

      return sendJson(res, 200, {
        ok: true,
        id: track.id,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        lyrics: Array.isArray(track.lyrics) ? track.lyrics : [],
        albumTracks
      });
    }

    // ── 2. Álbum individual ────────────────────────────────
    if (albumId) {
      if (!validUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });

      const [album] = await db.select(publicAlbumFields()).from(schema.albums)
        .where(and(eq(schema.albums.id, albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await selectTracksPublic([album.id]);
      return sendJson(res, 200, { ok: true, album, tracks });
    }

    // ── 3. Catálogo ────────────────────────────────────────
    const albums = await selectAlbumsPublic();
    const albumIds = albums.map(a => a.id);
    const tracks = await selectTracksPublic(albumIds);

    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    // ── 4. Conteúdo ────────────────────────────────────────
    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row?.data) content = row.data;
    } catch (err) {
      console.warn('[public] site_content indisponível:', err.message);
      // conteúdo é opcional; não falha o catálogo
    }

    // ── 5. Planos e alugueis ───────────────────────────────
    const plans = await getPublicPlans();
    const rentalPlans = await getPublicRentalPlans(albumIds, tracks.map(t => t.id));

    // ── 6. Resposta final ──────────────────────────────────
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans
    });

  } catch (error) {
    // Falha real de banco → 500 (não mascara com listas vazias)
    console.error('[public] Erro:', error.code || error.message);
    return sendJson(res, 500, {
      ok: false,
      error: 'CATALOG_UNAVAILABLE',
      message: 'Não foi possível carregar o catálogo.'
    });
  }
};