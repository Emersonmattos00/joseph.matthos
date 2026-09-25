/* ============================================================
   js/radio.js — Rádio Joseph Matthos
   ------------------------------------------------------------
   Exclusiva para assinantes. Toca toda a discografia publicada
   em ordem aleatória, sem repetição até esgotar, e reembaralha
   automaticamente ao chegar ao fim (loop infinito).

   🎨 UI: reaproveita o #expandedPlayerModal.
   - Botão STOP (encerra a rádio)
   - Painel "Fila da rádio" (lista completa, clicável)
   - Badge "RÁDIO" no topo

   🔌 API pública (usada por js/site.js):
     initRadio(deps)
     openRadioModal()          → ativa a rádio e abre o player
     onRadioTrackEnded()       → retorna true se a rádio tratou
     syncRadioOnTrackChange()  → atualiza UI quando a faixa muda
     isRadioActive()           → true se rádio ativa
     stopRadio()               → encerra a rádio
     resetRadio()              → limpa estado (logout)
   ============================================================ */

'use strict';

// ─────────────────────────────────────────────────────────────
// Estado
// ─────────────────────────────────────────────────────────────
let _deps = null;
let _radioActive = false;

// ─────────────────────────────────────────────────────────────
// Injeção de dependências
// ─────────────────────────────────────────────────────────────
export function initRadio(deps) {
  _deps = deps || null;
  bindStopButton();
}

function requireDeps() {
  if (!_deps) {
    console.warn('[radio] initRadio() não foi chamado');
    return null;
  }
  return _deps;
}

// ─────────────────────────────────────────────────────────────
// Bind: botão STOP
// ─────────────────────────────────────────────────────────────
function bindStopButton() {
  const btn = document.getElementById('expandedStopBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => stopRadio());
}

// ─────────────────────────────────────────────────────────────
// Abrir rádio
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

  // ── Estado 1: não assinante → abre modal de planos
  if (!isPremium()) {
    stopRadio();
    openModal('plansModal');
    return;
  }

  // ── Coleta todas as faixas
  const allTracks = collectAllTracks();
  if (!allTracks.length) {
    console.warn('[radio] catálogo vazio');
    return;
  }

  // ── Shuffle a cada abertura
  const queue = shuffleArray(allTracks.slice());

  deps.setQueue(queue);
  _radioActive = true;

  // ── Atualiza UI
  showRadioBadge(true);
  showStopButton(true);
  setRightPanel('queue');
  renderQueuePanel(queue, 0);

  // ── Abre o modal do player
  const modal = document.getElementById('expandedPlayerModal');
  if (modal) {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  // ── Toca a primeira faixa
  const first = queue[0];
  if (first) {
    playFromDiscography(first.albumId, first.trackIndex, { fromQueue: true });
  }
}

// ─────────────────────────────────────────────────────────────
// Parar rádio
// ─────────────────────────────────────────────────────────────
export function stopRadio() {
  if (!_radioActive) return;

  _radioActive = false;

  const deps = requireDeps();
  if (deps) {
    deps.setQueue([]);
  }

  // ── Para o áudio
  const audio = document.getElementById('audio');
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }

  // ── Esconde UI da rádio
  showRadioBadge(false);
  showStopButton(false);
  setRightPanel('lyrics');

  const queuePanel = document.getElementById('radioQueuePanel');
  if (queuePanel) {
    queuePanel.hidden = true;
    const list = document.getElementById('radioQueueList');
    if (list) list.innerHTML = '';
    const count = document.getElementById('radioQueueCount');
    if (count) count.textContent = '';
  }

  // ── Fecha o player se estiver aberto
  const modal = document.getElementById('expandedPlayerModal');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
}

// ─────────────────────────────────────────────────────────────
// Callback: faixa terminou
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

  // ── Ainda tem faixas
  if (index + 1 < queue.length) {
    const next = queue[index + 1];
    playFromDiscography(next.albumId, next.trackIndex, { fromQueue: true });
    renderQueuePanel(queue, index + 1);
    return true;
  }

  // ── Esgotou: reembaralha
  const all = collectAllTracks();
  const newQueue = shuffleArray(all.slice());
  setQueue(newQueue);
  renderQueuePanel(newQueue, 0);

  const first = newQueue[0];
  if (first) {
    playFromDiscography(first.albumId, first.trackIndex, { fromQueue: true });
  }

  return true;
}

// ─────────────────────────────────────────────────────────────
// Sincroniza UI quando a faixa muda
// ─────────────────────────────────────────────────────────────
export function syncRadioOnTrackChange(albumId, trackIndex) {
  if (!_radioActive) return;

  const deps = requireDeps();
  if (!deps) return;

  const { getQueue, getQueueIndex } = deps;
  const queue = getQueue();
  const index = getQueueIndex();

  if (index < 0 || index >= queue.length) return;
  const entry = queue[index];
  if (!entry) return;
  if (entry.albumId !== albumId || entry.trackIndex !== trackIndex) return;

  renderQueuePanel(queue, index);
}

// ─────────────────────────────────────────────────────────────
// Consulta
// ─────────────────────────────────────────────────────────────
export function isRadioActive() {
  return _radioActive === true;
}

// ─────────────────────────────────────────────────────────────
// Reset (logout)
// ─────────────────────────────────────────────────────────────
export function resetRadio() {
  if (_radioActive) stopRadio();
  _radioActive = false;

  const list = document.getElementById('radioQueueList');
  if (list) list.innerHTML = '';
  const count = document.getElementById('radioQueueCount');
  if (count) count.textContent = '';
}

// ─────────────────────────────────────────────────────────────
// Helpers de UI
// ─────────────────────────────────────────────────────────────
function showRadioBadge(visible) {
  const badge = document.getElementById('radioBadge');
  if (badge) badge.hidden = !visible;
}

function showStopButton(visible) {
  const btn = document.getElementById('expandedStopBtn');
  if (btn) btn.hidden = !visible;
}

function setRightPanel(which) {
  const lyricsEl = document.getElementById('expandedLyricsContent');
  const queuePanel = document.getElementById('radioQueuePanel');
  const titleEl = document.getElementById('rightPanelTitle');

  if (!lyricsEl || !queuePanel) return;

  if (which === 'queue') {
    lyricsEl.hidden = true;
    queuePanel.hidden = false;
    if (titleEl) titleEl.textContent = 'Fila da rádio';
  } else {
    lyricsEl.hidden = false;
    queuePanel.hidden = true;
    if (titleEl) titleEl.textContent = 'Letra';
  }
}

// ─────────────────────────────────────────────────────────────
// Renderiza a fila da rádio
// ─────────────────────────────────────────────────────────────
function renderQueuePanel(queue, currentIndex) {
  const list = document.getElementById('radioQueueList');
  const count = document.getElementById('radioQueueCount');
  if (!list) return;

  if (count) count.textContent = `${queue.length} faixas`;

  const deps = requireDeps();
  if (!deps) return;
  const { findAlbum, findTrackByIndex, esc, playFromDiscography } = deps;

  list.innerHTML = queue.map((item, idx) => {
    const album = findAlbum(item.albumId);
    const track = findTrackByIndex(item.albumId, item.trackIndex);
    const isCurrent = idx === currentIndex;

    const title = track?.title || '—';
    const albumTitle = album?.title || '—';

    return `
      <button class="radio-queue-item ${isCurrent ? 'playing' : ''}"
              type="button"
              data-radio-index="${idx}">
        <span class="radio-queue-item-index">${isCurrent ? '▶' : idx + 1}</span>
        <span class="radio-queue-item-info">
          <span class="radio-queue-item-title">${esc(title)}</span>
          <span class="radio-queue-item-album">${esc(albumTitle)}</span>
        </span>
        <span class="radio-queue-item-action">${isCurrent ? 'tocando' : 'tocar'}</span>
      </button>
    `;
  }).join('');

  // ── Bind: clicar numa faixa pula para ela
  list.querySelectorAll('[data-radio-index]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.radioIndex);
      if (!Number.isInteger(idx)) return;
      if (idx === currentIndex) return;

      deps.setQueueIndex(idx);
      const item = queue[idx];
      playFromDiscography(item.albumId, item.trackIndex, { fromQueue: true });
      renderQueuePanel(queue, idx);
    });
  });

  // ── Scroll até a faixa atual
  const currentBtn = list.querySelector('.radio-queue-item.playing');
  if (currentBtn && currentBtn.scrollIntoView) {
    currentBtn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}
