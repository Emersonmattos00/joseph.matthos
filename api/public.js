'use strict';

/* ============================================================
   api/public.js — Catálogo público seguro e blindado
   ------------------------------------------------------------
   - Tolera banco antigo (published=true) e novo (status='PUBLISHED')
   - Previne desaparecimento de álbuns por falta de innerJoin
   - Não expõe chaves privadas de armazenamento (B2)
   - Mantém estrutura de planos, alugueis e conteúdo do site
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray, or } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/* ─── Seletores de Campos (Proteção contra vazamento) ────── */

function publicTrackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    duration: schema.tracks.duration,
    durationSeconds: schema.tracks.durationSeconds, // Se existir, traz
    locked: schema.tracks.locked
    // ❌ streamKey, previewKey, fullPath, previewPath NUNCA
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
    sortOrder: schema.albums.sortOrder,
    published: schema.albums.published
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

/* ─── Blindagem de Busca (Evita erro se a coluna não existir) ── */

async function selectAlbumsPublic() {
  try {
    return await db.select(publicAlbumFields())
      .from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));
  } catch (err) {
    console.warn('[public] Fallback álbuns (schema antigo):', err.message);
    return await db.select().from(schema.albums).where(eq(schema.albums.published, true));
  }
}

async function selectTracksPublic(albumIds) {
  if (!albumIds || albumIds.length === 0) return [];
  
  // 🛡️ Blindagem: Aceita status='PUBLISHED' ou published=true
  const condition = and(
    or(
      eq(schema.tracks.status, 'PUBLISHED'),
      eq(schema.tracks.published, true)
    ),
    inArray(schema.tracks.albumId, albumIds)
  );

  try {
    return await db.select(publicTrackFields())
      .from(schema.tracks)
      .where(condition)
      .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber));
  } catch (err) {
    console.warn('[public] Fallback faixas (schema antigo):', err.message);
    return await db.select().from(schema.tracks).where(condition);
  }
}

async function getPublicPlans() {
  try {
    return await db.select(publicPlanFields()).from(schema.plans).where(eq(schema.plans.active, true));
  } catch (err) {
    console.warn('[public] Plans indisponíveis:', err.message);
    return [];
  }
}

async function getPublicRentalPlans(albumIds, trackIds) {
  try {
    const products = await db.select({
      id: schema.rentalProducts.id,
      trackId: schema.rentalProducts.trackId,
      albumId: schema.rentalProducts.albumId,
      name: schema.rentalProducts.name,
      durationHours: schema.rentalProducts.durationHours,
      priceCents: schema.rentalProducts.priceCents,
      currency: schema.rentalProducts.currency
    }).from(schema.rentalProducts).where(eq(schema.rentalProducts.active, true));

    const albumSet = new Set(albumIds);
    const trackSet = new Set(trackIds);

    return products
      .filter(p => {
        const hasT = Boolean(p.trackId);
        const hasA = Boolean(p.albumId);
        if (hasT === hasA) return false;
        if (hasT) return trackSet.has(p.trackId);
        return albumSet.has(p.albumId);
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
  } catch (err) {
    console.warn('[public] rentalProducts indisponíveis:', err.message);
    return [];
  }
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
    // ── 1. Faixa individual ────────────────────────────────
    if (trackId) {
      if (!validUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });

      const [track] = await db.select({
        id: schema.tracks.id,
        albumId: schema.tracks.albumId,
        title: schema.tracks.title,
        lyrics: schema.tracks.lyrics,
        status: schema.tracks.status,
        published: schema.tracks.published
      }).from(schema.tracks)
        .where(and(
          eq(schema.tracks.id, trackId),
          or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
        )).limit(1);

      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const albums = await selectAlbumsPublic();
      const album = albums.find(a => a.id === track.albumId);

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

      const albums = await selectAlbumsPublic();
      const album = albums.find(a => a.id === albumId);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await selectTracksPublic([album.id]);
      return sendJson(res, 200, { ok: true, album, tracks });
    }

    // ── 3. Home: catálogo completo ─────────────────────────
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

    // Conteúdo do site
    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (err) {
      console.warn('[public] site_content indisponível:', err.message);
    }

    // Planos e alugueis
    const plans = await getPublicPlans();
    let rentalPlans = await getPublicRentalPlans(albumIds, tracks.map(t => t.id));
    if (!rentalPlans.length && Array.isArray(content.rentalPlans)) {
      rentalPlans = content.rentalPlans;
    }

    // ── 4. Retorno final ───────────────────────────────────
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans
    });

  } catch (error) {
    console.error('[public] Erro:', error.code || error.message);
    return sendJson(res, 500, {
      ok: false,
      error: 'CATALOG_UNAVAILABLE',
      message: 'Não foi possível carregar o catálogo.'
    });
  }
};