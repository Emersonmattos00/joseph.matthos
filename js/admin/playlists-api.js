/* ============================================================
   js/admin/playlists-api.js — v4 (Versão Final Auditada)
   ------------------------------------------------------------
   - UUID-safe em TODAS as operações
   - Migração detalhada, auditável e não destrutiva
   - Preserva referências não resolvidas como `legacy:*`
   - Busca normalizada (sem acento/caixa), retorna String
   - Compatível com playlists.js v4 (reportMigration + resolvePlaylistTracks)
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// Normalização de ID (sempre String)
// ─────────────────────────────────────────────────────────────
function normalizeTrackId(value) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id || null;
}

// ─────────────────────────────────────────────────────────────
// Normalização de texto (busca)
// ─────────────────────────────────────────────────────────────
function normalizeSearchText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

// ─────────────────────────────────────────────────────────────
// Formatação de duração (aceita segundos, mm:ss ou undefined)
// ─────────────────────────────────────────────────────────────
function formatDuration(value) {
  if (value === null || value === undefined || value === '') return '—';

  // Se já é "mm:ss" ou similar, devolve como veio
  if (typeof value === 'string' && value.includes(':')) return value;

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';

  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────
// Índice de faixas por UUID (String)
// ─────────────────────────────────────────────────────────────
function buildTrackIndex(albums) {
  const index = new Map();
  if (!Array.isArray(albums)) return index;

  for (const album of albums) {
    if (!album || typeof album !== 'object') continue;
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];

    tracks.forEach((track, trackIndex) => {
      const id = normalizeTrackId(track?.id);
      if (!id) return;

      // Não sobrescreve (protege contra IDs duplicados)
      if (!index.has(id)) {
        index.set(id, { album, track, trackIndex });
      }
    });
  }

  return index;
}

// ─────────────────────────────────────────────────────────────
// Índice legado "albumId:index" → UUID
// ─────────────────────────────────────────────────────────────
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
      if (!index.has(legacyRef)) {
        index.set(legacyRef, trackId);
      }
    });
  }

  return index;
}

// ─────────────────────────────────────────────────────────────
// Migração detalhada (NÃO destrutiva)
// ─────────────────────────────────────────────────────────────
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

    if (!ref) {
      unresolved.push(originalRef);
      continue;
    }

    // 1) Já é UUID existente no catálogo → preserva
    if (trackIndex.has(ref)) {
      if (!seen.has(ref)) {
        seen.add(ref);
        tracks.push(ref);
      }
      continue;
    }

    // 2) Formato legado "albumId:index" → tenta converter
    if (legacyIndex.has(ref)) {
      const trackId = legacyIndex.get(ref);
      if (trackId && !seen.has(trackId)) {
        seen.add(trackId);
        tracks.push(trackId);
        migrated.push({ from: ref, to: trackId });
      }
      continue;
    }

    // 3) UUID/string que NÃO está no catálogo → preserva como pendente
    const legacyKey = ref.startsWith('legacy:') ? ref : `legacy:${ref}`;
    if (!seen.has(legacyKey)) {
      seen.add(legacyKey);
      tracks.push(legacyKey);
      unresolved.push(ref);
    }
  }

  return {
    tracks,
    unresolved,
    migrated,
    hasWarnings: unresolved.length > 0
  };
}

// ─────────────────────────────────────────────────────────────
// Compat: migração simples (retorna só as tracks)
// ─────────────────────────────────────────────────────────────
export function migratePlaylistTracks(playlist, albums) {
  return migratePlaylistTracksDetailed(playlist, albums).tracks;
}

// ─────────────────────────────────────────────────────────────
// Migração em lote (com relatório agregado)
// ─────────────────────────────────────────────────────────────
export function migrateAllPlaylists(playlists, albums) {
  if (!Array.isArray(playlists)) return [];

  return playlists.map((pl) => {
    if (!pl || typeof pl !== 'object') return pl;
    const result = migratePlaylistTracksDetailed(pl, albums);
    return { ...pl, tracks: result.tracks };
  });
}

// ─────────────────────────────────────────────────────────────
// Relatório de migração (usado pelo banner do playlists.js)
// ─────────────────────────────────────────────────────────────
export function reportMigration(playlists, albums) {
  const trackIndex = buildTrackIndex(albums);
  const legacyIndex = buildLegacyIndex(albums);

  const report = {
    totalPlaylists: Array.isArray(playlists) ? playlists.length : 0,
    needsMigration: false,
    resolvable: 0,
    pending: 0,
    playlists: []
  };

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
    report.playlists.push({
      id: pl.id,
      title: pl.title,
      resolvable,
      pending,
      total: resolvable + pending
    });
  }

  return report;
}

// ─────────────────────────────────────────────────────────────
// Resolução (para renderização de faixas)
// ─────────────────────────────────────────────────────────────
export function resolvePlaylistTracks(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) return [];

  const index = buildTrackIndex(albums);
  const out = [];

  for (const originalId of playlist.tracks) {
    const id = normalizeTrackId(originalId);
    if (!id) continue;

    // Se for ref pendente (`legacy:*`), ignora na resolução
    if (id.startsWith('legacy:')) continue;

    const entry = index.get(id);
    if (entry) {
      out.push({ ...entry, trackId: id });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Resolução detalhada (com pendentes)
// ─────────────────────────────────────────────────────────────
export function resolvePlaylistTracksDetailed(playlist, albums) {
  if (!playlist || !Array.isArray(playlist.tracks)) {
    return { resolved: [], unresolved: [] };
  }

  const index = buildTrackIndex(albums);
  const resolved = [];
  const unresolved = [];

  for (const originalId of playlist.tracks) {
    const id = normalizeTrackId(originalId);
    if (!id) { unresolved.push(originalId); continue; }

    if (id.startsWith('legacy:')) { unresolved.push(id); continue; }

    const entry = index.get(id);
    if (entry) {
      resolved.push({ ...entry, trackId: id });
    } else {
      unresolved.push(id);
    }
  }

  return { resolved, unresolved };
}

// ─────────────────────────────────────────────────────────────
// Busca
// ─────────────────────────────────────────────────────────────
export function searchTracks(query, albums, limit = 20) {
  const q = normalizeSearchText(query);
  const requested = Number(limit);
  const maxResults = Number.isFinite(requested)
    ? Math.max(1, Math.min(100, Math.floor(requested)))
    : 20;

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
        trackId,                              // ← String, não Number
        title: title || '(sem título)',
        albumTitle: albumTitle || '(sem álbum)',
        albumId: normalizeTrackId(album.id) || '',
        duration: formatDuration(track.duration ?? track.durationSeconds),
        score: titleMatch ? 2 : 1
      });

      if (results.length >= maxResults * 3) break;
    }
    if (results.length >= maxResults * 3) break;
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, maxResults);
}

// ─────────────────────────────────────────────────────────────
// Contagem de playlists que contêm uma faixa
// ─────────────────────────────────────────────────────────────
export function countPlaylistsWithTrack(trackId, playlists) {
  const id = normalizeTrackId(trackId);
  if (!id || !Array.isArray(playlists)) return 0;

  return playlists.filter((playlist) => {
    if (!Array.isArray(playlist?.tracks)) return false;
    return playlist.tracks.some((item) => {
      const normalized = normalizeTrackId(item);
      return normalized === id ||
             normalized === `legacy:${id}`;
    });
  }).length;
}

// ─────────────────────────────────────────────────────────────
// Utilitário de integridade do catálogo (para debug)
// ─────────────────────────────────────────────────────────────
export function analyzeCatalogIntegrity(albums) {
  const issues = {
    albumsWithoutId: 0,
    duplicateAlbumIds: 0,
    tracksWithoutId: 0,
    duplicateTrackIds: 0
  };

  if (!Array.isArray(albums)) return issues;

  const albumIds = new Set();
  const trackIds = new Set();

  for (const album of albums) {
    if (!album || typeof album !== 'object') continue;

    const albumId = normalizeTrackId(album.id);
    if (!albumId) issues.albumsWithoutId++;
    else if (albumIds.has(albumId)) issues.duplicateAlbumIds++;
    else albumIds.add(albumId);

    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    for (const track of tracks) {
      const trackId = normalizeTrackId(track?.id);
      if (!trackId) issues.tracksWithoutId++;
      else if (trackIds.has(trackId)) issues.duplicateTrackIds++;
      else trackIds.add(trackId);
    }
  }

  return issues;
}