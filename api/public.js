'use strict';

/* ============================================================
   api/public.js — Catálogo Público (Versão Final Definitiva)
   ------------------------------------------------------------
   - Alinhado ao schema real (src/schema.js)
   - Projeções explícitas (NÃO expõe chaves B2)
   - Regra estrita: tracks.status === 'PUBLISHED'
   - Planos e aluguéis com falha isolada (não derrubam o catálogo)
   - Letras incluídas na rota individual
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

/* ─── Projeções Públicas (sem chaves B2, sem status/published) ── */

function albumFields() {
  return {
    id: schema.albums.id,
    title: schema.albums.title,
    slug: schema.albums.slug,
    coverUrl: schema.albums.coverUrl,
    year: schema.albums.year,
    type: schema.albums.type,
    description: schema.albums.description,
    sortOrder: schema.albums.sortOrder,
    artist: schema.albums.artist
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

/* ─── Buscas base (sem fallback inseguro) ─────────────────── */

async function getAlbumsPublic() {
  return db.select(albumFields()).from(schema.albums)
    .where(eq(schema.albums.published, true))
    .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));
}

async function getTracksPublic(albumIds) {
  if (!Array.isArray(albumIds) || albumIds.length === 0) return [];
  return db.select(trackFields()).from(schema.tracks)
    .where(and(
      inArray(schema.tracks.albumId, albumIds),
      eq(schema.tracks.status, 'PUBLISHED')
    ))
    .orderBy(
      asc(schema.tracks.albumId),
      asc(schema.tracks.trackNumber),
      asc(schema.tracks.createdAt)
    );
}

/* ─── Handler Principal ───────────────────────────────────── */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  const trackId = req.query?.track;
  const albumId = req.query?.album;

  if (trackId && albumId) {
    return sendJson(res, 400, { ok: false, error: 'INVALID_QUERY' });
  }

  try {
    // ═══════════════════════════════════════════════════════════
    // 1. FAIXA INDIVIDUAL (Player)
    // ═══════════════════════════════════════════════════════════
    if (trackId) {
      if (!validUuid(trackId)) return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });

      // Busca a faixa com letras (lyrics é jsonb no schema)
      const [track] = await db.select({
        ...trackFields(),
        lyrics: schema.tracks.lyrics
      }).from(schema.tracks)
        .where(and(
          eq(schema.tracks.id, trackId),
          eq(schema.tracks.status, 'PUBLISHED')
        ))
        .limit(1);

      if (!track) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      const [album] = await db.select(albumFields()).from(schema.albums)
        .where(and(
          eq(schema.albums.id, track.albumId),
          eq(schema.albums.published, true)
        ))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const albumTracks = await getTracksPublic([album.id]);

      // Verifica áudio internamente, sem expor chave
      const [meta] = await db.select({
        streamKey: schema.tracks.streamKey,
        previewKey: schema.tracks.previewKey
      }).from(schema.tracks).where(eq(schema.tracks.id, trackId)).limit(1);
      const hasAudio = Boolean(meta?.streamKey || meta?.previewKey);

      return sendJson(res, 200, {
        ok: true,
        id: track.id,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        audioPath: hasAudio ? 'ready' : '',
        lyrics: Array.isArray(track.lyrics) ? track.lyrics : [],
        albumTracks
      });
    }

    // ═══════════════════════════════════════════════════════════
    // 2. ÁLBUM INDIVIDUAL
    // ═══════════════════════════════════════════════════════════
    if (albumId) {
      if (!validUuid(albumId)) return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });

      const [album] = await db.select(albumFields()).from(schema.albums)
        .where(and(
          eq(schema.albums.id, albumId),
          eq(schema.albums.published, true)
        ))
        .limit(1);

      if (!album) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await getTracksPublic([album.id]);
      return sendJson(res, 200, { ok: true, album, tracks });
    }

    // ═══════════════════════════════════════════════════════════
    // 3. HOME (Catálogo Completo — Erros comerciais não derrubam)
    // ═══════════════════════════════════════════════════════════
    const albums = await getAlbumsPublic();
    const albumIds = albums.map(a => a.id);
    const tracks = await getTracksPublic(albumIds);

    // Agrupa faixas por álbum
    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    // ── Conteúdo (opcional, não derruba a home) ────────────
    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row && row.data) content = row.data;
    } catch (err) {
      console.warn('[public] site_content indisponível:', err.message);
    }

    // ── Planos (falha isolada) ──────────────────────────────
    let plans = [];
    let plansError = false;
    try {
      plans = await db.select({
        id: schema.plans.id,
        name: schema.plans.name,
        priceCents: schema.plans.priceCents,
        currency: schema.plans.currency,
        intervalUnit: schema.plans.intervalUnit,
        intervalCount: schema.plans.intervalCount
      }).from(schema.plans).where(eq(schema.plans.active, true));
    } catch (err) {
      console.error('[public] Falha ao buscar planos:', err.message);
      plansError = true;
    }

    // ── Aluguéis (falha isolada) ────────────────────────────
    let rentalPlans = [];
    let rentalsError = false;
    try {
      const products = await db.select({
        id: schema.rentalProducts.id,
        trackId: schema.rentalProducts.trackId,
        albumId: schema.rentalProducts.albumId,
        name: schema.rentalProducts.name,
        durationHours: schema.rentalProducts.durationHours,
        priceCents: schema.rentalProducts.priceCents,
        currency: schema.rentalProducts.currency
      }).from(schema.rentalProducts)
        .where(eq(schema.rentalProducts.active, true));

      const validTracks = new Set(tracks.map(t => t.id));
      const validAlbums = new Set(albumIds);

      rentalPlans = products
        .filter(p => {
          // ★ Regra: exatamente UM destino válido
          const hasT = Boolean(p.trackId);
          const hasA = Boolean(p.albumId);
          if (hasT === hasA) return false;
          return hasT ? validTracks.has(p.trackId) : validAlbums.has(p.albumId);
        })
        .map(p => {
          const hours = Number(p.durationHours);
          const cents = Number(p.priceCents);
          if (!Number.isSafeInteger(hours) || hours <= 0) return null;
          if (!Number.isSafeInteger(cents) || cents <= 0) return null;
          return {
            id: p.id, label: p.name,
            days: Math.floor(hours / 24), hours: hours % 24,
            durationHours: hours, price: cents / 100, priceCents: cents,
            currency: p.currency || 'BRL', available: true,
            trackId: p.trackId || null, albumId: p.albumId || null
          };
        })
        .filter(Boolean);
    } catch (err) {
      console.error('[public] Falha ao buscar aluguéis:', err.message);
      rentalsError = true;
    }

    // ═══════════════════════════════════════════════════════════
    // RESPOSTA FINAL (catálogo sempre; comércio pode falhar)
    // ═══════════════════════════════════════════════════════════
    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans,
      plansError,
      rentalsError
    });

  } catch (err) {
    console.error('[public] Erro crítico:', err.message);
    return sendJson(res, 500, { ok: false, error: 'CATALOG_UNAVAILABLE' });
  }
};