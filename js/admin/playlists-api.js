/* ============================================================
   js/admin/playlists-api.js — v3 (UUID-safe)
   ------------------------------------------------------------
   - IDs de faixas sempre como String (UUID)
   - Compatibilidade com IDs numéricos legados (convertidos p/ string)
   - Migração NÃO destrutiva: preserva referências pendentes
   - Busca retorna trackId como String
   ============================================================ */

// ─────────────────────────────────────────────────────────────
// Índice de faixas por ID (String)
// ─────────────────────────────────────────────────────────────
function buildIndex(albums) {
  const index = new Map();
  if (!Array.isArray(albums)) return index;

  for (const album of albums) {
    if (!album || !Array.isArray(album.tracks)) continue;
    album.tracks.forEach((track, trackIndex) => {
      if (!track || track.id === undefined || track.id === null) return;
      const id = String(track.id);
      if (!id) return;
      index.set(id, { album, track, trackIndex });
    });
  }
  return index;
}

// ─────────────────────────────────────────────────────────────
// Resolução: trackId (String) → { album, track, trackIndex }
// ─────────────────────────────────────────────────────────────
export function resolvePlaylistTracks(playlist, albums) {
  const index = buildIndex(albums);
  const raw = Array.isArray(playlist?.tracks) ? playlist.tracks : [];

  const out = [];
  for (const ref of raw) {
    const id = String(ref ?? '').trim();
    if (!id) continue;

    const entry = index.get(id);
    if (entry) {
      out.push({ ...entry, trackId: id });
    }
    // Referências não resolvidas são silenciosamente omitidas do resolved,
    // mas PERMANECEM em playlist.tracks (não são apagadas).
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// Busca por título/álbum — retorna trackId como String
// ─────────────────────────────────────────────────────────────
export function searchTracks(query, albums, limit = 15) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];

  const results = [];
  for (const album of albums || []) {
    if (!album || !Array.isArray(album.tracks)) continue;

    const albumTitle = String(album.title || '');
    for (const track of album.tracks) {
      if (!track || track.id === undefined || track.id === null) continue;

      const title = String(track.title || '').toLowerCase();
      const albumMatch = albumTitle.toLowerCase().includes(q);
      const titleMatch = title.includes(q);
      if (!titleMatch && !albumMatch) continue;

      results.push({
        trackId: String(track.id),   // ← String, não Number
        title: track.title || '(sem título)',
        albumTitle: album.title || '(sem álbum)',
        albumId: album.id ? String(album.id) : '',
        duration: track.duration || '—',
        score: titleMatch ? 2 : 1
      });

      if (results.length >= limit * 3) break;
    }
    if (results.length >= limit * 3) break;
  }

  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return results.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────
// Migração — NÃO destrutiva
// ------------------------------------------------------------
// Converte referências legadas "albumId:index" (ou índice numérico)
// para UUID quando possível. Referências que não puderem ser
// resolvidas são PRESERVADAS como string "legacy:<valor>".
// ─────────────────────────────────────────────────────────────
export function migratePlaylistTracks(tracks, albums) {
  if (!Array.isArray(tracks)) return [];

  const index = buildIndex(albums);

  // Mapa auxiliar: albumId → { index → UUID }
  const albumById = new Map();
  for (const album of albums || []) {
    if (!album || !Array.isArray(album.tracks)) continue;
    const map = new Map();
    album.tracks.forEach((track, idx) => {
      if (track && track.id !== undefined) map.set(idx, String(track.id));
    });
    albumById.set(String(album.id), map);
  }

  const out = [];
  const seen = new Set();

  for (const ref of tracks) {
    const raw = String(ref ?? '').trim();
    if (!raw) continue;

    // 1) Já é UUID válido e existe no índice
    if (index.has(raw)) {
      if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
      continue;
    }

    // 2) Formato legado "albumId:index"
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const albumId = raw.slice(0, colon);
      const idx = Number(raw.slice(colon + 1));
      const map = albumById.get(albumId);
      if (map && Number.isInteger(idx) && map.has(idx)) {
        const id = map.get(idx);
        if (!seen.has(id)) { seen.add(id); out.push(id); }
        continue;
      }
    }

    // 3) Índice numérico puro (fallback legado) — não sabemos o álbum,
    //    então PRESERVAMOS como referência pendente.
    // 4) Qualquer outra coisa: preserva com prefixo legacy:
    const legacyKey = raw.startsWith('legacy:') ? raw : `legacy:${raw}`;
    if (!seen.has(legacyKey)) { seen.add(legacyKey); out.push(legacyKey); }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Migração em lote de playlists
// ─────────────────────────────────────────────────────────────
export function migrateAllPlaylists(playlists, albums) {
  if (!Array.isArray(playlists)) return [];
  return playlists.map((pl) => {
    if (!pl || typeof pl !== 'object') return pl;
    const tracks = migratePlaylistTracks(pl.tracks, albums);
    return { ...pl, tracks };
  });
}

// ─────────────────────────────────────────────────────────────
// Relatório de migração (NÃO aplica nada)
// ─────────────────────────────────────────────────────────────
export function reportMigration(playlists, albums) {
  const index = buildIndex(albums);
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
      const raw = String(ref ?? '').trim();
      if (!raw) continue;

      if (index.has(raw) || raw.includes(':')) resolvable++;
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