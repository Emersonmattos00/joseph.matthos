/* ============================================================
   js/radio.js — Rádio Joseph Matthos (CORRIGIDO — v2)
   ------------------------------------------------------------
   Auditoria 26/11/2026 — correções aplicadas sobre o original:
   R-01 (P1): a fila agora é INJETADA no player do site via as
       dependências que o site.js já fornece (setQueue +
       playFromDiscography) em vez de redirecionar para
       /player.html?radio=true — página que não lê nenhuma chave
       de rádio (beco sem saída). Modo legado mantido como
       fallback documentado.
   R-03 (P2): onRadioTrackEnded agora implementado — no fim da
       fila, a rádio REINICIA do começo ("sem parar" real) e
       devolve true para o site não avançar por cima.
   R-05 (P2): feedback via deps.toast (fallback alert); o gate
       premium não empilha mais alert + plansModal.
   R-06 (P2): _radioOpening é resetado em pageshow (bfcache) e
       antes da navegação no modo legado — botão não morre após
       voltar por Back.
   API pública preservada: initRadio, openRadioModal,
   onRadioTrackEnded, syncRadioOnTrackChange, isRadioActive,
   resetRadio. Dependências opcionais aceitas: setQueue,
   playFromDiscography, getQueue, getQueueIndex, setQueueIndex,
   toast.
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
let _inlineMode = false;

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
   FEEDBACK (R-05)
   ============================================================ */

function notify(message) {
  if (_deps && typeof _deps.toast === 'function') {
    try {
      _deps.toast(message, '📻');
      return;
    } catch (error) {
      console.warn('[radio] toast falhou, usando alert:', error);
    }
  }
  alert(message);
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

  // R-01: modo inline — o site fornece os hooks do player próprio.
  _inlineMode =
    typeof deps.setQueue === 'function' &&
    typeof deps.playFromDiscography === 'function';

  _radioActive = storageGet(RADIO_STORAGE.active) === 'true';

  // R-06: voltar por Back (bfcache) restaurava a página com o
  // guard de cliques travado — resetar quando a página reaparece.
  window.addEventListener('pageshow', () => {
    _radioOpening = false;
  });

  if (!_inlineMode) {
    console.warn(
      '[radio] Modo legado: hooks do player (setQueue/playFromDiscography) ' +
      'ausentes — a fila será salva e o navegador redirecionado. ' +
      'Sem consumo do lado do player, a rádio não toca.'
    );
  }

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

    // Verifica assinatura (R-05: toast em vez de alert duplo).
    const premium = deps.isPremium();

    if (premium !== true) {
      _radioOpening = false;

      notify(
        'A Rádio Joseph Matthos é exclusiva para assinantes Premium.'
      );

      deps.openModal('plansModal');

      return false;
    }

    // Recupera o catálogo.
    const allTracks = deps.collectAllTracks();

    if (!Array.isArray(allTracks) || !allTracks.length) {
      notify(
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

      notify(
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

    // ── R-01: modo inline — injeta a fila no player do site ──
    if (_inlineMode) {
      deps.setQueue(playerQueue);

      if (typeof deps.setQueueIndex === 'function') {
        deps.setQueueIndex(0);
      }

      _radioActive = true;
      storageSet(RADIO_STORAGE.queue, JSON.stringify(playerQueue));
      storageSet(RADIO_STORAGE.index, '0');
      storageSet(RADIO_STORAGE.active, 'true');

      const first = playerQueue[0];

      // fromQueue:true preserva a fila injetada — sem isso o site
      // reconstruiria a fila pelo álbum (buildQueueForAlbum).
      deps.playFromDiscography(first.albumId, first.trackId, {
        fromQueue: true
      });

      _radioOpening = false;
      return true;
    }

    // ── Modo legado (sem hooks do player) ──
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

      notify(
        'Não foi possível iniciar a rádio. Verifique o armazenamento do navegador.'
      );

      _radioOpening = false;
      return false;
    }

    _radioActive = true;

    // R-06: reset antes de navegar — se o redirecionamento falhar
    // (ou for bloqueado), o botão continua utilizável.
    _radioOpening = false;

    // Redireciona para o player.
    window.location.assign('/player.html?radio=true');

    return true;

  } catch (error) {
    console.error(
      '[radio] Erro ao iniciar rádio:',
      error
    );

    _radioOpening = false;

    notify(
      'Ocorreu um erro ao iniciar a Rádio Joseph Matthos.'
    );

    return false;
  }
}

/* ============================================================
   CONTROLE DE REPRODUÇÃO
   ============================================================ */

export function onRadioTrackEnded() {
  // R-03: continuação real. O site chama isto no 'ended' do áudio:
  //   if (isRadioActive() && onRadioTrackEnded()) return;
  //   nextTrack();
  // No meio da fila devolvemos false (o nextTrack do site avança
  // pela fila injetada). No FIM da fila a rádio reinicia do começo
  // ("sem parar") e devolvemos true para o site não sobrepor.
  if (!_radioActive || !_deps || !_inlineMode) return false;

  const getQueue = _deps.getQueue;
  const getIndex = _deps.getQueueIndex;

  if (typeof getQueue !== 'function' || typeof getIndex !== 'function') {
    return false;
  }

  const queue = getQueue();

  if (!Array.isArray(queue) || !queue.length) return false;

  const index = getIndex();

  if (!Number.isInteger(index) || index < 0) return false;

  if (index < queue.length - 1) return false;

  const first = queue[0];

  if (
    !first ||
    typeof _deps.setQueueIndex !== 'function' ||
    typeof _deps.playFromDiscography !== 'function'
  ) {
    return false;
  }

  try {
    _deps.setQueueIndex(0);
    _deps.playFromDiscography(first.albumId, first.trackId, {
      fromQueue: true
    });
    return true;
  } catch (error) {
    console.error('[radio] Falha ao reiniciar a rádio:', error);
    return false;
  }
}

export function syncRadioOnTrackChange() {
  // A sincronização de índice é controlada pelo player do site.
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
