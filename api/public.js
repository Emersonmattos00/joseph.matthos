/* ============================================================
   API: /api/public — Catálogo público
   Retorna: content, albums, tracks, plans, rentalPlans
   ============================================================ */

const { eq, desc, asc } = require('drizzle-orm');
const { db } = require('./_db');
const {
  tracks,
  albums,
  artists,
  plans,
  rentalProducts,
} = require('../src/schema.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ============================================
    // 1. BUSCAR ÁLBUNS COM ARTISTA
    // ============================================
    const albumsRaw = await db
      .select({
        id: albums.id,
        title: albums.title,
        slug: albums.slug,
        releaseDate: albums.releaseDate,
        coverUrl: albums.coverUrl,
        sortOrder: albums.sortOrder,
        upc: albums.upc,
        artistId: albums.artistId,
        artistName: artists.name,
        artistSlug: artists.slug,
      })
      .from(albums)
      .leftJoin(artists, eq(albums.artistId, artists.id))
      .orderBy(asc(albums.sortOrder), desc(albums.releaseDate));

    // ============================================
    // 2. BUSCAR FAIXAS PUBLICADAS
    // ============================================
    const tracksRaw = await db
      .select({
        id: tracks.id,
        title: tracks.title,
        slug: tracks.slug,
        durationSeconds: tracks.durationSeconds,
        trackNumber: tracks.trackNumber,
        albumId: tracks.albumId,
        albumTitle: albums.title,
        albumSlug: albums.slug,
        coverUrl: albums.coverUrl,
        artistId: tracks.artistId,
        artistName: artists.name,
        status: tracks.status,
        streamKey: tracks.streamKey,
        previewKey: tracks.previewKey,
      })
      .from(tracks)
      .leftJoin(albums, eq(tracks.albumId, albums.id))
      .leftJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(tracks.status, 'PUBLISHED'))
      .orderBy(asc(tracks.albumId), asc(tracks.trackNumber));

    // ============================================
    // 3. BUSCAR PLANOS ATIVOS
    // ============================================
    let plansRaw = [];
    try {
      plansRaw = await db
        .select()
        .from(plans)
        .where(eq(plans.active, true));
    } catch (err) {
      console.warn('[public] planos indisponíveis:', err.message);
    }

    // ============================================
    // 4. BUSCAR PRODUTOS DE ALUGUEL ATIVOS
    // ============================================
    let rentalRaw = [];
    try {
      rentalRaw = await db
        .select()
        .from(rentalProducts)
        .where(eq(rentalProducts.active, true))
        .orderBy(asc(rentalProducts.sortOrder));
    } catch (err) {
      console.warn('[public] aluguéis indisponíveis:', err.message);
    }

    // ============================================
    // 5. MONTAR ÁLBUNS COM FAIXAS AGRUPADAS
    // ============================================
    const tracksByAlbum = new Map();
    for (const t of tracksRaw) {
      if (!t.albumId) continue;
      if (!tracksByAlbum.has(t.albumId)) tracksByAlbum.set(t.albumId, []);
      tracksByAlbum.get(t.albumId).push({
        id: t.id,
        title: t.title,
        slug: t.slug,
        durationSeconds: t.durationSeconds,
        trackNumber: t.trackNumber,
        trackIndex: t.trackNumber, // compatibilidade com o frontend
        coverUrl: t.coverUrl,
        streamKey: t.streamKey,
        previewKey: t.previewKey,
      });
    }

    const albumsWithTracks = albumsRaw.map((a) => {
      const albumTracks = tracksByAlbum.get(a.id) || [];
      return {
        id: a.id,
        title: a.title,
        slug: a.slug,
        year: a.releaseDate ? String(a.releaseDate).slice(0, 4) : '',
        releaseDate: a.releaseDate,
        coverUrl: a.coverUrl,
        coverImage: a.coverUrl, // compatibilidade
        coverInitials: a.title ? a.title.charAt(0) : '♪',
        type: 'album',
        artistId: a.artistId,
        artistName: a.artistName,
        artistSlug: a.artistSlug,
        tracks: albumTracks,
      };
    });

    // ============================================
    // 6. NORMALIZAR PLANOS (formato do frontend)
    // ============================================
    const plansNormalized = plansRaw.map((p) => ({
      id: p.id,
      name: p.name,
      priceCents: p.priceCents,
      currency: p.currency,
      interval: p.intervalUnit === 'MONTH' ? 'month'
              : p.intervalUnit === 'YEAR'  ? 'year'
              : p.intervalUnit === 'DAY'   ? 'day'
              : null,
      intervalCount: p.intervalCount,
      available: true,
    }));

    // ============================================
    // 7. NORMALIZAR ALUGUÉIS
    // ============================================
    const rentalNormalized = rentalRaw.map((r) => {
      const hours = r.durationHours || 24;
      const days = Math.max(1, Math.floor(hours / 24));
      return {
        id: r.id,
        label: r.name,
        days,
        hours,
        price: (r.priceCents || 0) / 100,
        priceCents: r.priceCents,
        popular: false,
        available: r.active !== false && (r.priceCents || 0) > 0,
        trackId: r.trackId,
        albumId: r.albumId,
      };
    });

    // ============================================
    // 8. RESPOSTA FINAL
    // ============================================
    return res.status(200).json({
      ok: true,
      content: null, // o site.js usa DEFAULT_CONTENT
      albums: albumsWithTracks,
      tracks: tracksRaw,
      plans: plansNormalized,
      rentalPlans: rentalNormalized,
      stats: {
        totalAlbums: albumsWithTracks.length,
        totalTracks: tracksRaw.length,
        totalPlans: plansNormalized.length,
        totalRentals: rentalNormalized.length,
      },
    });
  } catch (error) {
    console.error('Erro em /api/public:', error);
    return res.status(500).json({
      ok: false,
      error: 'Erro ao buscar catálogo',
      message: error.message,
    });
  }
};