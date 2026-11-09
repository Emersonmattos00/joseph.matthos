/* ============================================================
   api/public.js — Catálogo público (Versão Definitiva e Blindada)
   ------------------------------------------------------------
   - Mantém o contrato antigo (audioPath, previewPath, fullPath)
   - Blindagem de álbuns (não desaparecem se a tabela estiver inconsistente)
   - Restaura planos e aluguéis que o site.js espera
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray, or } = require('./_db');
const schema = require('./_db').schema;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { track, album } = req.query;

  try {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    }

    // ── 1. Retorna faixa específica (Player) ──────────────────
    if (track) {
      // Blindagem: aceita published=true ou status=PUBLISHED
      const [trackRow] = await db.select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.id, track),
            or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
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
        locked: schema.tracks.locked,
        previewPath: schema.tracks.previewKey,
        fullPath: schema.tracks.streamKey
      })
      .from(schema.tracks)
      .where(
        and(
          eq(schema.tracks.albumId, albumRow.id),
          or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
        )
      )
      .orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, {
        ok: true,
        id: trackRow.id,
        title: trackRow.title,
        artist: albumRow.artistName || albumRow.artist || 'Joseph Matthos',
        albumTitle: albumRow.title,
        coverUrl: albumRow.coverUrl || albumRow.cover_image,
        audioPath: trackRow.streamKey || trackRow.previewKey,
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
            or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
          )
        ).orderBy(asc(schema.tracks.trackNumber));

      return sendJson(res, 200, { ok: true, album: albumRow, tracks });
    }

    // ── 3. Home: contrato completo esperado pelo frontend ─────
    
    // ★ BLINDAGEM: Tenta buscar todos e ordenar no JS (evita quebrar se sortOrder faltar)
    let albums = await db.select().from(schema.albums);
    albums = albums
      .filter(a => a.published === true || a.published === null)
      .sort((a, b) => {
        const orderA = a.sortOrder || 0;
        const orderB = b.sortOrder || 0;
        if (orderA !== orderB) return orderA - orderB;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });

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
        previewPath: schema.tracks.previewKey,
        fullPath: schema.tracks.streamKey
      })
      .from(schema.tracks)
      .where(and(
        or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true)),
        inArray(schema.tracks.albumId, albumIds)
      ))
      .orderBy(asc(schema.tracks.trackNumber));
    }

    // Agrupa as faixas nos álbuns (para o site.js não quebrar)
    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    
    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    // Busca conteúdo
    let content = {};
    try {
      const [row] = await db.select().from(schema.siteContent)
        .where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (e) { }

    // ★ RESTAURAÇÃO DOS PLANOS E ALUGUÉIS
    let plans = [];
    try { plans = await db.select().from(schema.plans).where(eq(schema.plans.active, true)); } catch (e) { }
    if (!plans.length && Array.isArray(content.planos?.plans)) plans = content.planos.plans;

    let rentalPlans = [];
    try {
      const products = await db.select().from(schema.rentalProducts).where(eq(schema.rentalProducts.active, true));
      rentalPlans = products.map(p => ({
        id: p.id, label: p.name, days: Math.floor((p.durationHours||24)/24), hours: (p.durationHours||24)%24,
        durationHours: p.durationHours||24, price: (p.priceCents||0)/100, priceCents: p.priceCents||0,
        currency: p.currency || 'BRL', available: true, trackId: p.trackId || null, albumId: p.albumId || null
      }));
    } catch (e) { }
    if (!rentalPlans.length && Array.isArray(content.rentalPlans)) rentalPlans = content.rentalPlans;

    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,  // Para a home não sumir
      tracks,                    // Compatibilidade
      plans,                     // Preços de Assinatura
      rentalPlans                // Preços de Aluguel
    });

  } catch (err) {
    console.error('[public] Erro na API:', err);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no catálogo.' });
  }
};