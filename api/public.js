'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  
  try {
    // Tenta buscar todos os álbuns, sem filtro nenhum
    const albums = await db.select().from(schema.albums).limit(5);
    
    // Tenta buscar todas as faixas, sem filtro
    const tracks = await db.select().from(schema.tracks).limit(5);

    return sendJson(res, 200, {
      ok: true,
      message: 'DIAGNÓSTICO: buscando sem filtros',
      albumsCount: albums.length,
      tracksCount: tracks.length,
      sampleAlbums: albums,
      sampleTracks: tracks
    });
  } catch (error) {
    return sendJson(res, 500, {
      ok: false,
      error: 'ERRO NO BANCO',
      details: error.message,
      code: error.code,
      hint: error.hint,
      table: error.table
    });
  }
};