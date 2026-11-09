'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray, or, sql } = require('./_db');
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
    // 1. Busca TODOS os álbuns da tabela (sem filtro primeiro, para garantir que não está vazia)
    let albums = [];
    try {
      albums = await db.select().from(schema.albums);
      console.log(`[public] Álbuns encontrados na tabela: ${albums.length}`);
      
      // Filtra manualmente os publicados (caso a coluna published esteja nula para alguns)
      albums = albums.filter(a => a.published === true || a.published === null);
    } catch (err) {
      console.error('[public] Erro ao buscar álbuns:', err.message);
      return sendJson(res, 500, { ok: false, error: 'Erro ao buscar álbuns no banco.', details: err.message });
    }

    const albumIds = albums.map(a => a.id);
    let tracks = [];

    // 2. Busca as faixas (Blindado: aceita status PUBLISHED ou published true)
    if (albumIds.length > 0) {
      try {
        // Tenta achar por status ou published
        tracks = await db.select().from(schema.tracks)
          .where(and(
            inArray(schema.tracks.albumId, albumIds),
            or(
              eq(schema.tracks.status, 'PUBLISHED'),
              eq(schema.tracks.published, true)
            )
          ));
        console.log(`[public] Faixas encontradas (via status/published): ${tracks.length}`);
      } catch (err) {
        console.warn('[public] Erro na busca híbrida de faixas, buscando sem filtro...', err.message);
        try {
          tracks = await db.select().from(schema.tracks).where(inArray(schema.tracks.albumId, albumIds));
          console.log(`[public] Faixas encontradas (sem filtro de status): ${tracks.length}`);
        } catch (err2) {
          console.error('[public] Erro crítico ao buscar faixas:', err2.message);
        }
      }
    }

    // 3. Agrupa as faixas dentro dos álbuns
    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }

    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    // 4. Busca conteúdo do site, planos e alugueis
    let content = {};
    try {
      const [row] = await db.select().from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (e) { }

    let plans = [];
    try { plans = await db.select().from(schema.plans).where(eq(schema.plans.active, true)); } catch (e) { }
    
    const rentalPlans = Array.isArray(content.rentalPlans) ? content.rentalPlans : [];

    // 5. Retorna tudo
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans
    });

  } catch (error) {
    console.error('[public] Erro não tratado:', error);
    return sendJson(res, 500, { ok: false, error: 'Erro interno.', details: error.message });
  }
};