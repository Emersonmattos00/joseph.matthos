/* ============================================================
   api/public.js — Catálogo público (Versão Final Auditada)
   ------------------------------------------------------------
   Correções aplicadas (Etapa 9):
   - ok: true em todas as respostas
   - artist (campo real do schema), não artistName
   - lyrics validada como array
   - Não expõe fullPath/streamKey/previewPath
   - rentalPlans inclui label (usado pelo frontend)
   - Filtra faixas de álbuns não publicados
   - Validação de UUID
   - Cache privado por requisição
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function publicTrack(track) {
  return {
    id: track.id,
    albumId: track.albumId,
    title: track.title,
    trackNumber: track.trackNumber,
    durationSeconds: track.durationSeconds,
    locked: Boolean(track.locked),
    published: Boolean(track.published)
  };
}

function publicAlbum(album, tracks = []) {
  return {
    id: album.id,
    title: album.title,
    slug: album.slug,
    artist: album.artist || 'Joseph Matthos',
    artistId: album.artistId,
    releaseDate: album.releaseDate,
    year: album.year,
    type: album.type,
    description: album.description,
    coverUrl: album.coverUrl,
    coverInitials: album.coverInitials,
    tracks
  };
}

function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    currency: plan.currency,
    intervalUnit: plan.intervalUnit,
    intervalCount: plan.intervalCount,
    available: plan.active
  };
}

function publicRentalProduct(product) {
  return {
    id: product.id,
    name: product.name,
    label: product.name,            // ★ frontend usa `label`
    trackId: product.trackId,
    albumId: product.albumId,
    durationHours: product.durationHours,
    hours: product.durationHours,
    days: Math.max(1, Math.ceil(product.durationHours / 24)),
    priceCents: product.priceCents,
    price: product.priceCents / 100,
    currency: product.currency,
    available: product.active
  };
}

module.exports = async function publicApi(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
  }

  const trackId = req.query?.track ? String(req.query.track) : null;
  const albumId = req.query?.album ? String(req.query.album) : null;

  try {
    // ── 1. Faixa específica (Player) ──
    if (trackId) {
      if (!validUuid(trackId)) {
        return sendJson(res, 400, { ok: false, error: 'Identificador de faixa inválido.' });
      }

      const [track] = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.published, true)))
        .limit(1);

      if (!track || !track.albumId) {
        return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });
      }

      const [album] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, track.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) {
        return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
      }

      const tracks = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.albumId, album.id), eq(schema.tracks.published, true)))
        .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, {
        ok: true,
        id: track.id,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        lyrics: Array.isArray(track.lyrics) ? track.lyrics : [],
        albumTracks: tracks.map(publicTrack)
      });
    }

    // ── 2. Álbum específico ──
    if (albumId) {
      if (!validUuid(albumId)) {
        return sendJson(res, 400, { ok: false, error: 'Identificador de álbum inválido.' });
      }

      const [album] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!album) {
        return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });
      }

      const tracks = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.albumId, album.id), eq(schema.tracks.published, true)))
        .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, {
        ok: true,
        album: publicAlbum(album, tracks.map(publicTrack)),
        tracks: tracks.map(publicTrack)
      });
    }

    // ── 3. Catálogo geral (Home) ──
    const [albums, allTracks, plans, rentalProducts, contentRows] = await Promise.all([
      db.select().from(schema.albums)
        .where(eq(schema.albums.published, true))
        .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt)),

      db.select().from(schema.tracks)
        .where(eq(schema.tracks.published, true))
        .orderBy(asc(schema.tracks.trackNumber)),

      db.select().from(schema.plans)
        .where(eq(schema.plans.active, true)),

      db.select().from(schema.rentalProducts)
        .where(eq(schema.rentalProducts.active, true))
        .orderBy(asc(schema.rentalProducts.sortOrder)),

      db.select().from(schema.siteContent)
        .where(eq(schema.siteContent.key, 'default'))
        .limit(1)
    ]);

    const publishedAlbumIds = new Set(albums.map(a => String(a.id)));
    const visibleTracks = allTracks.filter(t =>
      t.albumId && publishedAlbumIds.has(String(t.albumId))
    );

    const albumsWithTracks = albums.map(album => publicAlbum(
      album,
      visibleTracks
        .filter(t => String(t.albumId) === String(album.id))
        .map(publicTrack)
    ));

    return sendJson(res, 200, {
      ok: true,
      content: contentRows[0]?.data || {},
      albums: albumsWithTracks,
      tracks: visibleTracks.map(publicTrack),
      plans: plans.map(publicPlan),
      rentalPlans: rentalProducts.map(publicRentalProduct)
    });

  } catch (error) {
    console.error('[public] Erro no catálogo:', { message: error.message, code: error.code });
    return sendJson(res, 500, { ok: false, error: 'Não foi possível carregar o catálogo.' });
  }
};