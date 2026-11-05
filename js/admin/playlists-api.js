/* ============================================================
   admin/playlists-api.js
   ------------------------------------------------------------
   Gerenciamento de referências de faixas nas playlists.

   COMPATIBILIDADE:
   - tracks.id UUID (string)
   - IDs numéricos legados
   - Referências posicionais "albumId:index"
   - Álbuns com tracks aninhadas
   - Catálogo com tracks em array separado

   SEGURANÇA E INTEGRIDADE:
   - Validação de catálogo e playlists
   - Proteção contra IDs duplicados
   - Relatórios defensivos
   - Índices reutilizáveis
   - Proteção contra alterações estruturais
   - Migração posicional com confirmação explícita
   - Migração NUNCA retorna tracks vazias por playlist inválida

   IMPORTANTE:
   "albumId:index" só pode ser migrado com segurança
   contra o catálogo e a ordem HISTÓRICOS das faixas.

   confirmHistoricalOrder: true significa que o chamador
   assume expressamente essa responsabilidade.
   ============================================================ */

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const MERGE_FIELDS = new Set();

const _reports = new WeakMap();

/* ============================================================
   1. NORMALIZAÇÃO E VALIDAÇÃO BÁSICA
   ============================================================ */

export function normalizeTrackId(value) {
  if (typeof value === 'string') {
    const id = value.trim();
    return id || null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

export function looksLikeUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isNumericLegacyReference(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return false;
    return Number.isSafeInteger(Number(trimmed));
  }
  return false;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function safeRecord(value) {
  if (!isPlainObject(value)) return {};
  try {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !BLOCKED_KEYS.has(key))
    );
  } catch {
    return {};
  }
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    throw new TypeError(
      'Não foi possível copiar o relatório. ' +
      'Os dados precisam ser serializáveis em JSON.'
    );
  }
}

function normalizeOptions(options) {
  if (options === null || options === undefined) return {};
  if (!isPlainObject(options)) {
    throw new TypeError('As opções devem ser fornecidas como objeto simples.');
  }
  return options;
}

function mergeTrackRecords(primary, secondary) {
  const a = safeRecord(primary);
  const b = safeRecord(secondary);
  const result = { ...b, ...a };

  for (const [key, value] of Object.entries(b)) {
    if (BLOCKED_KEYS.has(key)) continue;

    const current = result[key];

    if (current === null || current === undefined || current === '') {
      result[key] = value;
      continue;
    }

    if (MERGE_FIELDS.has(key) && isPlainObject(current) && isPlainObject(value)) {
      result[key] = { ...safeRecord(value), ...safeRecord(current) };
    }
  }

  return result;
}

/* ============================================================
   2. ASSINATURA ESTRUTURAL DO CATÁLOGO
   ============================================================ */

/**
 * Detecta alterações em:
 * - Identificadores de álbuns
 * - Identificadores de faixas
 * - Ordem das faixas
 * - Associação entre faixa e álbum
 *
 * NÃO detecta alterações de metadados (title, duration, cover).
 * Decisão intencional: a assinatura protege a integridade
 * estrutural necessária à migração posicional.
 */
function signatureOfCatalog(catalog) {
  return JSON.stringify(
    catalog.map(album => ({
      id: normalizeTrackId(album?.id),
      tracks: Array.isArray(album?.tracks)
        ? album.tracks.map(track => ({
            id: normalizeTrackId(track?.id),
            albumId: normalizeTrackId(track?.albumId)
          }))
        : null
    }))
  );
}

function validateAlbumTracksShape(album) {
  if (
    album.tracks !== undefined &&
    album.tracks !== null &&
    !Array.isArray(album.tracks)
  ) {
    throw new TypeError(
      `Álbum ${normalizeTrackId(album.id) || '?'} possui tracks inválido.`
    );
  }
}

/* ============================================================
   3. NORMALIZAÇÃO DO CATÁLOGO
   ============================================================ */

/**
 * Normaliza o catálogo.
 *
 * @param {Array} albums
 * @param {Array} tracks
 * @param {Object} [options]
 * @param {boolean} [options.throwOnDuplicateAlbumId=true]
 *   Se `true`, lança em álbum duplicado. Se `false`, mantém o
 *   PRIMEIRO álbum com o ID e DESCARTA os demais (o descarte é
 *   registrado em `duplicateAlbumIds`; use `getCatalogReport`
 *   para inspecionar e `assertCatalogIntegrity` para bloquear
 *   operações críticas).
 */
export function normalizeCatalog(albums = [], tracks = [], options) {
  const opts = normalizeOptions(options);

  const throwOnDuplicateAlbumId = opts.throwOnDuplicateAlbumId ?? true;

  if (typeof throwOnDuplicateAlbumId !== 'boolean') {
    throw new TypeError('throwOnDuplicateAlbumId deve ser boolean.');
  }

  if (!Array.isArray(albums)) {
    throw new TypeError('normalizeCatalog: albums deve ser um array.');
  }
  if (!Array.isArray(tracks)) {
    throw new TypeError('normalizeCatalog: tracks deve ser um array.');
  }

  const albumIds = new Set();
  const duplicateAlbumIds = new Set();
  const invalidAlbums = [];

  /* 3.1 Validação dos álbuns */
  for (const album of albums) {
    if (!album || typeof album !== 'object' || Array.isArray(album)) {
      invalidAlbums.push({ reason: 'invalid_album_object', album });
      continue;
    }

    try {
      validateAlbumTracksShape(album);
    } catch (err) {
      invalidAlbums.push({
        reason: 'invalid_album_tracks',
        albumId: normalizeTrackId(album.id),
        message: err.message,
        album
      });
      continue;
    }

    const albumId = normalizeTrackId(album.id);

    if (!albumId) {
      invalidAlbums.push({ reason: 'missing_album_id', album });
      continue;
    }

    if (albumIds.has(albumId)) {
      duplicateAlbumIds.add(albumId);
      if (throwOnDuplicateAlbumId) {
        throw new Error(`ID de álbum duplicado no catálogo: ${albumId}`);
      }
      continue;
    }

    albumIds.add(albumId);
  }

  /* 3.2 Organização das faixas externas */
  const tracksByAlbum = new Map();
  const orphanTracks = [];
  const invalidTracks = [];

  for (const track of tracks) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      invalidTracks.push({
        source: 'external_tracks',
        albumId: null,
        reason: 'invalid_track_object',
        track
      });
      continue;
    }

    const albumId = normalizeTrackId(track.albumId);
    const trackId = normalizeTrackId(track.id);

    if (!trackId) {
      invalidTracks.push({
        source: 'external_tracks',
        albumId,
        reason: 'missing_track_id',
        track
      });
      continue;
    }

    if (!albumId) {
      orphanTracks.push({ ...safeRecord(track), orphanReason: 'missing_album_id' });
      continue;
    }

    if (!albumIds.has(albumId)) {
      orphanTracks.push({ ...safeRecord(track), orphanReason: 'album_not_found' });
      continue;
    }

    if (!tracksByAlbum.has(albumId)) tracksByAlbum.set(albumId, []);
    tracksByAlbum.get(albumId).push(track);
  }

  /* 3.3 Normalização das faixas de cada álbum */
  const globalTrackIds = new Map();
  const duplicateTrackIds = [];
  const duplicateTracksWithinAlbum = [];
  const seenAlbumIds = new Set();

  const normalized = albums
    .filter(album => {
      if (!album || typeof album !== 'object' || Array.isArray(album)) return false;
      const id = normalizeTrackId(album.id);
      if (!id || seenAlbumIds.has(id)) return false;
      if (!albumIds.has(id)) return false;
      seenAlbumIds.add(id);
      try {
        validateAlbumTracksShape(album);
        return true;
      } catch {
        return false;
      }
    })
    .map(album => {
      const albumId = normalizeTrackId(album.id);
      const nestedTracks = Array.isArray(album.tracks) ? album.tracks : [];
      const separateTracks = tracksByAlbum.get(albumId) || [];

      const merged = [];
      const localIndex = new Map();

      const processTrack = (track, source) => {
        if (!track || typeof track !== 'object' || Array.isArray(track)) {
          invalidTracks.push({ source, albumId, reason: 'invalid_track_object', track });
          return;
        }

        const trackId = normalizeTrackId(track.id);
        if (!trackId) {
          invalidTracks.push({ source, albumId, reason: 'missing_track_id', track });
          return;
        }

        const declaredAlbumId = normalizeTrackId(track.albumId);
        if (declaredAlbumId && declaredAlbumId !== albumId) {
          orphanTracks.push({
            ...safeRecord(track),
            orphanReason: 'album_mismatch',
            expectedAlbumId: albumId,
            declaredAlbumId
          });
          return;
        }

        const previousAlbum = globalTrackIds.get(trackId);
        if (previousAlbum && previousAlbum !== albumId) {
          duplicateTrackIds.push({ trackId, albums: [previousAlbum, albumId] });
          return;
        }

        if (localIndex.has(trackId)) {
          const idx = localIndex.get(trackId);
          duplicateTracksWithinAlbum.push({
            trackId,
            albumId,
            note: 'merged_with_previous_occurrence'
          });
          merged[idx] = mergeTrackRecords(merged[idx], track);
          return;
        }

        localIndex.set(trackId, merged.length);
        globalTrackIds.set(trackId, albumId);
        merged.push({ ...safeRecord(track), id: trackId });
      };

      for (const track of nestedTracks) processTrack(track, 'album_nested_tracks');
      for (const track of separateTracks) processTrack(track, 'external_tracks');

      return { ...safeRecord(album), id: albumId, tracks: merged };
    });

  /* 3.4 Relatório de integridade */
  const hasIntegrityErrors =
    duplicateAlbumIds.size > 0 ||
    duplicateTrackIds.length > 0 ||
    orphanTracks.length > 0 ||
    invalidTracks.length > 0 ||
    invalidAlbums.length > 0;

  const hasWarnings = duplicateTracksWithinAlbum.length > 0;

  _reports.set(normalized, {
    orphanTracks,
    invalidTracks,
    invalidAlbums,
    duplicateAlbumIds: [...duplicateAlbumIds],
    duplicateTrackIds,
    duplicateTracksWithinAlbum,
    hasIntegrityErrors,
    hasWarnings,
    signature: signatureOfCatalog(normalized)
  });

  return normalized;
}

/* ============================================================
   4. RELATÓRIOS E INTEGRIDADE
   ============================================================ */

export function getCatalogReport(normalizedCatalog) {
  if (
    !normalizedCatalog ||
    typeof normalizedCatalog !== 'object' ||
    !_reports.has(normalizedCatalog)
  ) {
    throw new Error(
      'Catálogo não validado. Execute normalizeCatalog() antes da análise.'
    );
  }

  const internal = _reports.get(normalizedCatalog);

  if (signatureOfCatalog(normalizedCatalog) !== internal.signature) {
    throw new Error(
      'Catálogo modificado após normalizeCatalog(). ' +
      'Execute normalizeCatalog() novamente.'
    );
  }

  return {
    orphanTracks: cloneJson(internal.orphanTracks),
    invalidTracks: cloneJson(internal.invalidTracks),
    invalidAlbums: cloneJson(internal.invalidAlbums),
    duplicateAlbumIds: [...internal.duplicateAlbumIds],
    duplicateTrackIds: cloneJson(internal.duplicateTrackIds),
    duplicateTracksWithinAlbum: cloneJson(internal.duplicateTracksWithinAlbum),
    hasIntegrityErrors: internal.hasIntegrityErrors,
    hasWarnings: internal.hasWarnings
  };
}

export function getOrphanTracks(normalizedCatalog) {
  return getCatalogReport(normalizedCatalog).orphanTracks;
}

export function assertCatalogIntegrity(normalizedCatalog) {
  const report = getCatalogReport(normalizedCatalog);
  if (!report.hasIntegrityErrors) return true;

  const parts = [];
  if (report.duplicateAlbumIds.length) parts.push(`${report.duplicateAlbumIds.length} álbum(ns) duplicado(s)`);
  if (report.duplicateTrackIds.length) parts.push(`${report.duplicateTrackIds.length} faixa(s) em múltiplos álbuns`);
  if (report.orphanTracks.length) parts.push(`${report.orphanTracks.length} faixa(s) órfã(s)`);
  if (report.invalidTracks.length) parts.push(`${report.invalidTracks.length} faixa(s) inválida(s)`);
  if (report.invalidAlbums.length) parts.push(`${report.invalidAlbums.length} álbum(ns) inválido(s)`);

  throw new Error(`Catálogo inconsistente: ${parts.join('; ')}.`);
}

function requireValidCatalog(albums) {
  const report = getCatalogReport(albums);
  if (report.hasIntegrityErrors) assertCatalogIntegrity(albums);
  return albums;
}

/* ============================================================
   5. ÍNDICES INTERNOS
   ============================================================ */

function buildLegacyIndexInternal(albums) {
  const index = new Map();

  for (const album of albums) {
    const albumId = normalizeTrackId(album.id);
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];

    tracks.forEach((track, idx) => {
      const id = normalizeTrackId(track.id);
      if (!id) return;

      const key = `${albumId}:${idx}`;

      if (index.has(key) && index.get(key) !== id) {
        throw new Error(`Referência legada ambígua: ${key}`);
      }

      index.set(key, id);
    });
  }

  return index;
}

function buildTrackIndexInternal(albums) {
  const index = new Map();

  for (const album of albums) {
    const tracks = Array.isArray(album.tracks) ? album.tracks : [];

    tracks.forEach((track, trackIndex) => {
      const id = normalizeTrackId(track.id);
      if (!id) return;

      if (index.has(id)) {
        const previous = index.get(id);
        throw new Error(
          `ID de faixa duplicado no catálogo: ${id} ` +
          `(álbuns ${previous.album.id} e ${album.id}).`
        );
      }

      index.set(id, { album, track, trackIndex });
    });
  }

  return index;
}

/**
 * ⚠️ Aceita APENAS catálogo produzido por `normalizeCatalog`.
 */
export function buildLegacyIndex(albums) {
  requireValidCatalog(albums);
  return buildLegacyIndexInternal(albums);
}

/**
 * ⚠️ Aceita APENAS catálogo produzido por `normalizeCatalog`.
 */
export function buildTrackIndex(albums) {
  requireValidCatalog(albums);
  return buildTrackIndexInternal(albums);
}

/* ============================================================
   6. RESOLUÇÃO DE REFERÊNCIAS
   ============================================================ */

function resolveWithIndex(playlist, trackIndex) {
  const resolved = [];
  const unresolved = [];
  const duplicates = [];

  if (!playlist || !Array.isArray(playlist.tracks)) {
    return { resolved, unresolved, duplicates };
  }

  const seen = new Set();

  for (const reference of playlist.tracks) {
    const id = normalizeTrackId(reference);

    if (!id) {
      unresolved.push(reference);
      continue;
    }

    const entry = trackIndex.get(id);
    if (!entry) {
      unresolved.push(reference);
      continue;
    }

    if (seen.has(id)) {
      duplicates.push(reference);
      continue;
    }

    seen.add(id);
    resolved.push({ ...entry, trackId: id });
  }

  return { resolved, unresolved, duplicates };
}

export function resolvePlaylistTracksDetailed(playlist, albums) {
  requireValidCatalog(albums);
  const index = buildTrackIndexInternal(albums);
  return resolveWithIndex(playlist, index);
}

export function resolvePlaylistTracks(playlist, albums) {
  return resolvePlaylistTracksDetailed(playlist, albums).resolved;
}

/* ============================================================
   7. MIGRAÇÃO DE REFERÊNCIAS LEGADAS
   ============================================================ */

function migratableWithIndex(playlist, legacyIndex) {
  const refs = [];
  if (!playlist || !Array.isArray(playlist.tracks)) return refs;

  for (const ref of playlist.tracks) {
    if (typeof ref !== 'string') continue;
    const trimmed = ref.trim();
    if (!trimmed.includes(':')) continue;

    if (legacyIndex.has(trimmed)) {
      refs.push({
        original: ref,
        normalized: trimmed,
        migratedTo: legacyIndex.get(trimmed)
      });
    }
  }

  return refs;
}

export function hasMigratableLegacyRefs(playlist, albums) {
  requireValidCatalog(albums);
  const legacyIndex = buildLegacyIndexInternal(albums);
  return migratableWithIndex(playlist, legacyIndex).length > 0;
}

export function getMigratableRefs(playlist, albums) {
  requireValidCatalog(albums);
  const legacyIndex = buildLegacyIndexInternal(albums);
  return migratableWithIndex(playlist, legacyIndex);
}

/**
 * Migração detalhada.
 *
 * ATENÇÃO:
 * A migração posicional depende da ordem histórica do catálogo.
 *
 * @throws {TypeError} se `playlist` é inválida (não-objeto ou
 *   `tracks` não é array). NÃO retorna `tracks: []` para playlist
 *   inválida — isso poderia apagar referências se o chamador
 *   salvar o retorno.
 * @throws {Error} se `confirmHistoricalOrder` não for `true` ou
 *   se o catálogo for inválido.
 */
export function migratePlaylistTracksDetailed(playlist, albums, options) {
  const opts = normalizeOptions(options);

  const confirmHistoricalOrder = opts.confirmHistoricalOrder ?? false;

  if (typeof confirmHistoricalOrder !== 'boolean') {
    throw new TypeError('confirmHistoricalOrder deve ser boolean.');
  }

  if (!confirmHistoricalOrder) {
    throw new Error(
      'Migração bloqueada: confirme que o catálogo corresponde à ordem ' +
      'histórica das faixas usando confirmHistoricalOrder: true.'
    );
  }

  requireValidCatalog(albums);

  if (!playlist || typeof playlist !== 'object' || Array.isArray(playlist)) {
    throw new TypeError('Migração cancelada: objeto de playlist inválido.');
  }

  if (!Array.isArray(playlist.tracks)) {
    throw new TypeError(
      'Migração cancelada: tracks da playlist não é um array. ' +
      'As referências originais foram preservadas.'
    );
  }

  const legacyIndex = buildLegacyIndexInternal(albums);
  const trackIndex = buildTrackIndexInternal(albums);

  return migratePlaylistWithIndexes(playlist, legacyIndex, trackIndex);
}

export function migratePlaylistTracks(playlist, albums, options) {
  return migratePlaylistTracksDetailed(playlist, albums, options).tracks;
}

/* ============================================================
   8. MIGRAÇÃO EM LOTE
   ============================================================ */

export function migrateAllPlaylists(playlists, albums, options) {
  if (!Array.isArray(playlists)) {
    throw new TypeError('migrateAllPlaylists: `playlists` deve ser um array.');
  }

  const opts = normalizeOptions(options);
  if (opts.confirmHistoricalOrder !== true) {
    throw new Error(
      'Migração bloqueada: confirme `confirmHistoricalOrder: true` ' +
      'para confirmar a ordem histórica do catálogo.'
    );
  }

  requireValidCatalog(albums);

  const legacyIndex = buildLegacyIndexInternal(albums);
  const trackIndex = buildTrackIndexInternal(albums);

  return playlists.map(playlist => {
    if (
      !playlist ||
      typeof playlist !== 'object' ||
      Array.isArray(playlist) ||
      !Array.isArray(playlist.tracks)
    ) {
      return playlist;
    }

    const result = migratePlaylistWithIndexes(playlist, legacyIndex, trackIndex);
    return { ...playlist, tracks: result.tracks };
  });
}

/**
 * Versão detalhada em lote. NUNCA lança — retorna
 * `{ ok, error?, playlists, results }`.
 */
export function migrateAllPlaylistsDetailed(playlists, albums, options) {
  if (!Array.isArray(playlists)) {
    return {
      ok: false,
      error: 'playlists deve ser um array.',
      playlists: [],
      results: []
    };
  }

  let opts;
  try {
    opts = normalizeOptions(options);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'Opções inválidas.',
      playlists: [...playlists],
      results: playlists.map((_, index) => ({
        index,
        ok: false,
        error: err?.message || 'Opções inválidas.'
      }))
    };
  }

  if (opts.confirmHistoricalOrder !== true) {
    return {
      ok: false,
      error: 'Confirmação da ordem histórica obrigatória.',
      playlists: [...playlists],
      results: playlists.map((_, index) => ({
        index,
        ok: false,
        error: 'Migração posicional não confirmada.'
      }))
    };
  }

  try {
    requireValidCatalog(albums);
  } catch (err) {
    return {
      ok: false,
      error: err?.message || 'Catálogo inválido.',
      playlists: [...playlists],
      results: playlists.map((_, index) => ({
        index,
        ok: false,
        error: err?.message || 'Catálogo inválido.'
      }))
    };
  }

  let legacyIndex;
  let trackIndex;

  try {
    legacyIndex = buildLegacyIndexInternal(albums);
    trackIndex = buildTrackIndexInternal(albums);
  } catch (err) {
    const message = err?.message || 'Falha ao construir índices do catálogo.';
    return {
      ok: false,
      error: message,
      playlists: [...playlists],
      results: playlists.map((_, index) => ({
        index,
        ok: false,
        error: message
      }))
    };
  }

  const results = [];

  const migratedPlaylists = playlists.map((playlist, index) => {
    if (!playlist || typeof playlist !== 'object' || Array.isArray(playlist)) {
      results.push({
        index,
        ok: false,
        error: 'Objeto de playlist inválido.'
      });
      return playlist;
    }

    if (!Array.isArray(playlist.tracks)) {
      results.push({
        index,
        ok: false,
        error: 'tracks da playlist não é um array.'
      });
      return playlist;
    }

    try {
      const result = migratePlaylistWithIndexes(playlist, legacyIndex, trackIndex);
      results.push({ index, ok: true, ...result });
      return { ...playlist, tracks: result.tracks };
    } catch (err) {
      results.push({
        index,
        ok: false,
        error: err?.message || 'Falha na migração.'
      });
      return playlist;
    }
  });

  const hasErrors = results.some(result => !result.ok);

  return {
    ok: !hasErrors,
    playlists: migratedPlaylists,
    results
  };
}

function migratePlaylistWithIndexes(playlist, legacyIndex, trackIndex) {
  const tracks = [];
  const migrated = [];
  const unresolved = [];
  const numericLegacy = [];
  const discarded = [];
  const duplicates = [];

  const seen = new Set();

  const addTrack = (ref, original) => {
    if (seen.has(ref)) {
      duplicates.push({ reference: ref, original });
      return false;
    }
    seen.add(ref);
    tracks.push(ref);
    return true;
  };

  for (const ref of playlist.tracks) {
    if (ref === null || ref === undefined) {
      discarded.push({ original: ref, reason: 'empty_reference' });
      continue;
    }

    if (typeof ref === 'number') {
      if (Number.isSafeInteger(ref) && ref > 0) {
        const value = String(ref);
        if (addTrack(value, ref)) {
          numericLegacy.push({ original: ref, preservedAs: value });
        }
      } else {
        discarded.push({ original: ref, reason: 'invalid_number' });
      }
      continue;
    }

    if (typeof ref !== 'string') {
      discarded.push({ original: ref, reason: 'unsupported_type' });
      continue;
    }

    const original = ref.trim();
    if (!original) {
      discarded.push({ original: ref, reason: 'empty_string' });
      continue;
    }

    if (original.includes(':')) {
      const id = legacyIndex.get(original);
      if (id) {
        if (addTrack(id, ref)) {
          migrated.push({ original: ref, trackId: id });
        }
      } else if (addTrack(original, ref)) {
        unresolved.push(ref);
      }
      continue;
    }

    if (isNumericLegacyReference(original)) {
      if (addTrack(original, ref)) {
        numericLegacy.push({ original: ref, preservedAs: original });
      }
      continue;
    }

    if (!trackIndex.has(original)) {
      if (addTrack(original, ref)) unresolved.push(ref);
    } else {
      addTrack(original, ref);
    }
  }

  return { tracks, migrated, unresolved, numericLegacy, discarded, duplicates };
}

/* ============================================================
   9. FORMATAÇÃO DE DURAÇÃO
   ------------------------------------------------------------
   - < 1h  → "M:SS"
   - >= 1h → "H:MM:SS"
   Sem limite artificial de 24h.
   ============================================================ */

export function formatDuration(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && !value.trim())
  ) {
    return '—';
  }

  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';

  const total = Math.floor(seconds);

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;

  if (hours > 0) {
    return (
      `${hours}:` +
      `${String(minutes).padStart(2, '0')}:` +
      `${String(remaining).padStart(2, '0')}`
    );
  }

  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

/* ============================================================
   10. BUSCA DE FAIXAS
   ============================================================ */

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

export function searchTracks(query, albums, limit = 20) {
  return searchTracksDetailed(query, albums, limit).results;
}

/**
 * Busca detalhada.
 *
 * Exige catálogo produzido por `normalizeCatalog` (valida via
 * `getCatalogReport`).
 */
export function searchTracksDetailed(query, albums, limit = 20) {
  if (!Array.isArray(albums)) {
    throw new TypeError('searchTracks: albums deve ser um array.');
  }

  getCatalogReport(albums);

  const q = normalizeSearchText(query);

  const requested = Number(limit);
  const maxResults = Number.isFinite(requested)
    ? Math.max(1, Math.min(Math.floor(requested), 100))
    : 20;

  const results = [];
  let invalidCount = 0;
  let invalidAlbumCount = 0;

  for (const album of albums) {
    if (!album || typeof album !== 'object' || Array.isArray(album)) {
      invalidAlbumCount++;
      continue;
    }

    try {
      validateAlbumTracksShape(album);
    } catch {
      invalidAlbumCount++;
      continue;
    }

    const albumId = normalizeTrackId(album.id);
    if (!albumId) {
      invalidAlbumCount++;
      continue;
    }

    const tracks = Array.isArray(album.tracks) ? album.tracks : [];
    const albumTitle = String(album.title || '');
    const normalizedAlbum = normalizeSearchText(albumTitle);

    for (const track of tracks) {
      if (!track || typeof track !== 'object' || Array.isArray(track)) {
        invalidCount++;
        continue;
      }

      const id = normalizeTrackId(track.id);
      if (!id) {
        invalidCount++;
        continue;
      }

      if (!q || results.length >= maxResults) continue;

      const title = String(track.title || '');
      const normalizedTitle = normalizeSearchText(title);

      if (normalizedTitle.includes(q) || normalizedAlbum.includes(q)) {
        results.push({
          trackId: id,
          title: title || '(sem título)',
          albumTitle,
          albumId,
          duration: formatDuration(track.durationSeconds ?? track.duration)
        });
      }
    }
  }

  return { results, invalidCount, invalidAlbumCount };
}

/* ============================================================
   11. CONTAGEM DE PLAYLISTS POR FAIXA
   ============================================================ */

export function countPlaylistsWithTrack(trackId, playlists) {
  const id = normalizeTrackId(trackId);
  if (!id || !Array.isArray(playlists)) return 0;

  return playlists.filter(playlist => {
    if (
      !playlist ||
      typeof playlist !== 'object' ||
      !Array.isArray(playlist.tracks)
    ) {
      return false;
    }
    return playlist.tracks.some(track => normalizeTrackId(track) === id);
  }).length;
}

/* ============================================================
   12. ANÁLISE COMPLETA DAS PLAYLISTS
   ============================================================ */

/**
 * Analisa o catálogo e as playlists.
 *
 * NÃO exige catálogo íntegro — registra as falhas e desabilita
 * resolução/migração por playlist quando o catálogo não é
 * utilizável.
 *
 * Playlists inválidas (objeto inválido, `tracks` não array, `id`
 * ausente) são registradas em `invalidPlaylists` E em
 * `errorsByPlaylist` para visibilidade.
 *
 * @throws {TypeError} se `playlists` não for array.
 * @throws {Error} se `normalizedCatalog` não foi normalizado ou
 *   foi modificado após normalização.
 */
export function analyzePlaylists(normalizedCatalog, playlists) {
  if (!Array.isArray(playlists)) {
    throw new TypeError('analyzePlaylists: playlists deve ser um array.');
  }

  const catalogReport = getCatalogReport(normalizedCatalog);

  const {
    orphanTracks,
    invalidTracks,
    invalidAlbums,
    duplicateAlbumIds,
    duplicateTrackIds,
    duplicateTracksWithinAlbum,
    hasIntegrityErrors,
    hasWarnings
  } = catalogReport;

  const unresolvedByPlaylist = new Map();
  const duplicatesByPlaylist = new Map();
  const migratableByPlaylist = new Map();
  const numericLegacyByPlaylist = new Map();
  const errorsByPlaylist = new Map();
  const countsByPlaylist = new Map();
  const playlistKeys = new Map();

  const playlistIds = new Set();
  const duplicatePlaylistIds = [];
  const invalidPlaylists = [];

  const addError = (key, error) => {
    if (!errorsByPlaylist.has(key)) errorsByPlaylist.set(key, []);
    errorsByPlaylist.get(key).push(error);
  };

  /* 12.1 Índices construídos uma única vez */
  const catalogUsable = !hasIntegrityErrors;

  let trackIndex = new Map();
  let legacyIndex = new Map();
  let catalogIndexError = null;

  if (catalogUsable) {
    try {
      trackIndex = buildTrackIndexInternal(normalizedCatalog);
      legacyIndex = buildLegacyIndexInternal(normalizedCatalog);
    } catch (err) {
      catalogIndexError = err?.message || 'Falha ao construir índices.';
    }
  }

  /* 12.2 Análise individual das playlists */
  playlists.forEach((playlist, index) => {
    if (!playlist || typeof playlist !== 'object' || Array.isArray(playlist)) {
      invalidPlaylists.push({
        index,
        reason: 'invalid_playlist_object',
        value: playlist
      });

      const key = `invalid-playlist#${index}`;
      playlistKeys.set(index, { id: null, key });

      addError(key, {
        type: 'invalid_playlist_object',
        message: 'A playlist não é um objeto válido.'
      });

      return;
    }

    const playlistId = normalizeTrackId(playlist.id);

    if (!playlistId) {
      invalidPlaylists.push({
        index,
        reason: 'missing_or_invalid_playlist_id',
        value: playlist
      });
    }

    if (!Array.isArray(playlist.tracks)) {
      invalidPlaylists.push({
        index,
        reason: 'invalid_tracks_array',
        playlistId,
        value: playlist.tracks
      });
    }

    if (playlistId) {
      if (playlistIds.has(playlistId)) duplicatePlaylistIds.push(playlistId);
      else playlistIds.add(playlistId);
    }

    const key = playlistId
      ? `${playlistId}#${index}`
      : `invalid-playlist#${index}`;

    playlistKeys.set(index, { id: playlistId, key });

    /* Erros individuais por problema de estrutura */
    if (!playlistId) {
      addError(key, {
        type: 'invalid_playlist_id',
        message: 'A playlist não possui um identificador válido.'
      });
    }

    if (!Array.isArray(playlist.tracks)) {
      addError(key, {
        type: 'invalid_tracks_array',
        message: 'A propriedade tracks precisa ser um array.'
      });
    }

    let resolvedCount = 0;
    let unresolvedCount = 0;
    let duplicateCount = 0;
    let migratableCount = 0;
    let numericLegacyCount = 0;
    let analysisFailed = false;

    /* Resolução */
    if (!catalogUsable || catalogIndexError) {
      analysisFailed = true;
      addError(key, {
        type: 'catalog_resolution_unavailable',
        message:
          catalogIndexError ||
          'Catálogo inconsistente. Corrija os erros antes de resolver as faixas.'
      });
    } else if (Array.isArray(playlist.tracks)) {
      const result = resolveWithIndex(playlist, trackIndex);

      resolvedCount = result.resolved.length;
      unresolvedCount = result.unresolved.length;
      duplicateCount = result.duplicates.length;

      if (result.unresolved.length) unresolvedByPlaylist.set(key, result.unresolved);
      if (result.duplicates.length) duplicatesByPlaylist.set(key, result.duplicates);
    }

    /* Migráveis */
    if (!catalogUsable || catalogIndexError) {
      analysisFailed = true;
    } else {
      const migratable = migratableWithIndex(playlist, legacyIndex);
      migratableCount = migratable.length;
      if (migratable.length) migratableByPlaylist.set(key, migratable);
    }

    /* Numéricos legados */
    const numeric = (Array.isArray(playlist.tracks) ? playlist.tracks : [])
      .filter(isNumericLegacyReference)
      .map(reference => ({
        original: reference,
        preservedAs: String(reference).trim()
      }));

    numericLegacyCount = numeric.length;
    if (numeric.length) numericLegacyByPlaylist.set(key, numeric);

    /* Contadores */
    countsByPlaylist.set(key, {
      resolved: resolvedCount,
      unresolved: unresolvedCount,
      duplicates: duplicateCount,
      migratable: migratableCount,
      numericLegacy: numericLegacyCount,
      analysisFailed
    });
  });

  const hasPlaylistIntegrityErrors =
    duplicatePlaylistIds.length > 0 ||
    invalidPlaylists.length > 0 ||
    unresolvedByPlaylist.size > 0 ||
    duplicatesByPlaylist.size > 0 ||
    errorsByPlaylist.size > 0;

  return {
    hasIntegrityErrors,
    hasWarnings,
    hasPlaylistIntegrityErrors,

    orphanTracks,
    invalidTracks,
    invalidAlbums,

    duplicateAlbumIds,
    duplicateTrackIds,
    duplicateTracksWithinAlbum,

    duplicatePlaylistIds,
    invalidPlaylists,

    playlistKeys,

    unresolvedByPlaylist,
    duplicatesByPlaylist,
    migratableByPlaylist,
    numericLegacyByPlaylist,
    errorsByPlaylist,
    countsByPlaylist
  };
}