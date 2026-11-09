/* ============================================================
   api/public.js — Catálogo Público (Versão Híbrida Definitiva)
   ------------------------------------------------------------
   - Mantém a busca pelo schema antigo (published: true) para 
     não quebrar os dados que já estavam no banco.
   - Garante o aninhamento (albums -> tracks) para o painel de playlists.
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const { track, album } = req.query;

  try {
    // ── 1. Retorna faixa específica (Player) ──────────────────
    if (track) {
      const [trackRow] = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.id, track), eq(schema.tracks.published, true)))
        .limit(1);

      if (!trackRow) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada ou não publicada.' });

      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, trackRow.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado ou não publicado.' });

      const albumTracks = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.albumId, albumRow.id), eq(schema.tracks.published, true)))
        .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, {
        ok: true,
        id: trackRow.id,
        title: trackRow.title,
        artist: albumRow.artistName || albumRow.artist || 'Joseph Matthos',
        albumTitle: albumRow.title,
        coverUrl: albumRow.coverUrl,
        audioPath: trackRow.streamKey || trackRow.previewKey,
        lyrics: trackRow.lyrics || [],
        albumTracks
      });
    }

    // ── 2. Retorna álbum específico ───────────────────────────
    if (album) {
      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, album), eq(schema.albums.published, true)))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

      const tracks = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.albumId, albumRow.id), eq(schema.tracks.published, true)))
        .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, { ok: true, album: albumRow, tracks });
    }

    // ── 3. Home: contrato completo esperado pelo frontend ─────
    // Busca os álbuns que estão publicados (compatível com o schema antigo)
    const albums = await db.select()
      .from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));

    const albumIds = albums.map(a => a.id);
    let tracks = [];

    if (albumIds.length > 0) {
      // Busca todas as faixas publicadas desses álbuns
      tracks = await db.select()
        .from(schema.tracks)
        .where(and(
          eq(schema.tracks.published, true),
          inArray(schema.tracks.albumId, albumIds)
        ))
        .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber));
    }

    // Aninha as faixas dentro de cada álbum (necessário para o playlists.js)
    const tracksByAlbum = new Map();
    for (const t of tracks) {
      if (!tracksByAlbum.has(t.albumId)) tracksByAlbum.set(t.albumId, []);
      tracksByAlbum.get(t.albumId).push(t);
    }

    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: tracksByAlbum.get(a.id) || []
    }));

    // Busca o conteúdo do site (textos, imagens, etc)
    let content = {};
    try {
      const [row] = await db.select().from(schema.siteContent)
        .where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (e) {
      console.warn('[public] site_content indisponível:', e.message);
    }

    // Retorna a estrutura que o site.js espera
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,  // Álbuns com faixas aninhadas
      tracks: tracks,            // Array global (compatibilidade)
      plans: [],
      rentalPlans: [],
    });

  } catch (err) {
    console.error('[public] Erro na API:', err);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no catálogo.' });
  }
};