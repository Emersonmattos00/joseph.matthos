/* ============================================================
   api/public.js — Catálogo público (Versão Final Corrigida)
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, or, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Controle de Cache: Deixa a Cloudflare/Vercel cachear o catálogo por 1 minuto
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  
  // Configuração básica de CORS (permite acesso do player)
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { track, album } = req.query;

  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // ── 1. Retorna faixa específica (Player) ──────────────────
    if (track) {
      const [trackRow] = await db.select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.id, track),
            eq(schema.tracks.published, true) // ⚠️ Garante que a faixa está publicada
          )
        ).limit(1);

      if (!trackRow) {
        return sendJson(res, 404, { error: 'Faixa não encontrada ou não publicada.' });
      }

      // Busca o Álbum da faixa para exibir no player (título, capa, etc)
      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(
          and(
            eq(schema.albums.id, trackRow.albumId),
            eq(schema.albums.published, true) // ⚠️ Garante que o álbum está publicado
          )
        ).limit(1);

      if (!albumRow) {
        return sendJson(res, 404, { error: 'Álbum não encontrado ou não publicado.' });
      }

      // Busca todas as faixas publicadas deste álbum para montar a lista do player
      const albumTracks = await db.select({
        id: schema.tracks.id,
        title: schema.tracks.title,
        trackNumber: schema.tracks.trackNumber,
        durationSeconds: schema.tracks.durationSeconds,
        locked: schema.tracks.locked
      })
      .from(schema.tracks)
      .where(
        and(
          eq(schema.tracks.albumId, albumRow.id),
          eq(schema.tracks.published, true)
        )
      )
      .orderBy(asc(schema.tracks.trackNumber));

      // Retorna a resposta exata que o player.js espera
      return sendJson(res, 200, {
        id: trackRow.id,
        title: trackRow.title,
        artist: albumRow.artistName || 'Joseph Matthos',
        albumTitle: albumRow.title,
        coverUrl: albumRow.coverUrl,
        audioPath: trackRow.fullPath || trackRow.previewPath, // Usado pela API de stream
        lyrics: trackRow.lyrics || [],
        albumTracks
      });
    }

    // ── 2. Retorna álbum específico ───────────────────────────
    if (album) {
      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(
          and(
            eq(schema.albums.id, album),
            eq(schema.albums.published, true)
          )
        ).limit(1);

      if (!albumRow) return sendJson(res, 404, { error: 'Álbum não encontrado.' });

      const tracks = await db.select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.albumId, albumRow.id),
            eq(schema.tracks.published, true)
          )
        ).orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, { album: albumRow, tracks });
    }

    // ── 3. Lista todos os álbuns publicados (Home) ────────────
    const albums = await db.select()
      .from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));

    return sendJson(res, 200, { albums });

  } catch (err) {
    console.error('[public] Erro na API:', err);
    return sendJson(res, 500, { error: 'Erro interno no catálogo.' });
  }
};