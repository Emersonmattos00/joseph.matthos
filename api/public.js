cat > api/public.js << 'EOF'
const { eq, desc } = require('drizzle-orm');
const { db } = require('./_db');
const { tracks, albums, artists } = require('../src/schema.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Listar faixas publicadas com dados do álbum e artista
    const result = await db
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
      })
      .from(tracks)
      .leftJoin(albums, eq(tracks.albumId, albums.id))
      .leftJoin(artists, eq(tracks.artistId, artists.id))
      .where(eq(tracks.status, 'PUBLISHED'))
      .orderBy(desc(tracks.createdAt))
      .limit(200);

    return res.status(200).json({ tracks: result });
  } catch (error) {
    console.error('Erro em /api/public:', error);
    return res.status(500).json({ error: 'Erro ao buscar catálogo' });
  }
};
EOF