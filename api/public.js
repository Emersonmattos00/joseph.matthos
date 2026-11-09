/* ============================================================
   api/public.js — Catálogo público (Versão Final Consolidada)
   ------------------------------------------------------------
   - Campos alinhados ao admin.js (duration, status, coverUrl)
   - JOIN com artists para resolver nome do artista
   - Catálogo retorna albums com tracks aninhadas
   - trackPlayerFields inclui albumId
   - Falha de siteContent sinalizada como contentError
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

/* ─── Cabeçalhos ─────────────────────────────────────────── */

function setHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

/* ─── Validação ──────────────────────────────────────────── */

function normalizeId(value) {
  if (typeof value !== 'string') return null;
  const id = String(value).trim();
  if (!id || id.length > 128) return null;
  return id;
}

/* ─── Campos públicos ────────────────────────────────────── */

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
    artist: schema.artists.name,           // ← JOIN com artists
    artistId: schema.albums.artistId,
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
    duration: schema.tracks.duration,       // ← alinhado ao admin.js
    locked: schema.tracks.locked
  };
}

function trackPlayerFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,         // ← adicionar para playlists.js
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    duration: schema.tracks.duration,
    locked: schema.tracks.locked
  };
}

function trackOrdering() {
  return [
    asc(schema.tracks.trackNumber),
    asc(schema.tracks.createdAt),
    asc(schema.tracks.id)
  ];
}

/* ─── Planos ─────────────────────────────────────────────── */

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

/* ─── Site content ───────────────────────────────────────── */

async function getSiteContent() {
  try {
    const [row] = await db.select({ data: schema.siteContent.data })
      .from(schema.siteContent)
      .where(eq(schema.siteContent.key, 'default'))
      .limit(1);

    if (row && row.data && typeof row.data === 'object' && !Array.isArray(row.data)) {
      return { data: row.data, error: false };
    }
    return { data: {}, error: false };
  } catch (err) {
    console.warn('[public] Conteúdo do site indisponível:', err.message);
    return { data: {}, error: true };
  }
}

/* ─── Faixa individual ───────────────────────────────────── */

async function getPublicTrack(trackId) {
  const [trackRow] = await db.select({
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    lyrics: schema.tracks.lyrics
  })
    .from(schema.tracks)
    .where(and(
      eq(schema.tracks.id, trackId),
      eq(schema.tracks.status, 'PUBLISHED')    // ← alinhado ao admin.js
    ))
    .limit(1);

  if (!trackRow) {
    return { status: 404, body: { ok: false, error: 'Faixa não encontrada ou não publicada.' } };
  }

  if (!trackRow.albumId) {
    return { status: 404, body: { ok: false, error: 'Álbum da faixa não encontrado.' } };
  }

  const [albumRow] = await db.select({
    id: schema.albums.id,
    title: schema.albums.title,
    coverUrl: schema.albums.coverUrl,
    artist: schema.artists.name
  })
    .from(schema.albums)
    .leftJoin(schema.artists, eq(schema.albums.artistId, schema.artists.id))
    .where(and(
      eq(schema.albums.id, trackRow.albumId),
      eq(schema.albums.published, true)
    ))
    .limit(1);

  if (!albumRow) {
    return { status: 404, body: { ok: false, error: 'Álbum não encontrado ou não publicado.' } };
  }

  const albumTracks = await db.select(trackPlayerFields())
    .from(schema.tracks)
    .where(and(
      eq(schema.tracks.albumId, albumRow.id),
      eq(schema.tracks.status, 'PUBLISHED')
    ))
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
      lyrics: Array.isArray(trackRow.lyrics) ? trackRow.lyrics : [],
      albumTracks
    }
  };
}

/* ─── Álbum individual ───────────────────────────────────── */

async function getPublicAlbum(albumId) {
  const [album] = await db.select(albumFields())
    .from(schema.albums)
    .leftJoin(schema.artists, eq(schema.albums.artistId, schema.artists.id))
    .where(and(
      eq(schema.albums.id, albumId),
      eq(schema.albums.published, true)
    ))
    .limit(1);

  if (!album) {
    return { status: 404, body: { ok: false, error: 'Álbum não encontrado.' } };
  }

  const tracks = await db.select(trackFields())
    .from(schema.tracks)
    .where(and(
      eq(schema.tracks.albumId, album.id),
      eq(schema.tracks.status, 'PUBLISHED')
    ))
    .orderBy(...trackOrdering());

  return {
    status: 200,
    body: {
      ok: true,
      album: { ...album, tracks },   // ← tracks aninhadas
      tracks                          // ← mantém para compat
    }
  };
}

/* ─── Catálogo completo ──────────────────────────────────── */

async function getPublicCatalog() {
  const albums = await db.select(albumFields())
    .from(schema.albums)
    .leftJoin(schema.artists, eq(schema.albums.artistId, schema.artists.id))
    .where(eq(schema.albums.published, true))
    .orderBy(
      asc(schema.albums.sortOrder),
      desc(schema.albums.createdAt),
      asc(schema.albums.id)
    );

  let tracks = [];
  const albumIds = albums.map(a => a.id);

  if (albumIds.length) {
    tracks = await db.select(trackFields())
      .from(schema.tracks)
      .where(and(
        eq(schema.tracks.status, 'PUBLISHED'),
        inArray(schema.tracks.albumId, albumIds)
      ))
      .orderBy(asc(schema.tracks.albumId), ...trackOrdering());
  }

  // Aninha tracks por album (necessário para playlists.js)
  const tracksByAlbum = new Map();
  for (const t of tracks) {
    if (!tracksByAlbum.has(t.albumId)) tracksByAlbum.set(t.albumId, []);
    tracksByAlbum.get(t.albumId).push(t);
  }

  const albumsWithTracks = albums.map(a => ({
    ...a,
    tracks: tracksByAlbum.get(a.id) || []
  }));

  const [contentResult, plans] = await Promise.all([
    getSiteContent(),
    getPublicPlans()
  ]);

  const content = contentResult.data;
  const rentalPlans = Array.isArray(content.rentalPlans) ? content.rentalPlans : [];

  return {
    ok: true,
    content,
    contentError: contentResult.error,   // sinaliza falha
    albums: albumsWithTracks,            // ← com tracks aninhadas
    tracks,                              // ← compat legado
    plans,
    rentalPlans
  };
}

/* ─── Handler ────────────────────────────────────────────── */

module.exports = async (req, res) => {
  setHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const trackId = normalizeId(req.query?.track);
  const albumId = normalizeId(req.query?.album);

  if (
    (req.query?.track != null && !trackId) ||
    (req.query?.album != null && !albumId)
  ) {
    return sendJson(res, 400, { ok: false, error: 'Parâmetro inválido.' });
  }

  if (trackId && albumId) {
    return sendJson(res, 400, { ok: false, error: 'Informe apenas uma consulta por vez.' });
  }

  try {
    if (trackId) {
      const r = await getPublicTrack(trackId);
      return sendJson(res, r.status, r.body);
    }
    if (albumId) {
      const r = await getPublicAlbum(albumId);
      return sendJson(res, r.status, r.body);
    }
    const catalog = await getPublicCatalog();
    return sendJson(res, 200, catalog);
  } catch (error) {
    console.error('[public] Erro na API:', error);
    return sendJson(res, 500, { ok: false, error: 'Erro interno no catálogo.' });
  }
};