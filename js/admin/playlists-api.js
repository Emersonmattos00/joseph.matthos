/* ============================================================
   admin/playlists-api.js — Helpers de playlist
   ------------------------------------------------------------
   - migratePlaylistTracks(): converte "albumId:index" → track.id
   - resolvePlaylistTracks(): trackIds → objetos de faixa
   - searchTracks(): busca por título para autocomplete
   ============================================================ */

/**
 * Constrói um índice "albumId:trackIndex" → track.id
 * a partir do catálogo carregado em /api/public.
 */
function buildLegacyIndex(albums) {
  const index = new Map();
  for (const album of albums || []) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    tracks.forEach((track, idx) => {
      if (track && track.id !== undefined && track.id !== null) {
        index.set(`${album.id}:${idx}`, track.id);
      }
    });
  }
  return index;
}

/**
 * Constrói um índice "trackId" → { album, track, trackIndex }
 * para resolução reversa.
 */
function buildTrackIndex(albums) {
  const index = new Map();
  for (const album of albums || []) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    tracks.forEach((track, trackIndex) => {
      if (track && track.id !== undefined && track.id !== null) {
        index.set(Number(track.id), { album, track, trackIndex });
      }
    });
  }
  return index;
}

/**
 * Migra uma playlist do formato antigo (albumId:index)
 * para o formato novo (track.id).
 *
 * - Números são preservados como estão.
 * - Strings "album-xxx:0" são convertidas via índice.
 * - Strings inválidas são descartadas.
 *
 * @returns {Array<number>}
 */
export function migratePlaylistTracks(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) return [];
  const legacyIndex = buildLegacyIndex(albums);

  const out = [];
  for (const ref of playlist.tracks) {
    // Já é número (novo formato) — preserva
    if (typeof ref === 'number' && Number.isFinite(ref)) {
      out.push(ref);
      continue;
    }

    // String "albumId:index" (formato legado)
    if (typeof ref === 'string') {
      const trimmed = ref.trim();
      // Tenta como número puro ("13")
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum) && String(asNum) === trimmed) {
        out.push(asNum);
        continue;
      }
      // Tenta como legado
      const trackId = legacyIndex.get(trimmed);
      if (trackId !== undefined) out.push(trackId);
    }
  }
  return out;
}

/**
 * Migra TODAS as playlists de uma vez.
 * Retorna um novo array — não muta o original.
 */
export function migrateAllPlaylists(playlists, albums) {
  if (!Array.isArray(playlists)) return [];
  return playlists.map((pl) => ({
    ...pl,
    tracks: migratePlaylistTracks(pl, albums)
  }));
}

/**
 * Resolve os IDs de faixa de uma playlist em objetos completos.
 * Ignora IDs que não existem mais no catálogo.
 *
 * @returns {Array<{ album, track, trackIndex, trackId }>}
 */
export function resolvePlaylistTracks(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) return [];
  const index = buildTrackIndex(albums);

  const out = [];
  for (const trackId of playlist.tracks) {
    const idNum = typeof trackId === 'number' ? trackId : Number(trackId);
    if (!Number.isFinite(idNum)) continue;
    const entry = index.get(idNum);
    if (entry) out.push({ ...entry, trackId: idNum });
  }
  return out;
}

/**
 * Busca faixas por título (para autocomplete).
 * Retorna no máximo `limit` resultados.
 *
 * @returns {Array<{ trackId, title, albumTitle, albumId, duration }>}
 */
export function searchTracks(query, albums, limit = 20) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];

  const results = [];
  for (const album of albums || []) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    for (const track of tracks) {
      if (!track || track.id === undefined) continue;
      const title = String(track.title || '').toLowerCase();
      const albumTitle = String(album.title || '').toLowerCase();
      if (title.includes(q) || albumTitle.includes(q)) {
        results.push({
          trackId: Number(track.id),
          title: track.title || '(sem título)',
          albumTitle: album.title || '',
          albumId: album.id,
          duration: track.duration || '—'
        });
        if (results.length >= limit) return results;
      }
    }
  }
  return results;
}

/**
 * Conta quantas playlists contêm um determinado trackId.
 * Útil para avisar antes de excluir uma faixa.
 */
export function countPlaylistsWithTrack(trackId, playlists) {
  const idNum = Number(trackId);
  if (!Number.isFinite(idNum)) return 0;
  return (playlists || []).filter((pl) =>
    Array.isArray(pl.tracks) && pl.tracks.includes(idNum)
  ).length;
}
