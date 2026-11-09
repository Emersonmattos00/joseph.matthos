'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray, or } = require('./_db');
const schema = require('./_db').schema;

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

module.exports = async (req, res) => {
  setHeaders(res);

  if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });

  try {
    // ── 1. ÁLBUNS E FAIXAS (Blindado para não desaparecer) ───
    let albums = [];
    try {
      albums = await db.select().from(schema.albums);
      albums = albums
        .filter(a => a.published === true || a.published === null)
        .sort((a, b) => {
          const orderA = a.sortOrder || 0;
          const orderB = b.sortOrder || 0;
          if (orderA !== orderB) return orderA - orderB;
          return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
        });
    } catch (err) {
      console.error('[public] Erro ao buscar álbuns:', err.message);
      return sendJson(res, 500, { ok: false, error: 'Erro ao buscar álbuns.' });
    }

    const albumIds = albums.map(a => a.id);
    let tracks = [];

    if (albumIds.length > 0) {
      try {
        tracks = await db.select().from(schema.tracks)
          .where(and(
            inArray(schema.tracks.albumId, albumIds),
            or(eq(schema.tracks.status, 'PUBLISHED'), eq(schema.tracks.published, true))
          ))
          .orderBy(asc(schema.tracks.trackNumber));
      } catch (err) {
        tracks = await db.select().from(schema.tracks).where(inArray(schema.tracks.albumId, albumIds));
        tracks.sort((a, b) => (a.trackNumber || 0) - (b.trackNumber || 0));
      }
    }

    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    const albumsWithTracks = albums.map(a => ({ ...a, tracks: byAlbum.get(a.id) || [] }));

    // ── 2. CONTEÚDO DO SITE (Onde ficavam os preços antigos) ─
    let content = {};
    try {
      const [row] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (e) { }

    // ── 3. PLANOS (Assinatura) ───────────────────────────────
    // Busca na tabela 'plans'. Se estiver vazia, usa o content.
    let plans = [];
    try { 
      plans = await db.select().from(schema.plans).where(eq(schema.plans.active, true)); 
    } catch (e) { }
    
    // Fallback: Se o banco não tem planos, tenta pegar do content (padrão antigo)
    if (!plans.length && Array.isArray(content.planos?.plans)) {
      plans = content.planos.plans;
    }

    // ── 4. ALUGUÉIS (Restauração) ────────────────────────────
    // Puxa os alugueis exatamente como a versão que estava funcionando
    let rentalPlans = [];
    try {
      const products = await db.select().from(schema.rentalProducts).where(eq(schema.rentalProducts.active, true));
      const validTracks = new Set(tracks.map(t => t.id));
      const validAlbums = new Set(albumIds);

      rentalPlans = products
        .filter(p => {
          if (p.trackId) return validTracks.has(p.trackId);
          if (p.albumId) return validAlbums.has(p.albumId);
          return false;
        })
        .map(p => {
          const hours = Number(p.durationHours) || 24;
          const cents = Number(p.priceCents) || 0;
          return {
            id: p.id,
            label: p.name,
            days: Math.floor(hours / 24),
            hours: hours % 24,
            durationHours: hours,
            price: cents / 100,
            priceCents: cents,
            currency: p.currency || 'BRL',
            available: true,
            trackId: p.trackId || null,
            albumId: p.albumId || null
          };
        });
    } catch (e) { }

    // ★ A CORREÇÃO AQUI: Se o banco de rentalProducts falhou ou está vazio,
    // puxa do content.rentalPlans (que é o que fazia aparecer antes!)
    if (!rentalPlans.length && Array.isArray(content.rentalPlans)) {
      rentalPlans = content.rentalPlans;
    }

    // ── 5. RESPOSTA ──────────────────────────────────────────
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans
    });

  } catch (error) {
    console.error('[public] Erro Crítico:', error);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no catálogo.' });
  }
};