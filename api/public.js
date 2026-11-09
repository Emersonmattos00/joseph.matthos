'use strict';

/* ============================================================
   api/public.js — Catálogo público (Versão Final Segura)
   ------------------------------------------------------------
   - Nunca expõe streamKey / previewKey / fullPath / previewPath
   - Mantém contrato do player (audioPath é booleano seguro)
   - Regra oficial: tracks.status = 'PUBLISHED'
   - Fallback apenas na home (para compatibilidade com banco antigo)
   - Aluguéis validados (só produtos com faixa/álbum publicados)
   ============================================================ */

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc, inArray, or } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

/* ─── Projeções Públicas (nunca expõem chaves B2) ──────── */

function publicAlbumFields() {
  return {
    id: schema.albums.id,
    title: schema.albums.title,
    slug: schema.albums.slug,
    artist: schema.albums.artist,
    year: schema.albums.year,
    type: schema.albums.type,
    description: schema.albums.description,
    coverUrl: schema.albums.coverUrl,
    sortOrder: schema.albums.sortOrder,
    published: schema.albums.published
  };
}

function publicTrackFields() {
  return {
    id: schema.tracks.id,
    albumId: schema.tracks.albumId,
    title: schema.tracks.title,
    trackNumber: schema.tracks.trackNumber,
    duration: schema.tracks.duration,
    locked: schema.tracks.locked,
    status: schema.tracks.status
    // ❌ streamKey, previewKey, fullPath, previewPath NUNCA
  };
}

/* ─── Busca blindada para banco antigo (fallback na home) ─ */

async function fetchAlbumsForHome() {
  try {
    return await db.select(publicAlbumFields()).from(schema.albums)
      .where(eq(schema.albums.published, true))
      .orderBy(asc(schema.albums.sortOrder), desc(schema.albums.createdAt));
  } catch (err) {
    console.warn('[public] Fallback álbuns (sem sortOrder/createdAt):', err.message);
    // Tenta sem ordenação (banco antigo)
    return await db.select({
      id: schema.albums.id,
      title: schema.albums.title,
      coverUrl: schema.albums.coverUrl,
      published: schema.albums.published
    }).from(schema.albums).where(eq(schema.albums.published, true));
  }
}

async function fetchTracksForHome(albumIds) {
  if (!albumIds.length) return [];
  try {
    // Tenta a regra oficial (status)
    return await db.select(publicTrackFields()).from(schema.tracks)
      .where(and(
        eq(schema.tracks.status, 'PUBLISHED'),
        inArray(schema.tracks.albumId, albumIds)
      ))
      .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber));
  } catch (err) {
    console.warn('[public] Fallback faixas (status não existe):', err.message);
    // Banco antigo: usa published
    return await db.select({
      id: schema.tracks.id,
      albumId: schema.tracks.albumId,
      title: schema.tracks.title,
      trackNumber: schema.tracks.trackNumber,
      duration: schema.tracks.duration
    }).from(schema.tracks)
      .where(and(
        eq(schema.tracks.published, true),
        inArray(schema.tracks.albumId, albumIds)
      ))
      .orderBy(asc(schema.tracks.albumId), asc(schema.tracks.trackNumber));
  }
}

/* ─── Handler Principal ───────────────────────────────────── */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const { track, album } = req.query;

  try {
    // ═══════════════════════════════════════════════════════════
    // 1. FAIXA ESPECÍFICA (Player)
    // ═══════════════════════════════════════════════════════════
    if (track) {
      if (!validUuid(track)) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_TRACK_ID' });
      }

      // Busca faixa com regra oficial (status), com fallback para banco antigo
      let trackRow = null;
      try {
        const [row] = await db.select(publicTrackFields()).from(schema.tracks)
          .where(and(eq(schema.tracks.id, track), eq(schema.tracks.status, 'PUBLISHED')))
          .limit(1);
        trackRow = row;
      } catch (err) {
        // Banco sem coluna status: usa published
        const [row] = await db.select().from(schema.tracks)
          .where(and(eq(schema.tracks.id, track), eq(schema.tracks.published, true)))
          .limit(1);
        trackRow = row;
      }

      if (!trackRow) return sendJson(res, 404, { ok: false, error: 'TRACK_NOT_FOUND' });

      // Busca álbum (sem expor campos privados)
      const [albumRow] = await db.select(publicAlbumFields()).from(schema.albums)
        .where(eq(schema.albums.id, trackRow.albumId))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      // Faixas do álbum (sem chaves privadas)
      const albumTracks = await fetchTracksForHome([albumRow.id]);

      // 🔒 audioPath é booleano — o player usa /api/stream, não a chave
      const hasAudio = Boolean(trackRow.streamKey || trackRow.previewKey);

      return sendJson(res, 200, {
        ok: true,
        id: trackRow.id,
        title: trackRow.title,
        artist: albumRow.artist || 'Joseph Matthos',
        albumTitle: albumRow.title,
        coverUrl: albumRow.coverUrl,
        audioPath: hasAudio ? 'ready' : '',
        lyrics: [],
        albumTracks
      });
    }

    // ═══════════════════════════════════════════════════════════
    // 2. ÁLBUM ESPECÍFICO
    // ═══════════════════════════════════════════════════════════
    if (album) {
      if (!validUuid(album)) {
        return sendJson(res, 400, { ok: false, error: 'INVALID_ALBUM_ID' });
      }

      const [albumRow] = await db.select(publicAlbumFields()).from(schema.albums)
        .where(eq(schema.albums.id, album))
        .limit(1);

      if (!albumRow) return sendJson(res, 404, { ok: false, error: 'ALBUM_NOT_FOUND' });

      const tracks = await fetchTracksForHome([albumRow.id]);
      return sendJson(res, 200, { ok: true, album: albumRow, tracks });
    }

    // ═══════════════════════════════════════════════════════════
    // 3. HOME (Catálogo completo)
    // ═══════════════════════════════════════════════════════════
    const albums = await fetchAlbumsForHome();
    const albumIds = albums.map(a => a.id);
    const tracks = await fetchTracksForHome(albumIds);

    // Agrupa faixas dentro dos álbuns
    const byAlbum = new Map();
    for (const t of tracks) {
      if (!byAlbum.has(t.albumId)) byAlbum.set(t.albumId, []);
      byAlbum.get(t.albumId).push(t);
    }
    const albumsWithTracks = albums.map(a => ({
      ...a,
      tracks: byAlbum.get(a.id) || []
    }));

    // Conteúdo do site (para textos/imagens)
    let content = {};
    try {
      const [row] = await db.select({ data: schema.siteContent.data })
        .from(schema.siteContent).where(eq(schema.siteContent.key, 'default')).limit(1);
      if (row?.data) content = row.data;
    } catch {}

    // Planos de assinatura
    let plans = [];
    try {
      plans = await db.select({
        id: schema.plans.id,
        name: schema.plans.name,
        priceCents: schema.plans.priceCents,
        currency: schema.plans.currency,
        intervalUnit: schema.plans.intervalUnit,
        intervalCount: schema.plans.intervalCount
      }).from(schema.plans).where(eq(schema.plans.active, true));
    } catch {}

    // Aluguéis (validando só produtos publicados)
    let rentalPlans = [];
    try {
      const products = await db.select({
        id: schema.rentalProducts.id,
        trackId: schema.rentalProducts.trackId,
        albumId: schema.rentalProducts.albumId,
        name: schema.rentalProducts.name,
        durationHours: schema.rentalProducts.durationHours,
        priceCents: schema.rentalProducts.priceCents,
        currency: schema.rentalProducts.currency
      }).from(schema.rentalProducts).where(eq(schema.rentalProducts.active, true));

      const validTracks = new Set(tracks.map(t => t.id));
      const validAlbums = new Set(albumIds);

      rentalPlans = products
        .filter(p => {
          if (p.trackId) return validTracks.has(p.trackId);
          if (p.albumId) return validAlbums.has(p.albumId);
          return false;
        })
        .map(p => {
          const hours = Number(p.durationHours);
          const cents = Number(p.priceCents);
          if (!Number.isSafeInteger(hours) || hours <= 0) return null;
          if (!Number.isSafeInteger(cents) || cents <= 0) return null;
          return {
            id: p.id, label: p.name,
            days: Math.floor(hours / 24), hours: hours % 24,
            durationHours: hours,
            price: cents / 100, priceCents: cents,
            currency: p.currency || 'BRL',
            available: true,
            trackId: p.trackId || null,
            albumId: p.albumId || null
          };
        })
        .filter(Boolean);
    } catch {}

    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks,
      plans,
      rentalPlans
    });

  } catch (err) {
    console.error('[public] Erro crítico:', err.message);
    return sendJson(res, 500, { ok: false, error: 'CATALOG_UNAVAILABLE' });
  }
};