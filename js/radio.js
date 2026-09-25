/* ============================================================
   js/radio.js — Rádio Joseph Matthos
   ------------------------------------------------------------
   Exclusiva para assinantes. Toca toda a discografia publicada
   em ordem aleatória, sem repetição até esgotar, e reembaralha
   automaticamente ao chegar ao fim (loop infinito).

   🎨 UI: modal próprio (#radioModal).
   - Capa do álbum da faixa atual
   - Botão Pausar/Retomar
   - Botão Próxima
   - Embaralhar de novo
   - Minimizar

   🔌 API pública (usada por js/site.js):
     initRadio(deps)
     openRadioModal()
     onRadioTrackEnded()
     syncRadioOnTrackChange()
     isRadioActive()
     resetRadio()

   🔗 Dependências injetadas:
     isPremium, findAlbum, findTrackByIndex, playFromDiscography,
     shuffleArray, collectAllTracks, openModal, closeModal, esc,
     safeMediaUrl, setQueue, getQueue, getQueueIndex, setQueueIndex
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
// Estado interno
// ─────────────────────────────────────────────────────────────
let _deps = null;
let _radioActive = false;

// ─────────────────────────────────────────────────────────────
// Injeção de dependências (chamado pelo site.js)
// ─────────────────────────────────────────────────────────────
export function initRadio(deps) {
  _deps = deps || null;
}

// ─────────────────────────────────────────────────────────────
// Helper: dependências obrigatórias
// ─────────────────────────────────────────────────────────────
function requireDeps() {
  if (!_deps) {
    console.warn('[radio] initRadio() não foi chamado');
    return null;
  }
  return _deps;
}

// ─────────────────────────────────────────────────────────────
// Abre o modal da rádio
// ─────────────────────────────────────────────────────────────
export function openRadioModal() {
  const deps = requireDeps();
  if (!deps) return;

  const {
    isPremium,
    collectAllTracks,
    shuffleArray,
    playFromDiscography,
    openModal
  } = deps;

  const modal = document.getElementById('radioModal');
  const content = document.getElementById('radioContent');
  if (!modal || !content) return;

  // ── Estado 1: não assinante
  if (!isPremium()) {
    _radioActive = false;
    content.innerHTML = `
      <div class="radio-locked">
        <span class="radio-locked-icon" aria-hidden="true">🔒</span>
        <h3>Exclusivo para assinantes</h3>
        <p>
          A Rádio Joseph Matthos toca <strong>toda a discografia</strong>
          em ordem aleatória, sem parar.
        </p>
        <p>
          Assine o Premium para ouvir sem limites, com downloads inclusos.
        </p>
      </div>
      <div class="radio-actions">
        <button class="btn btn-primary" type="button" id="radioSubscribeBtn">
          Assinar Premium
        </button>
        <button class="btn btn-outline" type="button" id="radioLoginBtn">
          Já sou assinante
        </button>
      </div>
    `;

    content.querySelector('#radioSubscribeBtn')?.addEventListener('click', () => {
      closeRadio();
      openModal('plansModal');
    });

    content.querySelector('#radioLoginBtn')?.addEventListener('click', () => {
      closeRadio();
      openModal('loginModal');
    });

    openModal('radioModal');
    return;
  }

  // ── Estado 2: assinante
  const allTracks = collectAllTracks();
  if (!allTracks.length) {
    _radioActive = false;
    content.innerHTML = `
      <div class="radio-locked">
        <span class="radio-locked-icon" aria-hidden="true">📭</span>
        <h3>Catálogo vazio</h3>
        <p>Nenhuma faixa publicada disponível para a rádio.</p>
      </div>
    `;
    openModal('radioModal');
    return;
  }

  // ── Monta fila aleatória
  const queue = shuffleArray(allTracks.slice());

  deps.setQueue(queue);
  _radioActive = true;

  renderPlaying(queue, 0);

  // ── Toca a primeira
  const first = queue[0];
  if (first) {
    playFromDiscography(first.albumId, first.trackIndex, { fromQueue: true });
  }

  openModal('radioModal');
}

// ─────────────────────────────────────────────────────────────
// Fecha o modal (o áudio continua)
// ─────────────────────────────────────────────────────────────
function closeRadio() {
  const modal = document.getElementById('radioModal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

// ─────────────────────────────────────────────────────────────
// Renderiza o estado "tocando" (com capa + controles)
// ─────────────────────────────────────────────────────────────
function renderPlaying(queue, index) {
  const deps = requireDeps();
  if (!deps) return;

  const {
    findAlbum,
    findTrackByIndex,
    esc,
    safeMediaUrl,
    shuffleArray,
    collectAllTracks,
    setQueue,
    setQueueIndex,
    playFromDiscography
  } = deps;

  const content = document.getElementById('radioContent');
  if (!content) return;

  const entry = queue[index];
  if (!entry) {
    _radioActive = false;
    content.innerHTML = `
      <div class="radio-status">
        <span class="radio-status-label">Rádio encerrada</span>
      </div>
      <div class="radio-actions">
        <button class="btn btn-primary" type="button" id="radioRestartBtn">
          ↻ Tocar novamente
        </button>
      </div>
    `;
    content.querySelector('#radioRestartBtn')?.addEventListener('click', openRadioModal);
    return;
  }

  const album = findAlbum(entry.albumId);
  const track = findTrackByIndex(entry.albumId, entry.trackIndex);

  // ── Capa do álbum
  const safeCover = album ? safeMediaUrl(album.coverImage) : '';
  const coverInitials = album
    ? esc(album.coverInitials || album.cover || '♪')
    : '♪';

  const coverHTML = safeCover
    ? `<div class="radio-cover" style="background-image:url('${esc(safeCover)}')" role="img" aria-label="Capa de ${esc(album?.title || 'álbum')}"></div>`
    : `<div class="radio-cover radio-cover--initials" aria-hidden="true">${coverInitials}</div>`;

  // ── Estado do áudio
  const audioEl = document.getElementById('audio');
  const isPaused = !audioEl || audioEl.paused;
  const playIcon = isPaused ? '▶' : '⏸';
  const playLabel = isPaused ? 'Retomar' : 'Pausar';

  // ── Próxima existe?
  const hasNext = index + 1 < queue.length;

  content.innerHTML = `
    <div class="radio-now-playing">
      ${coverHTML}

      <div class="radio-now-info">
        <span class="radio-status-label">Tocando agora</span>
        <span class="radio-status-track">${esc(track?.title || '—')}</span>
        <span class="radio-status-album">
          ${esc(album?.title || '—')} · faixa ${index + 1} de ${queue.length}
        </span>
      </div>

      <div class="radio-controls">
        <button class="radio-ctrl-btn" type="button" id="radioPlayPauseBtn"
                aria-label="${esc(playLabel)}">
          <span class="radio-ctrl-icon">${playIcon}</span>
          <span class="radio-ctrl-text">${esc(playLabel)}</span>
        </button>

        <button class="radio-ctrl-btn" type="button" id="radioNextBtn"
                aria-label="Próxima faixa" ${hasNext ? '' : 'disabled'}>
          <span class="radio-ctrl-icon">⏭</span>
          <span class="radio-ctrl-text">Próxima</span>
        </button>
      </div>
    </div>

    <div class="radio-stats">
      <span><strong>${queue.length}</strong> faixas na fila</span>
      <span><strong>∞</strong> aleatório</span>
    </div>

    <div class="radio-actions">
      <button class="btn btn-outline" type="button" id="radioShuffleBtn">
        🔀 Embaralhar de novo
      </button>
      <button class="btn btn-ghost" type="button" id="radioCloseBtn">
        Minimizar (continua tocando)
      </button>
    </div>
  `;

  // ── Bind: pausar/retomar
  content.querySelector('#radioPlayPauseBtn')?.addEventListener('click', () => {
    if (!audioEl) return;
    if (audioEl.paused) {
      audioEl.play().catch(() => {});
    } else {
      audioEl.pause();
    }
    // Re-renderiza com o novo ícone
    renderPlaying(queue, index);
  });

  // ── Bind: próxima
  content.querySelector('#radioNextBtn')?.addEventListener('click', () => {
    if (!hasNext) return;
    const next = queue[index + 1];
    if (typeof setQueueIndex === 'function') setQueueIndex(index + 1);
    playFromDiscography(next.albumId, next.trackIndex, { fromQueue: true });
    renderPlaying(queue, index + 1);
  });

  // ── Bind: embaralhar
  content.querySelector('#radioShuffleBtn')?.addEventListener('click', () => {
    const all = collectAllTracks();
    const newQueue = shuffleArray(all.slice());
    setQueue(newQueue);
    renderPlaying(newQueue, 0);

    const first = newQueue[0];
    if (first) {
      playFromDiscography(first.albumId, first.trackIndex, { fromQueue: true });
    }
  });

  // ── Bind: minimizar
  content.querySelector('#radioCloseBtn')?.addEventListener('click', closeRadio);

  // ── Sincroniza o botão quando o áudio mudar de estado
  //    (play/pause disparado por outras fontes: tecla espaço, player fixo, etc)
  if (audioEl && audioEl.dataset.radioBound !== '1') {
    audioEl.dataset.radioBound = '1';

    audioEl.addEventListener('play', () => {
      if (!_radioActive) return;
      const btn = document.getElementById('radioPlayPauseBtn');
      if (!btn) return;
      const icon = btn.querySelector('.radio-ctrl-icon');
      const text = btn.querySelector('.radio-ctrl-text');
      if (icon) icon.textContent = '⏸';
      if (text) text.textContent = 'Pausar';
    });

    audioEl.addEventListener('pause', () => {
      if (!_radioActive) return;
      const btn = document.getElementById('radioPlayPauseBtn');
      if (!btn) return;
      const icon = btn.querySelector('.radio-ctrl-icon');
      const text = btn.querySelector('.radio-ctrl-text');
      if (icon) icon.textContent = '▶';
      if (text) text.textContent = 'Retomar';
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Callback: faixa terminou (chamado pelo player do site.js)
// ------------------------------------------------------------
// Retorna true se a rádio tratou o evento (para o site.js
// não chamar nextTrack() padrão).
// ─────────────────────────────────────────────────────────────
export function onRadioTrackEnded() {
  if (!_radioActive) return false;

  const deps = requireDeps();
  if (!deps) return false;

  const {
    getQueue,
    getQueueIndex,
    setQueue,
    shuffleArray,
    collectAllTracks,
    playFromDiscography
  } = deps;

  const queue = getQueue();
  const index = getQueueIndex();

  if (!queue.length || index < 0) return false;

  // ── Ainda tem faixas na fila
  if (index + 1 < queue.length) {
    const next = queue[index + 1];
    playFromDiscography(next.albumId, next.trackIndex, { fromQueue: true });
    renderPlaying(queue, index + 1);
    return true;
  }

  // ── Esgotou: reembaralha e recomeça
  const all = collectAllTracks();
  const newQueue = shuffleArray(all.slice());
  setQueue(newQueue);
  renderPlaying(newQueue, 0);

  const first = newQueue[0];
  if (first) {
    playFromDiscography(first.albumId, first.trackIndex, { fromQueue: true });
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Callback: faixa mudou (chamado pelo playFromDiscography do site)
// ─────────────────────────────────────────────────────────────
export function syncRadioOnTrackChange(albumId, trackIndex) {
  if (!_radioActive) return;

  const deps = requireDeps();
  if (!deps) return;

  const modal = document.getElementById('radioModal');
  if (!modal || !modal.classList.contains('open')) return;

  const { getQueue, getQueueIndex } = deps;
  const queue = getQueue();
  const index = getQueueIndex();

  if (index < 0 || index >= queue.length) return;
  const entry = queue[index];
  if (!entry) return;
  if (entry.albumId !== albumId || entry.trackIndex !== trackIndex) return;

  renderPlaying(queue, index);
}

// ─────────────────────────────────────────────────────────────
// Consulta: rádio ativa?
// ─────────────────────────────────────────────────────────────
export function isRadioActive() {
  return _radioActive === true;
}

// ─────────────────────────────────────────────────────────────
// Reseta o estado (ex: logout)
// ─────────────────────────────────────────────────────────────
export function resetRadio() {
  _radioActive = false;
  const content = document.getElementById('radioContent');
  if (content) content.innerHTML = '';
}
