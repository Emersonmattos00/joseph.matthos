/* ============================================================
   admin/playlists-api.js
   ------------------------------------------------------------
   Gerenciamento de referências de faixas nas playlists.

   Identificadores atuais:
   - tracks.id: UUID (string)

   Compatibilidade:
   - IDs numéricos de versões antigas
   - Referências legadas "albumId:index"
   - Catálogo com tracks dentro dos álbuns
   - Catálogo com tracks em array separado
   ============================================================ */

/**
 * Normaliza um identificador sem converter UUID em número.
 */
function normalizeTrackId(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const id = String(value).trim();

  return id ? id : null;
}

/**
 * Retorna os álbuns e suas faixas.
 *
 * Aceita:
 * - Álbuns contendo album.tracks
 * - Álbuns + array separado de faixas
 */
export function normalizeCatalog(albums = [], tracks = []) {
  if (!Array.isArray(albums)) return [];

  const validTracks = Array.isArray(tracks) ? tracks : [];

  const tracksByAlbum = new Map();

  for (const track of validTracks) {
    if (!track || !track.albumId) continue;

    const albumId = String(track.albumId);

    if (!tracksByAlbum.has(albumId)) {
      tracksByAlbum.set(albumId, []);
    }

    tracksByAlbum.get(albumId).push(track);
  }

  return albums.map(album => {
    const nestedTracks = Array.isArray(album.tracks)
      ? album.tracks
      : [];

    const externalTracks = tracksByAlbum.get(
      String(album.id)
    ) || [];

    const merged = nestedTracks.length
      ? nestedTracks
      : externalTracks;

    return {
      ...album,
      tracks: [...merged].sort((a, b) => {
        return (
          Number(a.trackNumber || 0) -
          Number(b.trackNumber || 0)
        );
      })
    };
  });
}

/**
 * Índice legado:
 * "albumId:index" -> track.id
 */
function buildLegacyIndex(albums) {
  const index = new Map();

  for (const album of albums || []) {
    const tracks = Array.isArray(album.tracks)
      ? album.tracks
      : [];

    tracks.forEach((track, idx) => {
      const id = normalizeTrackId(track?.id);

      if (id) {
        index.set(`${album.id}:${idx}`, id);
      }
    });
  }

  return index;
}

/**
 * Índice reverso:
 * track.id -> { album, track, trackIndex }
 */
function buildTrackIndex(albums) {
  const index = new Map();

  for (const album of albums || []) {
    const tracks = Array.isArray(album.tracks)
      ? album.tracks
      : [];

    tracks.forEach((track, trackIndex) => {
      const id = normalizeTrackId(track?.id);

      if (!id) return;

      index.set(id, {
        album,
        track,
        trackIndex
      });
    });
  }

  return index;
}

/**
 * Migra referências antigas para IDs de faixa.
 *
 * Não descarta UUIDs válidos.
 * Preserva números antigos para compatibilidade.
 */
export function migratePlaylistTracks(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) {
    return [];
  }

  const legacyIndex = buildLegacyIndex(albums);
  const out = [];

  for (const ref of playlist.tracks) {
    if (typeof ref === 'number') {
      if (Number.isSafeInteger(ref) && ref > 0) {
        out.push(ref);
      }

      continue;
    }

    if (typeof ref !== 'string') continue;

    const trimmed = ref.trim();

    if (!trimmed) continue;

    // Referência UUID ou ID já existente.
    // Não converter para número.
    if (!trimmed.includes(':')) {
      out.push(trimmed);
      continue;
    }

    // Formato antigo: albumId:index
    const trackId = legacyIndex.get(trimmed);

    if (trackId) {
      out.push(trackId);
    }
  }

  // Remove duplicações preservando a ordem.
  return [...new Set(out)];
}

/**
 * Migra todas as playlists.
 */
export function migrateAllPlaylists(playlists, albums) {
  if (!Array.isArray(playlists)) return [];

  return playlists.map(playlist => ({
    ...playlist,
    tracks: migratePlaylistTracks(playlist, albums)
  }));
}

/**
 * Resolve os IDs das faixas em objetos completos.
 */
export function resolvePlaylistTracks(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) {
    return [];
  }

  const index = buildTrackIndex(albums);
  const result = [];

  for (const trackId of playlist.tracks) {
    const id = normalizeTrackId(trackId);

    if (!id) continue;

    const entry = index.get(id);

    if (entry) {
      result.push({
        ...entry,
        trackId: id
      });
    }
  }

  return result;
}

/**
 * Busca faixas por título ou álbum.
 */
export function searchTracks(query, albums, limit = 20) {
  const q = String(query || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const maxResults = Math.max(
    1,
    Math.min(Number(limit) || 20, 100)
  );

  if (!q || !Array.isArray(albums)) return [];

  const results = [];

  for (const album of albums) {
    const tracks = Array.isArray(album.tracks)
      ? album.tracks
      : [];

    for (const track of tracks) {
      const id = normalizeTrackId(track?.id);

      if (!id) continue;

      const title = String(track.title || '');

      const normalizedTitle = title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      const albumTitle = String(album.title || '');

      const normalizedAlbum = albumTitle
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      if (
        normalizedTitle.includes(q) ||
        normalizedAlbum.includes(q)
      ) {
        results.push({
          trackId: id,
          title: title || '(sem título)',
          albumTitle,
          albumId: album.id,
          duration:
            track.duration ||
            track.durationSeconds ||
            '—'
        });

        if (results.length >= maxResults) {
          return results;
        }
      }
    }
  }

  return results;
}

/**
 * Conta playlists que contêm uma faixa.
 */
export function countPlaylistsWithTrack(trackId, playlists) {
  const id = normalizeTrackId(trackId);

  if (!id || !Array.isArray(playlists)) return 0;

  return playlists.filter(playlist =>
    Array.isArray(playlist.tracks) &&
    playlist.tracks.some(
      track => normalizeTrackId(track) === id
    )
  ).length;
}