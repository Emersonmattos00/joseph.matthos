'use strict';

/* ============================================================
   api/public.js — Catálogo público seguro
   ------------------------------------------------------------
   - Usa tracks.status === 'PUBLISHED' como fonte de verdade
   - NÃO expõe chaves de armazenamento B2 (streamKey/previewKey)
   - Consulta plans e rentalProducts (com fallback para content)
   - Compatível com banco antigo (sem durationSeconds/coverInitials)
   - Remove CORS wildcard
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/* ─── Campos públicos ────────────────────────────────────── */

function publicTrackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    duration: schema.tracks.duration,       // campo antigo
    durationSeconds: schema.tracks.durationSeconds, // campo novo (se existir)
    locked: schema.tracks.locked
    // ❌ NÃO retornar: streamKey, previewKey, fullPath, previewPath
  };
}

function publicAlbumFields() {
  return {
    id: schema.albums.id,
    title: schema.albums.title,
    slug: schema.albums.slug,
    artist: schema.albums.artist,           // campo antigo
    artistId: schema.albums.artistId,
    releaseDate: schema.albums.releaseDate,
    year: schema.albums.year,
    type: schema.albums.type,
    description: schema.albums.description,
    coverUrl: schema.albums.coverUrl,       // campo novo
    coverInitials: schema.albums.coverInitials,
    sortOrder: schema.albums.sortOrder,
    published: schema.albums.published
    // ❌ NÃO retornar: nada privado
  };
}

/* ─── Fallback seguro (banco antigo) ──────────────────────── */

async function selectTracksPublic(albumIds) {
  const fields = publicTrackFields();
  const attempt = async (fieldsToUse) => {
    let q = db.select(fieldsToUse).from(schema.tracks);
    if (albumIds && albumIds.length) {
      q = q.where(and(
        eq(schema.tracks.status, 'PUBLISHED'),
        inArray(schema.tracks.albumId, albumIds)
      ));
    } else {
      q = q.where(eq(schema.tracks.status, 'PUBLISHED'));
    }
    return q.orderBy(asc(schema.tracks.trackNumber));
  };

  try {
    return await attempt(fields);
  } catch (err) {
    // Fallback: schema sem durationSeconds/locked
    console.warn('[public] fallback de campos de tracks:', err.message);
    return await attempt({
      id: schema.tracks.id,
      albumId: schema.tracks.albumId,
      title: schema.tracks.title,
      trackNumber: schema.tracks.trackNumber,
      duration: schema.tracks.duration
    });
  }
}

async function selectAlbumsPublic() {
  const attempt = async (fieldsToUse) => {
    return db.select(fieldsToUse).from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));
  };
  try {
    return await attempt(publicAlbumFields());
  } catch (err) {
    console.warn('[public] fallback de campos de albums:', err.message);
    return await attempt({
      id: schema.albums.id,
      title: schema.albums.title,
      slug: schema.albums.slug,
      coverUrl: schema.albums.coverUrl,
      year: schema.albums.year,
      published: schema.albums.published
    });
  }
}

/* ─── Planos e alugueis ───────────────────────────────────── */

async function getPublicPlans() {
  try {
    return await db.select({
      id: schema.plans.id,
      name: schema.plans.name,
      priceCents: schema.plans.priceCents,
      currency: schema.plans.currency,
      intervalUnit: schema.plans.intervalUnit,
      intervalCount: schema.plans.intervalCount
    }).from(schema.plans).where(eq(schema.plans.active, true));
  } catch (err) {
    console.warn('[public] plans indisponíveis:', err.message);
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
    }).from(schema.rentalProducts)
      .where(eq(schema.rentalProducts.active, true));

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
    console.warn('[public] rentalProducts indisponíveis, usando content:', err.message);
    return []; // fallback feito abaixo
  }
}

/* ─── Handler ────────────────────────────────────────────── */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // ❌ Removido: Access-Control-Allow-Origin: *

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
    // ── 1. Faixa individual
    if (trackId) {
      if (!validUuid(trackId)) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });
      }

      const [track] = await db.select({
        id: schema.tracks.id,
        albumId: schema.tracks.albumId,
        title: schema.tracks.title,
        lyrics: schema.tracks.lyrics,
        status: schema.tracks.status
      }).from(schema.tracks)
        .where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.status, 'PUBLISHED')))
        .limit(1);

      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const [album] = await selectAlbumsPublic().then(rows =>
        rows.filter(a => a.id === track.albumId).slice(0, 1)
      );

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

    // ── 2. Álbum individual
    if (albumId) {
      if (!validUuid(albumId)) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });
      }

      const albums = await selectAlbumsPublic();
      const album = albums.find(a => a.id === albumId);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await selectTracksPublic([album.id]);

      return sendJson(res, 200, { ok: true, album, tracks });
    }

    // ── 3. Catálogo completo
    const albums = await selectAlbumsPublic();
    const albumIds = albums.map(a => a.id);
    const tracks = albumIds.length ? await selectTracksPublic(albumIds) : [];

    // Aninha tracks
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
        .from(schema.siteContent)
        .where(eq(schema.siteContent.key, 'default'))
        .limit(1);
      if (row?.data) content = row.data;
    } catch (err) {
      console.warn('[public] site_content indisponível:', err.message);
    }

    // Planos e alugueis
    const plans = await getPublicPlans();
    let rentalPlans = await getPublicRentalPlans(albumIds, tracks.map(t => t.id));

    // Fallback: se rentalProducts estiver vazio, usa o content
    if (!rentalPlans.length && Array.isArray(content.rentalPlans)) {
      rentalPlans = content.rentalPlans;
    }

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