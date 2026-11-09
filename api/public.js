/* ============================================================
   api/public.js — Catálogo Público (Versão Final Híbrida)
   ------------------------------------------------------------
   - Restaura busca de planos (assinatura) e alugueis para o site
   - Mantém compatibilidade com banco antigo (published: true)
   - Aninha faixas nos álbuns para o painel de playlists
   - Validações de segurança e cache
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
}

function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const id = String(value).trim();
  if (!id || id.length > 128) return null;
  return id;
}

module.exports = async (req, res) => {
  setHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const trackId = normalizeId(req.query?.track);
  const albumId = normalizeId(req.query?.album);

  if ((req.query?.track != null && !trackId) || (req.query?.album != null && !albumId)) {
    return sendJson(res, 400, { ok: false, error: 'Parâmetro inválido.' });
  }
  if (trackId && albumId) {
    return sendJson(res, 400, { ok: false, error: 'Informe apenas uma consulta por vez.' });
  }

  try {
    // ── 1. FAIXA INDIVIDUAL (Player / Modal) ─────────────────
    if (trackId) {
      const [trackRow] = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.id, trackId), eq(schema.tracks.published, true)))
        .limit(1);

      if (!trackRow) return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada.' });

      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, trackRow.albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

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

    // ── 2. ÁLBUM INDIVIDUAL ──────────────────────────────────
    if (albumId) {
      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(and(eq(schema.albums.id, albumId), eq(schema.albums.published, true)))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

      const tracks = await db.select()
        .from(schema.tracks)
        .where(and(eq(schema.tracks.albumId, albumRow.id), eq(schema.tracks.published, true)))
        .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, { ok: true, album: albumRow, tracks });
    }

    // ── 3. HOME: CATÁLOGO COMPLETO ───────────────────────────
    
    // Álbuns (compatível com banco antigo)
    const albums = await db.select()
      .from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));

    const albumIds = albums.map(a => a.id);
    let tracks = [];

    if (albumIds.length > 0) {
      // Faixas (compatível com banco antigo)
      tracks = await db.select()
        .from(schema.tracks)
        .where(and(
          eq(schema.tracks.published, true),
          inArray(schema.tracks.albumId, albumIds)
        ))
        .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber));
    }

    // Aninha as faixas nos álbuns (necessário para o painel de playlists)
    const tracksByAlbum = new Map();
    for (const t of tracks) {
      if (!tracksByAlbum.has(t.albumId)) tracksByAlbum.set(t.albumId, []);
      tracksByAlbum.get(t.albumId).push(t);
    }

    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: tracksByAlbum.get(a.id) || []
    }));

    // Conteúdo do site (textos, imagens, etc)
    let content = {};
    try {
      const [row] = await db.select().from(schema.siteContent)
        .where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (e) {
      console.warn('[public] site_content indisponível:', e.message);
    }

    // ★ RESTAURAÇÃO: Planos Comerciais (Assinatura)
    let plans = [];
    try {
      plans = await db.select().from(schema.plans).where(eq(schema.plans.active, true));
    } catch (e) {
      console.warn('[public] planos indisponíveis:', e.message);
    }

    // ★ RESTAURAÇÃO: Planos de Aluguel
    const rentalPlans = Array.isArray(content.rentalPlans) ? content.rentalPlans : [];

    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,       // <-- Devolve os preços de assinatura
      rentalPlans, // <-- Devolve os preços de aluguel
    });

  } catch (err) {
    console.error('[public] Erro na API:', err);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no catálogo.' });
  }
};