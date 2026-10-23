'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, or, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

module.exports = async (req, res) => {
  // ✅ Força a API a NUNCA usar cache
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { track, album } = req.query;

  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // 1. Faixa específica
    if (track) {
      const [trackRow] = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.id, track), eq(schema.tracks.published, true)))
        .limit(1);

      if (!trackRow) return sendJson(res, 404, { error: 'Faixa não encontrada.' });

      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, trackRow.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { error: 'Álbum não encontrado.' });

      const albumTracks = await db.select({
        id: schema.tracks.id, title: schema.tracks.title, trackNumber: schema.tracks.trackNumber,
        durationSeconds: schema.tracks.durationSeconds, locked: schema.tracks.locked
      })
      .from(schema.tracks)
      .where(and(eq(schema.tracks.albumId, albumRow.id), eq(schema.tracks.published, true)))
      .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, {
        id: trackRow.id, title: trackRow.title, artist: albumRow.artistName || 'Joseph Matthos',
        albumTitle: albumRow.title, coverUrl: albumRow.coverUrl, audioPath: trackRow.fullPath || trackRow.previewPath,
        lyrics: trackRow.lyrics || [], albumTracks
      });
    }

    // 2. Álbum específico
    if (album) {
      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, album), eq(schema.albums.published, true)))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { error: 'Álbum não encontrado.' });

      const tracks = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.albumId, albumRow.id), eq(schema.tracks.published, true)))
        .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, { album: albumRow, tracks });
    }

    // 3. Lista todos os álbuns
    const albums = await db.select()
      .from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));

    return sendJson(res, 200, { albums });

  } catch (err) {
    console.error('[public_v2] Erro:', err);
    return sendJson(res, 500, { error: 'Erro interno no catálogo.' });
  }
};