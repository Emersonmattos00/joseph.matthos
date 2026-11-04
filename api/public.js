/* ============================================================
   api/public.js — Catálogo público (Versão Final Corrigida)
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Controle de Cache: permite cache na borda por 1 minuto
  res.setHeader('Cache-Control', 'public, max-age=60');
  
  // Configuração básica de CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const { track, album } = req.query;

  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    // ── 1. Retorna faixa específica (Player) ──────────────────
    if (track) {
      const [trackRow] = await db.select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.id, track),
            eq(schema.tracks.published, true)
          )
        ).limit(1);

      if (!trackRow) {
        return sendJson(res, 404, { ok: false, error: 'Faixa não encontrada ou não publicada.' });
      }

      const [albumRow] = await db.select()
        .from(schema.albums)
        .where(
          and(
            eq(schema.albums.id, trackRow.albumId),
            eq(schema.albums.published, true)
          )
        ).limit(1);

      if (!albumRow) {
        return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado ou não publicado.' });
      }

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

      return sendJson(res, 200, {
        ok: true,
        id: trackRow.id,
        title: trackRow.title,
        artist: albumRow.artistName || 'Joseph Matthos',
        albumTitle: albumRow.title,
        coverUrl: albumRow.coverUrl,
        audioPath: trackRow.fullPath || trackRow.previewPath,
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

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'Álbum não encontrado.' });

      const tracks = await db.select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.albumId, albumRow.id),
            eq(schema.tracks.published, true)
          )
        ).orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, { ok: true, album: albumRow, tracks });
    }

    // ── 3. Home: contrato completo esperado pelo frontend ─────
    const albums = await db.select()
      .from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));

    const albumIds = albums.map(a => a.id);
    let tracks = [];
    if (albumIds.length > 0) {
      tracks = await db.select({
        id: schema.tracks.id,
        albumId: schema.tracks.albumId,
        title: schema.tracks.title,
        trackNumber: schema.tracks.trackNumber,
        durationSeconds: schema.tracks.durationSeconds,
        locked: schema.tracks.locked,
      })
      .from(schema.tracks)
      .where(and(
        eq(schema.tracks.published, true),
        inArray(schema.tracks.albumId, albumIds)
      ))
      .orderBy(asc(schema.tracks.trackNumber));
    }

    let content = {};
    try {
      const [row] = await db.select().from(schema.siteContent)
        .where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (e) {
      console.warn('[public] site_content indisponível:', e.message);
    }

    // ★ NOVO: Busca os planos de assinatura e aluguel do banco
    let plans = [];
    let rentalPlans = [];
    
    try {
      const planRows = await db.select().from(schema.plans).where(eq(schema.plans.active, true));
      plans = planRows.map(p => ({
        id: p.id,
        name: p.name,
        price: p.priceCents / 100,
        priceCents: p.priceCents,
        interval: p.intervalUnit === 'MONTH' ? 'month' : 'year',
        available: true
      }));

      const rentalRows = await db.select().from(schema.rentalProducts).where(eq(schema.rentalProducts.active, true));
      rentalPlans = rentalRows.map(r => ({
        id: r.id,
        label: r.name,
        days: Math.ceil(r.durationHours / 24),
        hours: r.durationHours,
        price: r.priceCents / 100,
        priceCents: r.priceCents,
        available: true,
        trackId: r.trackId,
        albumId: r.albumId
      }));
    } catch (err) {
      console.warn('[public] Erro ao carregar planos:', err.message);
    }

    return sendJson(res, 200, {
      ok: true,
      content,
      albums,
      tracks,
      plans,
      rentalPlans,
    });

  } catch (err) {
    console.error('[public] Erro na API:', err);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no catálogo.' });
  }
};