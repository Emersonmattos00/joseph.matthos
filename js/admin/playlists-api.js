/* ============================================================
   js/admin/playlists-api.js — v4 (Versão Final Auditada)
   ============================================================ */

function normalizeTrackId(value) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id || null;
}

function normalizeSearchText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function formatDuration(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string' && value.includes(':')) return value;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildTrackIndex(albums) {
  const index = new Map();
  if (!Array.isArray(albums)) return index;
  for (const album of albums) {
    if (!album || typeof album !== 'object') continue;
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    tracks.forEach((track, trackIndex) => {
      const id = normalizeTrackId(track?.id);
      if (!id) return;
      if (!index.has(id)) index.set(id, { album, track, trackIndex });
    });
  }
  return index;
}

function buildLegacyIndex(albums) {
  const index = new Map();
  if (!Array.isArray(albums)) return index;
  for (const album of albums) {
    const albumId = normalizeTrackId(album?.id);
    if (!albumId) continue;
    const tracks = Array.isArray(album?.tracks) ? album.tracks : [];
    tracks.forEach((track, idx) => {
      const trackId = normalizeTrackId(track?.id);
      if (!trackId) return;
      const legacyRef = `${albumId}:${idx}`;
      if (!index.has(legacyRef)) index.set(legacyRef, trackId);
    });
  }
  return index;
}

export function migratePlaylistTracksDetailed(playlist, albums) {
  const empty = { tracks: [], unresolved: [], migrated: [], hasWarnings: false };
  if (!playlist || !Array.isArray(playlist.tracks)) return empty;

  const trackIndex = buildTrackIndex(albums);
  const legacyIndex = buildLegacyIndex(albums);

  const tracks = [];
  const unresolved = [];
  const migrated = [];
  const seen = new Set();

  for (const originalRef of playlist.tracks) {
    const ref = normalizeTrackId(originalRef);
    if (!ref) { unresolved.push(originalRef); continue; }

    if (trackIndex.has(ref)) {
      if (!seen.has(ref)) { seen.add(ref); tracks.push(ref); }
      continue;
    }

    if (legacyIndex.has(ref)) {
      const trackId = legacyIndex.get(ref);
      if (trackId && !seen.has(trackId)) {
        seen.add(trackId); tracks.push(trackId); migrated.push({ from: ref, to: trackId });
      }
      continue;
    }

    const legacyKey = ref.startsWith('legacy:') ? ref : `legacy:${ref}`;
    if (!seen.has(legacyKey)) {
      seen.add(legacyKey); tracks.push(legacyKey); unresolved.push(ref);
    }
  }

  return { tracks, unresolved, migrated, hasWarnings: unresolved.length > 0 };
}

export function migratePlaylistTracks(playlist, albums) {
  return migratePlaylistTracksDetailed(playlist, albums).tracks;
}

export function migrateAllPlaylists(playlists, albums) {
  if (!Array.isArray(playlists)) return [];
  return playlists.map((pl) => {
    if (!pl || typeof pl !== 'object') return pl;
    const result = migratePlaylistTracksDetailed(pl, albums);
    return { ...pl, tracks: result.tracks };
  });
}

export function reportMigration(playlists, albums) {
  const trackIndex = buildTrackIndex(albums);
  const legacyIndex = buildLegacyIndex(albums);
  const report = { totalPlaylists: Array.isArray(playlists) ? playlists.length : 0, needsMigration: false, resolvable: 0, pending: 0, playlists: [] };

  for (const pl of playlists || []) {
    if (!pl || !Array.isArray(pl.tracks)) continue;
    let resolvable = 0;
    let pending = 0;
    for (const ref of pl.tracks) {
      const id = normalizeTrackId(ref);
      if (!id) { pending++; continue; }
      if (trackIndex.has(id) || legacyIndex.has(id)) resolvable++;
      else pending++;
    }
    if (pending > 0) report.needsMigration = true;
    report.resolvable += resolvable;
    report.pending += pending;
    report.playlists.push({ id: pl.id, title: pl.title, resolvable, pending, total: resolvable + pending });
  }
  return report;
}

export function resolvePlaylistTracks(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) return [];
  const index = buildTrackIndex(albums);
  const out = [];
  for (const originalId of playlist.tracks) {
    const id = normalizeTrackId(originalId);
    if (!id || id.startsWith('legacy:')) continue;
    const entry = index.get(id);
    if (entry) out.push({ ...entry, trackId: id });
  }
  return out;
}

export function resolvePlaylistTracksDetailed(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) return { resolved: [], unresolved: [] };
  const index = buildTrackIndex(albums);
  const resolved = [];
  const unresolved = [];
  for (const originalId of playlist.tracks) {
    const id = normalizeTrackId(originalId);
    if (!id) { unresolved.push(originalId); continue; }
    if (id.startsWith('legacy:')) { unresolved.push(id); continue; }
    const entry = index.get(id);
    if (entry) resolved.push({ ...entry, trackId: id });
    else unresolved.push(id);
  }
  return { resolved, unresolved };
}

export function searchTracks(query, albums, limit = 20) {
  const q = normalizeSearchText(query);
  const requested = Number(limit);
  const maxResults = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 20;
  if (!q || !Array.isArray(albums)) return [];

  const results = [];
  for (const album of albums) {
    if (!album || typeof album !== 'object') continue;
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    const albumTitle = String(album.title || '');
    const albumTitleNorm = normalizeSearchText(albumTitle);

    for (const track of tracks) {
      const trackId = normalizeTrackId(track?.id);
      if (!trackId) continue;
      const title = String(track.title || '');
      const titleNorm = normalizeSearchText(title);
      const titleMatch = titleNorm.includes(q);
      const albumMatch = albumTitleNorm.includes(q);

      if (!titleMatch && !albumMatch) continue;

      results.push({
        trackId, title: title || '(sem título)', albumTitle: albumTitle || '(sem álbum)',
        albumId: normalizeTrackId(album.id) || '', duration: formatDuration(track.duration ?? track.durationSeconds),
        score: titleMatch ? 2 : 1
      });
      if (results.length >= maxResults * 3) break;
    }
    if (results.length >= maxResults * 3) break;
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, maxResults);
}

export function countPlaylistsWithTrack(trackId, playlists) {
  const id = normalizeTrackId(trackId);
  if (!id || !Array.isArray(playlists)) return 0;
  return playlists.filter((playlist) => {
    if (!Array.isArray(playlist?.tracks)) return false;
    return playlist.tracks.some((item) => {
      const normalized = normalizeTrackId(item);
      return normalized === id || normalized === `legacy:${id}`;
    });
  }).length;
}