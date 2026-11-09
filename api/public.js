/* ============================================================
   api/public.js — Catálogo público Joseph Matthos
   ------------------------------------------------------------
   Versão revisada e integrada:
   - Catálogo público de álbuns e faixas
   - Consulta individual por UUID
   - Consulta individual de álbuns
   - Carregamento de planos ativos
   - Recuperação de planos de aluguel do conteúdo do site
   - Remoção de caminhos internos de armazenamento
   - Seleção explícita dos campos públicos
   - Ordenação determinística
   - Validação dos parâmetros
   - Tratamento de erros HTTP e banco de dados
   - Compatibilidade com player.js
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');

const {
  db,
  eq,
  and,
  asc,
  desc,
  inArray
} = require('./_db');

const schema = require('./_db').schema;

/* ============================================================
   CABEÇALHOS
   ============================================================ */

function setHeaders(res) {
  res.setHeader(
    'Cache-Control',
    'no-store, max-age=0, must-revalidate'
  );

  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/* ============================================================
   VALIDAÇÃO
   ============================================================ */

function normalizeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const id = String(value).trim();

  if (!id || id.length > 128) {
    return null;
  }

  return id;
}

/* ============================================================
   CAMPOS PÚBLICOS
   ============================================================ */

function albumFields() {
  return {
    id: schema.albums.id,
    title: schema.albums.title,
    slug: schema.albums.slug,
    coverUrl: schema.albums.coverUrl,
    releaseDate: schema.albums.releaseDate,
    year: schema.albums.year,
    type: schema.albums.type,
    description: schema.albums.description,
    artist: schema.albums.artist,
    sortOrder: schema.albums.sortOrder,
    createdAt: schema.albums.createdAt
  };
}

function trackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    durationSeconds: schema.tracks.durationSeconds,
    locked: schema.tracks.locked
  };
}

function trackPlayerFields() {
  return {
    id: schema.tracks.id,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    durationSeconds: schema.tracks.durationSeconds,
    locked: schema.tracks.locked
  };
}

/* ============================================================
   ORDENAÇÃO
   ============================================================ */

function trackOrdering() {
  return [
    asc(schema.tracks.trackNumber),
    asc(schema.tracks.createdAt),
    asc(schema.tracks.id)
  ];
}

/* ============================================================
   PLANOS
   ============================================================ */

async function getPublicPlans() {
  const rows = await db.select({
    id: schema.plans.id,
    name: schema.plans.name,
    priceCents: schema.plans.priceCents,
    currency: schema.plans.currency,
    intervalUnit: schema.plans.intervalUnit,
    intervalCount: schema.plans.intervalCount
  })
    .from(schema.plans)
    .where(eq(schema.plans.active, true));

  return rows;
}

/* ============================================================
   CONTEÚDO DO SITE
   ============================================================ */

async function getSiteContent() {
  try {
    const [row] = await db.select({
      data: schema.siteContent.data
    })
      .from(schema.siteContent)
      .where(eq(schema.siteContent.key, 'default'))
      .limit(1);

    if (
      row &&
      row.data &&
      typeof row.data === 'object' &&
      !Array.isArray(row.data)
    ) {
      return row.data;
    }

    return {};
  } catch (error) {
    console.warn(
      '[public] Conteúdo do site indisponível:',
      error.message
    );

    return {};
  }
}

/* ============================================================
   FAIXA INDIVIDUAL
   ============================================================ */

async function getPublicTrack(trackId) {
  const [trackRow] = await db.select({
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    lyrics: schema.tracks.lyrics
  })
    .from(schema.tracks)
    .where(
      and(
        eq(schema.tracks.id, trackId),
        eq(schema.tracks.published, true)
      )
    )
    .limit(1);

  if (!trackRow) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Faixa não encontrada ou não publicada.'
      }
    };
  }

  if (!trackRow.albumId) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Álbum da faixa não encontrado.'
      }
    };
  }

  const [albumRow] = await db.select({
    id: schema.albums.id,
    title: schema.albums.title,
    artist: schema.albums.artist,
    coverUrl: schema.albums.coverUrl
  })
    .from(schema.albums)
    .where(
      and(
        eq(schema.albums.id, trackRow.albumId),
        eq(schema.albums.published, true)
      )
    )
    .limit(1);

  if (!albumRow) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Álbum não encontrado ou não publicado.'
      }
    };
  }

  const albumTracks = await db.select(trackPlayerFields())
    .from(schema.tracks)
    .where(
      and(
        eq(schema.tracks.albumId, albumRow.id),
        eq(schema.tracks.published, true)
      )
    )
    .orderBy(...trackOrdering());

  return {
    status: 200,
    body: {
      ok: true,

      id: trackRow.id,
      title: trackRow.title,

      artist: albumRow.artist || 'Joseph Matthos',

      albumTitle: albumRow.title,
      coverUrl: albumRow.coverUrl,

      lyrics: Array.isArray(trackRow.lyrics)
        ? trackRow.lyrics
        : [],

      albumTracks
    }
  };
}

/* ============================================================
   ÁLBUM INDIVIDUAL
   ============================================================ */

async function getPublicAlbum(albumId) {
  const [album] = await db.select(albumFields())
    .from(schema.albums)
    .where(
      and(
        eq(schema.albums.id, albumId),
        eq(schema.albums.published, true)
      )
    )
    .limit(1);

  if (!album) {
    return {
      status: 404,
      body: {
        ok: false,
        error: 'Álbum não encontrado.'
      }
    };
  }

  const tracks = await db.select(trackFields())
    .from(schema.tracks)
    .where(
      and(
        eq(schema.tracks.albumId, album.id),
        eq(schema.tracks.published, true)
      )
    )
    .orderBy(...trackOrdering());

  return {
    status: 200,
    body: {
      ok: true,
      album,
      tracks
    }
  };
}

/* ============================================================
   CATÁLOGO COMPLETO
   ============================================================ */

async function getPublicCatalog() {
  const albums = await db.select(albumFields())
    .from(schema.albums)
    .where(eq(schema.albums.published, true))
    .orderBy(
      asc(schema.albums.sortOrder),
      desc(schema.albums.createdAt),
      asc(schema.albums.id)
    );

  let tracks = [];

  const albumIds = albums.map(album => album.id);

  if (albumIds.length) {
    tracks = await db.select(trackFields())
      .from(schema.tracks)
      .where(
        and(
          eq(schema.tracks.published, true),
          inArray(schema.tracks.albumId, albumIds)
        )
      )
      .orderBy(
        asc(schema.tracks.albumId),
        ...trackOrdering()
      );
  }

  const [content, plans] = await Promise.all([
    getSiteContent(),
    getPublicPlans()
  ]);

  // Os planos de aluguel não possuem tabela própria
  // declarada no schema atual. Portanto, preservamos
  // somente a configuração pública existente no conteúdo.
  const rentalPlans = Array.isArray(content.rentalPlans)
    ? content.rentalPlans
    : [];

  return {
    ok: true,
    content,
    albums,
    tracks,
    plans,
    rentalPlans
  };
}

/* ============================================================
   HANDLER PRINCIPAL
   ============================================================ */

module.exports = async (req, res) => {
  setHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');

    return sendJson(res, 405, {
      ok: false,
      error: 'Method not allowed'
    });
  }

  const trackId = normalizeId(req.query?.track);
  const albumId = normalizeId(req.query?.album);

  // Não aceitar arrays ou objetos como parâmetros.
  if (
    (req.query?.track != null && !trackId) ||
    (req.query?.album != null && !albumId)
  ) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Parâmetro inválido.'
    });
  }

  // Não permitir consulta ambígua.
  if (trackId && albumId) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Informe apenas uma consulta por vez.'
    });
  }

  try {
    // 1. Faixa individual.
    if (trackId) {
      const result = await getPublicTrack(trackId);
      return sendJson(res, result.status, result.body);
    }

    // 2. Álbum individual.
    if (albumId) {
      const result = await getPublicAlbum(albumId);
      return sendJson(res, result.status, result.body);
    }

    // 3. Catálogo completo.
    const catalog = await getPublicCatalog();
    return sendJson(res, 200, catalog);

  } catch (error) {
    console.error('[public] Erro na API:', error);

    return sendJson(res, 500, {
      ok: false,
      error: 'Erro interno no catálogo.'
    });
  }
};