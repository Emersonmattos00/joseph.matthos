/* ============================================================
   js/radio.js — Rádio Joseph Matthos
   ------------------------------------------------------------
   Versão revisada:
   - Validação das dependências
   - Verificação Premium
   - Validação dos identificadores das faixas
   - Padronização da fila com trackId
   - Compatibilidade com player.js
   - Embaralhamento seguro
   - Tratamento de falhas do sessionStorage
   - Proteção contra cliques duplicados
   - Persistência do estado entre páginas
   ============================================================ */

'use strict';

const RADIO_STORAGE = {
  queue: 'radio_queue',
  index: 'radio_index',
  active: 'radio_active'
};

let _deps = null;
let _radioOpening = false;
let _radioActive = false;

/* ============================================================
   STORAGE
   ============================================================ */

function storageGet(key, fallback = null) {
  try {
    return sessionStorage.getItem(key) ?? fallback;
  } catch (error) {
    console.warn('[radio] Falha ao acessar sessionStorage:', error);
    return fallback;
  }
}

function storageSet(key, value) {
  try {
    sessionStorage.setItem(key, String(value));
    return true;
  } catch (error) {
    console.error('[radio] Falha ao salvar sessão:', error);
    return false;
  }
}

function storageRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch (error) {
    console.warn('[radio] Falha ao remover sessão:', error);
  }
}

/* ============================================================
   DEPENDÊNCIAS
   ============================================================ */

export function initRadio(deps) {
  if (!deps || typeof deps !== 'object') {
    console.error('[radio] Dependências inválidas.');
    _deps = null;
    return false;
  }

  const required = [
    'isPremium',
    'collectAllTracks',
    'openModal'
  ];

  const missing = required.filter(
    key => typeof deps[key] !== 'function'
  );

  if (missing.length) {
    console.error(
      '[radio] Dependências ausentes:',
      missing.join(', ')
    );

    _deps = null;
    return false;
  }

  _deps = deps;

  _radioActive = storageGet(RADIO_STORAGE.active) === 'true';

  return true;
}

/* ============================================================
   EMBARALHAMENTO
   ============================================================ */

function shuffleTracks(tracks) {
  const result = tracks.slice();

  if (_deps && typeof _deps.shuffleArray === 'function') {
    const shuffled = _deps.shuffleArray(result.slice());

    if (Array.isArray(shuffled) && shuffled.length === result.length) {
      return shuffled;
    }
  }

  // Fisher-Yates como alternativa.
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [result[i], result[j]] = [result[j], result[i]];
  }

  return result;
}

/* ============================================================
   NORMALIZAÇÃO DA FILA
   ============================================================ */

function normalizeTrack(track) {
  if (!track || typeof track !== 'object') {
    return null;
  }

  const trackId = track.trackId ?? track.id;

  if (
    trackId === undefined ||
    trackId === null ||
    String(trackId).trim() === ''
  ) {
    return null;
  }

  const albumId = track.albumId;

  if (
    albumId === undefined ||
    albumId === null ||
    String(albumId).trim() === ''
  ) {
    return null;
  }

  const trackIndex = Number(
    track.trackIndex ?? track.trackNumber
  );

  return {
    albumId: String(albumId),
    trackId: String(trackId),
    trackIndex: Number.isInteger(trackIndex)
      ? trackIndex
      : null
  };
}

/* ============================================================
   ABRIR RÁDIO
   ============================================================ */

export function openRadioModal() {
  if (_radioOpening) return false;

  const deps = _deps;

  if (!deps) {
    console.error('[radio] Rádio não inicializada.');
    return false;
  }

  try {
    _radioOpening = true;

    // Verifica assinatura.
    const premium = deps.isPremium();

    if (premium !== true) {
      _radioOpening = false;

      alert(
        'A Rádio Joseph Matthos é exclusiva para assinantes Premium.'
      );

      deps.openModal('plansModal');

      return false;
    }

    // Recupera o catálogo.
    const allTracks = deps.collectAllTracks();

    if (!Array.isArray(allTracks) || !allTracks.length) {
      alert(
        'Nenhuma faixa publicada disponível para a rádio.'
      );

      _radioOpening = false;
      return false;
    }

    // Normaliza e elimina faixas inválidas.
    const validTracks = allTracks
      .map(normalizeTrack)
      .filter(Boolean);

    if (!validTracks.length) {
      console.error(
        '[radio] Nenhuma faixa possui identificadores válidos.',
        allTracks
      );

      alert(
        'Não foi possível montar a rádio. O catálogo precisa ser verificado.'
      );

      _radioOpening = false;
      return false;
    }

    // Evita IDs duplicados.
    const uniqueTracks = Array.from(
      new Map(
        validTracks.map(track => [
          track.trackId,
          track
        ])
      ).values()
    );

    // Embaralha.
    const queue = shuffleTracks(uniqueTracks);

    // Confirma a estrutura esperada pelo player.
    const playerQueue = queue.map(track => ({
      albumId: track.albumId,
      trackId: track.trackId,
      trackIndex: track.trackIndex
    }));

    // Salva a fila.
    const savedQueue = storageSet(
      RADIO_STORAGE.queue,
      JSON.stringify(playerQueue)
    );

    const savedIndex = storageSet(
      RADIO_STORAGE.index,
      '0'
    );

    const savedActive = storageSet(
      RADIO_STORAGE.active,
      'true'
    );

    if (!savedQueue || !savedIndex || !savedActive) {
      resetRadio();

      alert(
        'Não foi possível iniciar a rádio. Verifique o armazenamento do navegador.'
      );

      _radioOpening = false;
      return false;
    }

    _radioActive = true;

    // Redireciona para o player.
    window.location.assign('/player.html?radio=true');

    return true;

  } catch (error) {
    console.error(
      '[radio] Erro ao iniciar rádio:',
      error
    );

    _radioOpening = false;

    alert(
      'Ocorreu um erro ao iniciar a Rádio Joseph Matthos.'
    );

    return false;
  }
}

/* ============================================================
   CONTROLE DE REPRODUÇÃO
   ============================================================ */

export function onRadioTrackEnded() {
  // A navegação das faixas é controlada pelo player.js.
  return false;
}

export function syncRadioOnTrackChange() {
  // A sincronização da fila é controlada pelo player.js.
  return false;
}

/* ============================================================
   ESTADO
   ============================================================ */

export function isRadioActive() {
  const params = new URLSearchParams(
    window.location.search
  );

  if (params.get('radio') === 'true') {
    return true;
  }

  return (
    _radioActive ||
    storageGet(RADIO_STORAGE.active) === 'true'
  );
}

/* ============================================================
   ENCERRAR RÁDIO
   ============================================================ */

export function resetRadio() {
  _radioActive = false;
  _radioOpening = false;

  storageRemove(RADIO_STORAGE.queue);
  storageRemove(RADIO_STORAGE.index);
  storageRemove(RADIO_STORAGE.active);

  return true;
}