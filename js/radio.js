/* ============================================================
   js/radio.js — Rádio Joseph Matthos
   ------------------------------------------------------------
   Exclusiva para assinantes. Toca toda a discografia publicada
   em ordem aleatória, sem repetição até esgotar, e reembaralha
   automaticamente ao chegar ao fim (loop infinito).

   🔌 API pública:
     initRadio(deps)              → injeta dependências do site
     openRadioModal()             → abre o modal da rádio
     onRadioTrackEnded()          → chamado quando uma faixa acaba
     syncRadioOnTrackChange(a,t)  → sincroniza modal com o player
     isRadioActive()              → true se a rádio está tocando
     resetRadio()                 → limpa estado (logout)

   🔗 Dependências injetadas via initRadio():
     isPremium, findAlbum, findTrackByIndex, playFromDiscography,
     shuffleArray, collectAllTracks, openModal, closeModal, esc,
     setQueue, getQueue, getQueueIndex
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
// Renderiza o estado "tocando"
// ─────────────────────────────────────────────────────────────
function renderPlaying(queue, index) {
  const deps = requireDeps();
  if (!deps) return;

  const {
    findAlbum,
    findTrackByIndex,
    esc,
    shuffleArray,
    collectAllTracks,
    setQueue,
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

  content.innerHTML = `
    <div class="radio-status">
      <span class="radio-status-label">Tocando agora</span>
      <span class="radio-status-track">${esc(track?.title || '—')}</span>
      <span class="radio-status-album">
        ${esc(album?.title || '—')} · faixa ${index + 1} de ${queue.length}
      </span>
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

  content.querySelector('#radioCloseBtn')?.addEventListener('click', closeRadio);
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
