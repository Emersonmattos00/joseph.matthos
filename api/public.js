/* ============================================================
   api/public.js — Catálogo público (Versão Final Auditada)
   ------------------------------------------------------------
   Correções aplicadas (auditorias 12, 13 + schema Drizzle):
   - Usa tracks.status === 'PUBLISHED' (coluna real; `published`
     não existe em tracks — apenas em albums)
   - publicTrack deriva `published` de `status`
   - publicTrack NÃO lê `locked` (coluna não existe)
   - Resposta da faixa NÃO inclui `lyrics` (coluna não existe)
   - siteContent omitido (tabela não existe no schema atual);
     `content` retorna {} para o frontend não quebrar
   - Ordenação: trackNumber + createdAt (createdAt existe)
   - publicTrack chamada UMA vez por faixa (Map)
   - Resposta da faixa padronizada (track/album/tracks) +
     compatibilidade (id/title/albumTitle/albumTracks)
   - publicPlan/publicRentalProduct validam preço e duração
     (Number(null) === 0 não vira preço gratuito)
   - rentalPlans filtrados por conteúdo publicado
   - validUuid com trim()
   - ?track= e ?album= simultâneos → 400
   - Erro de banco não vaza mensagem interna

   ⚠️ URL de reprodução NÃO é entregue aqui.
      O player deve chamar um endpoint autorizado
      (/api/stream ou equivalente) que verifica Premium/aluguel
      e devolve URL assinada temporária do B2.

   TODO (schema, fora deste arquivo):
   - Adicionar tracks.locked (boolean) se o player precisar
   - Adicionar tracks.lyrics (jsonb) se o player exibir letra
   - Criar tabela site_content e restaurar consulta
   ============================================================ */

'use strict';

const { sendJson } = require('./_lib');
const { db, eq, and, asc, desc } = require('./_db');
const schema = require('./_db').schema;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value.trim());
}

function normalizeQueryParam(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function parsePriceCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function parseDurationHours(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isValidInterval(unit, count) {
  if (typeof unit !== 'string' || !unit.trim()) return false;
  const n = Number(count);
  return Number.isSafeInteger(n) && n > 0;
}

function publicTrack(track) {
  return {
    id: track.id,
    albumId: track.albumId,
    title: track.title,
    trackNumber: track.trackNumber,
    durationSeconds: track.durationSeconds,
    // Derivado de `status` (coluna real do schema).
    published: track.status === 'PUBLISHED'
  };
}

function publicAlbum(album, tracks = []) {
  return {
    id: album.id,
    title: album.title,
    slug: album.slug,
    artist: album.artist || 'Joseph Matthos',
    artistId: album.artistId,
    releaseDate: album.releaseDate,
    year: album.year,
    type: album.type,
    description: album.description,
    coverUrl: album.coverUrl,
    coverInitials: album.coverInitials,
    tracks
  };
}

function publicPlan(plan) {
  const priceCents = parsePriceCents(plan.priceCents);
  const validPrice = priceCents !== null;
  const validInterval = isValidInterval(plan.intervalUnit, plan.intervalCount);

  return {
    id: plan.id,
    name: plan.name,
    priceCents,
    currency: plan.currency || 'BRL',
    intervalUnit: plan.intervalUnit,
    intervalCount: plan.intervalCount,
    available: plan.active === true && validPrice && validInterval
  };
}

function publicRentalProduct(product) {
  const priceCents = parsePriceCents(product.priceCents);
  const durationHours = parseDurationHours(product.durationHours);

  const validPrice = priceCents !== null;
  const validDuration = durationHours !== null;

  return {
    id: product.id,
    name: product.name,
    label: product.name,
    trackId: product.trackId,
    albumId: product.albumId,

    durationHours,
    hours: durationHours,
    days: validDuration ? Math.max(1, Math.ceil(durationHours / 24)) : null,

    priceCents,
    price: validPrice ? priceCents / 100 : null,

    currency: product.currency || 'BRL',
    available: product.active === true && validPrice && validDuration
  };
}

module.exports = async function publicApi(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { ok: false, error: 'Método não permitido.' });
  }

  const trackId = normalizeQueryParam(req.query?.track);
  const albumId = normalizeQueryParam(req.query?.album);

  if (trackId && albumId) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Informe apenas um identificador: track ou album.'
    });
  }

  try {
    /* ── 1. Faixa específica (Player) ── */
    if (trackId) {
      if (!validUuid(trackId)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Identificador de faixa inválido.'
        });
      }

      const [track] = await db
        .select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.id, trackId),
            eq(schema.tracks.status, 'PUBLISHED')
          )
        )
        .limit(1);

      if (!track || !track.albumId) {
        return sendJson(res, 404, {
          ok: false,
          error: 'Faixa não encontrada.'
        });
      }

      const [album] = await db
        .select()
        .from(schema.albums)
        .where(
          and(
            eq(schema.albums.id, track.albumId),
            eq(schema.albums.published, true)
          )
        )
        .limit(1);

      if (!album) {
        return sendJson(res, 404, {
          ok: false,
          error: 'Álbum não encontrado.'
        });
      }

      const tracks = await db
        .select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.albumId, album.id),
            eq(schema.tracks.status, 'PUBLISHED')
          )
        )
        .orderBy(
          asc(schema.tracks.trackNumber),
          asc(schema.tracks.createdAt)
        );

      const tracksPublic = tracks.map(publicTrack);
      const selectedTrack = publicTrack(track);

      return sendJson(res, 200, {
        ok: true,

        // Formato estruturado (recomendado)
        track: {
          ...selectedTrack,
          artist: album.artist || 'Joseph Matthos',
          albumTitle: album.title,
          coverUrl: album.coverUrl
        },
        album: publicAlbum(album, tracksPublic),
        tracks: tracksPublic,

        // Compatibilidade com frontend legado
        id: track.id,
        title: track.title,
        artist: album.artist || 'Joseph Matthos',
        albumTitle: album.title,
        coverUrl: album.coverUrl,
        albumTracks: tracksPublic
      });
    }

    /* ── 2. Álbum específico ── */
    if (albumId) {
      if (!validUuid(albumId)) {
        return sendJson(res, 400, {
          ok: false,
          error: 'Identificador de álbum inválido.'
        });
      }

      const [album] = await db
        .select()
        .from(schema.albums)
        .where(
          and(
            eq(schema.albums.id, albumId),
            eq(schema.albums.published, true)
          )
        )
        .limit(1);

      if (!album) {
        return sendJson(res, 404, {
          ok: false,
          error: 'Álbum não encontrado.'
        });
      }

      const tracks = await db
        .select()
        .from(schema.tracks)
        .where(
          and(
            eq(schema.tracks.albumId, album.id),
            eq(schema.tracks.status, 'PUBLISHED')
          )
        )
        .orderBy(
          asc(schema.tracks.trackNumber),
          asc(schema.tracks.createdAt)
        );

      const tracksPublic = tracks.map(publicTrack);

      return sendJson(res, 200, {
        ok: true,
        album: publicAlbum(album, tracksPublic),
        tracks: tracksPublic
      });
    }

    /* ── 3. Catálogo geral (Home) ── */
    const [albums, allTracks, plans, rentalProducts] = await Promise.all([
      db
        .select()
        .from(schema.albums)
        .where(eq(schema.albums.published, true))
        .orderBy(
          asc(schema.albums.sortOrder),
          desc(schema.albums.createdAt)
        ),

      db
        .select()
        .from(schema.tracks)
        .where(eq(schema.tracks.status, 'PUBLISHED'))
        .orderBy(
          asc(schema.tracks.trackNumber),
          asc(schema.tracks.createdAt)
        ),

      db
        .select()
        .from(schema.plans)
        .where(eq(schema.plans.active, true)),

      db
        .select()
        .from(schema.rentalProducts)
        .where(eq(schema.rentalProducts.active, true))
        .orderBy(asc(schema.rentalProducts.sortOrder))
    ]);

    const publishedAlbumIds = new Set(albums.map(a => String(a.id)));

    const visibleTracks = allTracks.filter(
      t => t.albumId && publishedAlbumIds.has(String(t.albumId))
    );

    // publicTrack UMA vez por faixa
    const publicTracks = visibleTracks.map(publicTrack);

    // Associação por álbum (O(n))
    const tracksByAlbum = new Map();
    for (const track of publicTracks) {
      const albumKey = String(track.albumId);
      if (!tracksByAlbum.has(albumKey)) tracksByAlbum.set(albumKey, []);
      tracksByAlbum.get(albumKey).push(track);
    }

    const albumsWithTracks = albums.map(album =>
      publicAlbum(album, tracksByAlbum.get(String(album.id)) || [])
    );

    // Filtro de rentalProducts por conteúdo publicado
    const visibleTracksById = new Map(
      visibleTracks.map(t => [String(t.id), t])
    );

    const visibleRentalProducts = rentalProducts.filter(product => {
      const productTrackId = product.trackId
        ? String(product.trackId)
        : null;

      const productAlbumId = product.albumId
        ? String(product.albumId)
        : null;

      if (productTrackId) {
        const track = visibleTracksById.get(productTrackId);
        if (!track) return false;

        if (productAlbumId && String(track.albumId) !== productAlbumId) {
          return false;
        }

        return true;
      }

      return productAlbumId
        ? publishedAlbumIds.has(productAlbumId)
        : false;
    });

    // site_content não existe no schema atual.
    // Quando a tabela for criada, restaurar:
    //   db.select().from(schema.siteContent)
    //     .where(eq(schema.siteContent.key, 'default'))
    //     .limit(1)
    const content = {};

    return sendJson(res, 200, {
      ok: true,
      content,
      albums: albumsWithTracks,
      tracks: publicTracks,
      plans: plans.map(publicPlan),
      rentalPlans: visibleRentalProducts.map(publicRentalProduct)
    });
  } catch (error) {
    console.error('[public] Erro no catálogo:', {
      message: error.message,
      code: error.code
    });
    return sendJson(res, 500, {
      ok: false,
      error: 'Não foi possível carregar o catálogo.'
    });
  }
};