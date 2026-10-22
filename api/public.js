/* ============================================================
   API: /api/public — Catálogo público e Metadados do Player
   ============================================================ */

const { eq, desc, asc } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, albums, artists, plans, rentalProducts } = require('../src/schema.js');

// Função auxiliar para garantir que a URL da capa seja sempre pública
function getPublicCoverUrl(coverUrl, albumSlug) {
  if (!coverUrl) {
    return `https://f005.backblazeb2.com/file/joseph.matthos/assets/img/${albumSlug || 'default'}.webp`;
  }
  // Se já for uma URL completa, retorna como está
  if (coverUrl.startsWith('http')) {
    return coverUrl;
  }
  // Se for apenas o caminho, monta a URL do B2
  return `https://f005.backblazeb2.com/file/joseph.matthos/${coverUrl.replace(/^\/+/, '')}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ============================================
    // ROTA DO PLAYER: METADADOS DA FAIXA E LETRA
    // ============================================
    if (req.query.track) {
      const trackId = req.query.track;

      const trackResult = await db
        .select({
          id: tracks.id,
          title: tracks.title,
          durationSeconds: tracks.durationSeconds,
          trackNumber: tracks.trackNumber,
          albumId: tracks.albumId,
          albumTitle: albums.title,
          albumSlug: albums.slug,
          coverUrl: albums.coverUrl,
          artistName: artists.name,
          lyrics: tracks.lyrics, // JSONB: [{ time, text }]
        })
        .from(tracks)
        .leftJoin(albums, eq(tracks.albumId, albums.id))
        .leftJoin(artists, eq(tracks.artistId, artists.id))
        .where(eq(tracks.id, trackId))
        .limit(1);

      if (trackResult.length === 0) {
        return res.status(404).json({ ok: false, error: 'Faixa não encontrada' });
      }

      const track = trackResult[0];
      const finalCoverUrl = getPublicCoverUrl(track.coverUrl, track.albumSlug);

      const albumTracksResult = await db
        .select({
          id: tracks.id,
          title: tracks.title,
          durationSeconds: tracks.durationSeconds,
          trackNumber: tracks.trackNumber,
          status: tracks.status,
        })
        .from(tracks)
        .where(eq(tracks.albumId, track.albumId))
        .orderBy(asc(tracks.trackNumber));

      const albumTracksFormatted = albumTracksResult.map(t => ({
        id: t.id,
        title: t.title,
        durationSeconds: t.durationSeconds,
        duration: t.durationSeconds
          ? `${Math.floor(t.durationSeconds / 60)}:${String(t.durationSeconds % 60).padStart(2, '0')}`
          : '--:--',
        locked: t.status !== 'PUBLISHED',
      }));

      return res.status(200).json({
        ok: true,
        id: track.id,
        title: track.title,
        artist: track.artistName || 'Joseph Matthos',
        albumTitle: track.albumTitle || 'Álbum',
        coverUrl: finalCoverUrl,
        lyrics: track.lyrics || [],
        albumTracks: albumTracksFormatted,
      });
    }

    // ============================================
    // CATÁLOGO COMPLETO (SITE)
    // ============================================
    const albumsRaw = await db
      .select({
        id: albums.id, title: albums.title, slug: albums.slug, releaseDate: albums.releaseDate,
        coverUrl: albums.coverUrl, sortOrder: albums.sortOrder, upc: albums.upc,
        artistId: albums.artistId, artistName: artists.name, artistSlug: artists.slug,
      })
      .from(albums)
      .leftJoin(artists, eq(albums.artistId, artists.id))
      .orderBy(asc(albums.sortOrder), desc(albums.releaseDate));

    const tracksRaw = await db
      .select({
        id: tracks.id, title: tracks.title, slug: tracks.slug, durationSeconds: tracks.durationSeconds,
        trackNumber: tracks.trackNumber, albumId: tracks.albumId, albumTitle: albums.title,
        albumSlug: albums.slug, coverUrl: albums.coverUrl, artistId: tracks.artistId,
        artistName: artists.name, status: tracks.status,
      })
      .from(tracks)
      .leftJoin(albums, eq(tracks.albumId, albums.id))
      .leftJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(tracks.status, 'PUBLISHED'))
      .orderBy(asc(tracks.albumId), asc(tracks.trackNumber));

    let plansRaw = [];
    try {
      plansRaw = await db.select().from(plans).where(eq(plans.active, true));
    } catch (err) { console.warn('[public] planos indisponíveis:', err.message); }

    let rentalRaw = [];
    try {
      rentalRaw = await db.select().from(rentalProducts).where(eq(rentalProducts.active, true)).orderBy(asc(rentalProducts.sortOrder));
    } catch (err) { console.warn('[public] aluguéis indisponíveis:', err.message); }

    const tracksByAlbum = new Map();
    for (const t of tracksRaw) {
      if (!t.albumId) continue;
      if (!tracksByAlbum.has(t.albumId)) tracksByAlbum.set(t.albumId, []);
      tracksByAlbum.get(t.albumId).push({
        id: t.id, title: t.title, slug: t.slug, durationSeconds: t.durationSeconds,
        trackNumber: t.trackNumber, trackIndex: t.trackNumber, coverUrl: getPublicCoverUrl(t.coverUrl, t.albumSlug),
      });
    }

    const albumsWithTracks = albumsRaw.map((a) => {
      const albumTracks = tracksByAlbum.get(a.id) || [];
      return {
        id: a.id, title: a.title, slug: a.slug, year: a.releaseDate ? String(a.releaseDate).slice(0, 4) : '',
        releaseDate: a.releaseDate, coverUrl: getPublicCoverUrl(a.coverUrl, a.slug), coverImage: getPublicCoverUrl(a.coverUrl, a.slug),
        coverInitials: a.title ? a.title.charAt(0) : '♪', type: 'album',
        artistId: a.artistId, artistName: a.artistName, artistSlug: a.artistSlug, tracks: albumTracks,
      };
    });

    const plansNormalized = plansRaw.map((p) => ({
      id: p.id, name: p.name, priceCents: p.priceCents, currency: p.currency,
      interval: p.intervalUnit === 'MONTH' ? 'month' : p.intervalUnit === 'YEAR' ? 'year' : p.intervalUnit === 'DAY' ? 'day' : null,
      intervalCount: p.intervalCount, available: true,
    }));

    const rentalNormalized = rentalRaw.map((r) => {
      const hours = r.durationHours || 24;
      const days = Math.max(1, Math.floor(hours / 24));
      return {
        id: r.id, label: r.name, days, hours, price: (r.priceCents || 0) / 100, priceCents: r.priceCents,
        popular: false, available: r.active !== false && (r.priceCents || 0) > 0, trackId: r.trackId, albumId: r.albumId,
      };
    });

    const tracksPublic = tracksRaw.map(({ ...rest }) => rest);

    return res.status(200).json({
      ok: true, content: null, albums: albumsWithTracks, tracks: tracksPublic,
      plans: plansNormalized, rentalPlans: rentalNormalized,
      stats: {
        totalAlbums: albumsWithTracks.length, totalTracks: tracksRaw.length,
        totalPlans: plansNormalized.length, totalRentals: rentalNormalized.length,
      },
    });
  } catch (error) {
    console.error('Erro em /api/public:', error);
    return res.status(500).json({ ok: false, error: 'Erro ao buscar catálogo', message: error.message });
  }
};