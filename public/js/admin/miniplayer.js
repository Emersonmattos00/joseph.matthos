/* ============================================================
   js/admin/miniplayer.js — v1.1 (MP-01 + MP-02)
   ------------------------------------------------------------
   Miniplayer persistente do painel: pílula fixa no rodapé,
   fila do álbum, shuffle/repeat, badge PREVIEW/COMPLETO,
   volume/progresso (thumb estilo Spotify), fila expansível,
   MediaSession e atalhos de teclado.

   MP-02: ícones SVG estilo Spotify (play branco em círculo,
   hover branco, ativo verde com ponto), thumb na barra de
   progresso, prev reinicia a faixa atual (não salta para o
   fim) e next manual circula a fila.

   Integração (sem tocar no player de teste interno do editor):
   - albums.js dispara 'admin-player:start' → miniplayer pausa;
   - este módulo dispara 'admin-miniplayer:start' → editor pausa
     o player interno (listener adicionado pelo MP-01).
   - Versão preview usa a URL pública do CDN; versão completa
     pede URL assinada (download-url) por faixa, com o mesmo
     fallback do DL-01 (fullPath || streamKey).

   API pública:
     initAdminMiniPlayer()      — monta a pílula (idempotente)
     AdminMiniPlayer.setQueue(tracks, opts) — { startId?, version? }
     AdminMiniPlayer.toggle() / pause() / close() / isActive()
   ============================================================ */

import { apiFetch } from './api.js';
import { toast } from './ui/toast.js';
import { safeMediaUrl } from '../utils.js';

// Mesmas constantes de domínio do editors/albums.js
const R2_PUBLIC_BASE = 'https://pub-9eaf26fd8c784a62bae2457a45edc7d2.r2.dev';
const ALLOWED_MEDIA_HOSTS = ['r2.dev', 'r2.cloudflarestorage.com', 'josephmatthos.com.br'];

const LS_KEY = 'adminMiniPlayer';
const MAX_CONSECUTIVE_ERRORS = 3;

// ─────────────────────────────────────────────────────────────
// Ícones SVG estilo Spotify (16×16, currentColor)
// ─────────────────────────────────────────────────────────────
const SVG_ATTRS = 'width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"';
const STROKE = 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  shuffle: `<svg ${SVG_ATTRS} ${STROKE}>
    <path d="M1.5 3.5h2.2c.9 0 1.74.42 2.26 1.12l4.08 5.26c.52.7 1.36 1.12 2.26 1.12H14"/>
    <path d="M1.5 11.5h2.2c.9 0 1.74-.42 2.26-1.12l.7-.9"/>
    <path d="M8.06 5.62l.68-.92c.52-.7 1.36-1.2 2.26-1.2H14"/>
    <path d="M12.3 1.9 14 3.5l-1.7 1.6"/>
    <path d="M12.3 9.9 14 11.5l-1.7 1.6"/>
  </svg>`,
  prev: `<svg ${SVG_ATTRS}>
    <path d="M3.5 2.8v10.4" ${STROKE}/>
    <path d="M13 3.6v8.8L5.4 8 13 3.6Z" fill="currentColor"/>
  </svg>`,
  next: `<svg ${SVG_ATTRS}>
    <path d="M12.5 2.8v10.4" ${STROKE}/>
    <path d="M3 3.6v8.8L10.6 8 3 3.6Z" fill="currentColor"/>
  </svg>`,
  play: `<svg ${SVG_ATTRS}>
    <path d="M4.4 2.9v10.2L13.4 8 4.4 2.9Z" fill="currentColor"/>
  </svg>`,
  pause: `<svg ${SVG_ATTRS}>
    <path d="M4.9 3.2v9.6M11.1 3.2v9.6" stroke="currentColor" stroke-width="2.7" stroke-linecap="butt"/>
  </svg>`,
  repeat: `<svg ${SVG_ATTRS} ${STROKE}>
    <path d="M4.6 3.5h6.2a3 3 0 0 1 3 3v1.4"/>
    <path d="M11.6 5.9 14 8.1l-2.4 2.2"/>
    <path d="M11.4 12.5H5.2a3 3 0 0 1-3-3V7.9"/>
    <path d="M4.4 10.1 2 7.9l2.4-2.2"/>
  </svg>`,
  repeat1: `<svg ${SVG_ATTRS} ${STROKE}>
    <path d="M4.6 3.5h6.2a3 3 0 0 1 3 3v1.4"/>
    <path d="M11.6 5.9 14 8.1l-2.4 2.2"/>
    <path d="M11.4 12.5H5.2a3 3 0 0 1-3-3V7.9"/>
    <path d="M4.4 10.1 2 7.9l2.4-2.2"/>
    <text x="7.6" y="10.6" font-size="6.5" font-weight="700" text-anchor="middle"
          fill="currentColor" stroke="none" font-family="Inter, sans-serif">1</text>
  </svg>`,
  queue: `<svg ${SVG_ATTRS} ${STROKE}>
    <path d="M2.5 4.2h11M2.5 8h11M2.5 11.8h6.5"/>
  </svg>`,
  volHigh: `<svg ${SVG_ATTRS}>
    <path d="M2.2 6v4h2.6l3.6 3.2V2.8L4.8 6H2.2Z" fill="currentColor"/>
    <path d="M10.6 5.3a4 4 0 0 1 0 5.4M12.6 3.4a6.8 6.8 0 0 1 0 9.2" ${STROKE}/>
  </svg>`,
  volLow: `<svg ${SVG_ATTRS}>
    <path d="M2.2 6v4h2.6l3.6 3.2V2.8L4.8 6H2.2Z" fill="currentColor"/>
    <path d="M10.6 5.3a4 4 0 0 1 0 5.4" ${STROKE}/>
  </svg>`,
  volMute: `<svg ${SVG_ATTRS}>
    <path d="M2.2 6v4h2.6l3.6 3.2V2.8L4.8 6H2.2Z" fill="currentColor"/>
    <path d="M10.6 6.1l3.8 3.8M14.4 6.1l-3.8 3.8" ${STROKE}/>
  </svg>`,
  close: `<svg ${SVG_ATTRS} ${STROKE}>
    <path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>
  </svg>`
};

function setIcon(el, svg) {
  if (el) el.innerHTML = svg;
}

// ─────────────────────────────────────────────────────────────
// Estado (fora do DOM — módulo só toca window em init/UI)
// ─────────────────────────────────────────────────────────────
const MP = {
  mounted: false,
  visible: false,
  queue: [],           // DTOs normalizados
  order: [],           // ordem de reprodução (índices em queue)
  pos: -1,             // posição em order
  version: 'preview',  // 'preview' | 'full'
  shuffle: false,
  repeat: 'off',       // 'off' | 'all' | 'one'
  volume: 0.8,
  muted: false,
  seq: 0,              // guarda anti-corrida (padrão A-05)
  errors: 0,
  el: null,            // <audio>
  ui: null,            // refs da pílula
  queueOpen: false
};

export const AdminMiniPlayer = {
  setQueue, toggle, pause, close, isActive, setVersion,
  getState: () => ({ active: isActive(), pos: MP.pos, version: MP.version, size: MP.queue.length })
};

// ─────────────────────────────────────────────────────────────
// Funções puras (exportadas para teste)
// ─────────────────────────────────────────────────────────────
export function formatTime(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Fisher-Yates determinístico nos testes (rng injetável)
export function shuffleIndices(n, firstIndex, rng = Math.random) {
  if (!Number.isInteger(n) || n <= 0) return [];
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  if (Number.isInteger(firstIndex) && firstIndex >= 0 && firstIndex < n) {
    const at = idx.indexOf(firstIndex);
    if (at > 0) { idx.splice(at, 1); idx.unshift(firstIndex); }
  }
  return idx;
}

// Próximo índice conforme repeat; -1 = fim da fila
export function computeNext(order, pos, repeat) {
  if (!Array.isArray(order) || order.length === 0) return -1;
  if (pos < order.length - 1) return pos + 1;
  return repeat === 'all' ? 0 : -1;
}

// Caminho de preview → URL pública (absoluta permitida ou CDN)
export function resolvePreviewUrl(pathField) {
  const raw = String(pathField || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'https:' && ALLOWED_MEDIA_HOSTS.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return raw;
    } catch { /* cai no fallback */ }
    return '';
  }
  return `${R2_PUBLIC_BASE}/${raw.replace(/^\/+/, '')}`;
}

function pick(obj, ...keys) {
  for (const k of keys) { const v = obj?.[k]; if (v !== undefined && v !== null && v !== '') return v; }
  return null;
}

// ─────────────────────────────────────────────────────────────
// Persistência leve
// ─────────────────────────────────────────────────────────────
function loadPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (typeof raw.volume === 'number' && raw.volume >= 0 && raw.volume <= 1) MP.volume = raw.volume;
    MP.muted = raw.muted === true;
    MP.shuffle = raw.shuffle === true;
    if (raw.repeat === 'all' || raw.repeat === 'one') MP.repeat = raw.repeat;
    MP.version = raw.version === 'full' ? 'full' : 'preview';
  } catch { /* prefs corrompidas: usa defaults */ }
}

function savePrefs() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      volume: MP.volume, muted: MP.muted, shuffle: MP.shuffle, repeat: MP.repeat, version: MP.version
    }));
  } catch { /* storage indisponível: ignora */ }
}

// ─────────────────────────────────────────────────────────────
// Montagem da UI
// ─────────────────────────────────────────────────────────────
export function initAdminMiniPlayer() {
  if (MP.mounted || typeof document === 'undefined') return;
  loadPrefs();
  MP.mounted = true;

  const root = document.createElement('div');
  root.className = 'amp-root';
  root.id = 'adminMiniPlayer';
  root.hidden = true;
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Miniplayer do painel');
  // Estrutura estática (sem dados externos — seguro); ícones via setIcon()
  root.innerHTML = `
    <div class="amp-progress" data-amp="progress" role="slider" aria-label="Progresso da faixa"
         aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="-1">
      <div class="amp-progress__fill"></div>
      <div class="amp-progress__thumb"></div>
    </div>
    <div class="amp-main">
      <button class="amp-btn amp-btn--icon amp-btn--opt" data-amp="shuffle" type="button" title="Aleatório" aria-label="Aleatório" aria-pressed="false"></button>
      <button class="amp-btn amp-btn--icon" data-amp="prev" type="button" title="Anterior" aria-label="Faixa anterior"></button>
      <button class="amp-btn amp-btn--play" data-amp="play" type="button" title="Tocar/Pausar" aria-label="Tocar ou pausar"></button>
      <button class="amp-btn amp-btn--icon" data-amp="next" type="button" title="Próxima" aria-label="Próxima faixa"></button>
      <button class="amp-btn amp-btn--icon amp-btn--opt" data-amp="repeat" type="button" title="Repetir" aria-label="Repetir" aria-pressed="false"></button>
      <div class="amp-info" data-amp="info">
        <div class="amp-cover" data-amp="cover" aria-hidden="true"></div>
        <div class="amp-meta">
          <span class="amp-title" data-amp="title">—</span>
          <span class="amp-sub">
            <span data-amp="album">—</span>
            <button class="amp-badge" data-amp="badge" type="button" title="Alternar prévia/completo">PREVIEW</button>
          </span>
        </div>
      </div>
      <span class="amp-time" data-amp="time">0:00</span>
      <button class="amp-btn amp-btn--icon" data-amp="queue" type="button" title="Fila" aria-label="Fila de faixas"></button>
      <div class="amp-vol" data-amp="volwrap">
        <button class="amp-btn amp-btn--icon" data-amp="mute" type="button" title="Mudo" aria-label="Mudo"></button>
        <input class="amp-vol__range" data-amp="volume" type="range" min="0" max="100" step="1" aria-label="Volume">
      </div>
      <button class="amp-btn amp-btn--icon" data-amp="close" type="button" title="Fechar" aria-label="Fechar miniplayer"></button>
    </div>
    <div class="amp-queue" data-amp="queuePanel" hidden>
      <div class="amp-queue__head">Fila · <span data-amp="queueCount">0</span> faixa(s)</div>
      <div class="amp-queue__list" data-amp="queueList" role="listbox" aria-label="Fila de faixas"></div>
    </div>`;
  document.body.appendChild(root);

  const audio = document.createElement('audio');
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  document.body.appendChild(audio);

  MP.el = audio;
  MP.ui = {
    root,
    progress: root.querySelector('[data-amp="progress"]'),
    fill: root.querySelector('.amp-progress__fill'),
    thumb: root.querySelector('.amp-progress__thumb'),
    play: root.querySelector('[data-amp="play"]'),
    prev: root.querySelector('[data-amp="prev"]'),
    next: root.querySelector('[data-amp="next"]'),
    shuffle: root.querySelector('[data-amp="shuffle"]'),
    repeat: root.querySelector('[data-amp="repeat"]'),
    title: root.querySelector('[data-amp="title"]'),
    album: root.querySelector('[data-amp="album"]'),
    badge: root.querySelector('[data-amp="badge"]'),
    cover: root.querySelector('[data-amp="cover"]'),
    time: root.querySelector('[data-amp="time"]'),
    queueBtn: root.querySelector('[data-amp="queue"]'),
    queuePanel: root.querySelector('[data-amp="queuePanel"]'),
    queueList: root.querySelector('[data-amp="queueList"]'),
    queueCount: root.querySelector('[data-amp="queueCount"]'),
    volume: root.querySelector('[data-amp="volume"]'),
    muteBtn: root.querySelector('[data-amp="mute"]'),
    volwrap: root.querySelector('[data-amp="volwrap"]')
  };

  // Ícones Spotify
  setIcon(MP.ui.shuffle, ICONS.shuffle);
  setIcon(MP.ui.prev, ICONS.prev);
  setIcon(MP.ui.next, ICONS.next);
  setIcon(MP.ui.queueBtn, ICONS.queue);
  setIcon(MP.ui.close, ICONS.close);
  setPlayIcon(false);
  setRepeatIcon();
  setVolumeIcon();

  bindUi();
  bindAudio();
  bindKeyboard();

  // Exclusividade com o player de teste do editor
  document.addEventListener('admin-player:start', () => { try { pause(); } catch {} });

  audio.volume = MP.muted ? 0 : MP.volume;
  paintAll();
  console.info('[miniplayer] montado (v1.1)');
}

// ─────────────────────────────────────────────────────────────
// Pintores de ícone (estado → SVG)
// ─────────────────────────────────────────────────────────────
function setPlayIcon(playing) {
  setIcon(MP.ui?.play, playing ? ICONS.pause : ICONS.play);
}

function setRepeatIcon() {
  setIcon(MP.ui?.repeat, MP.repeat === 'one' ? ICONS.repeat1 : ICONS.repeat);
  if (MP.ui?.repeat) {
    MP.ui.repeat.classList.toggle('is-on', MP.repeat !== 'off');
    MP.ui.repeat.setAttribute('aria-pressed', String(MP.repeat !== 'off'));
    MP.ui.repeat.title = MP.repeat === 'off' ? 'Repetir: desligado' : (MP.repeat === 'all' ? 'Repetir: fila' : 'Repetir: faixa');
  }
}

function setVolumeIcon() {
  const v = MP.muted ? 0 : MP.volume;
  setIcon(MP.ui?.muteBtn, v === 0 ? ICONS.volMute : (v < 0.5 ? ICONS.volLow : ICONS.volHigh));
}

// ─────────────────────────────────────────────────────────────
// Binds
// ─────────────────────────────────────────────────────────────
function bindUi() {
  const u = MP.ui;
  u.play.addEventListener('click', () => toggle());
  u.prev.addEventListener('click', prevTrack);
  u.next.addEventListener('click', () => advance(1));
  u.shuffle.addEventListener('click', () => { MP.shuffle = !MP.shuffle; rebuildOrder(true); savePrefs(); paintQueue(); paintAll(); });
  u.repeat.addEventListener('click', () => {
    MP.repeat = MP.repeat === 'off' ? 'all' : (MP.repeat === 'all' ? 'one' : 'off');
    savePrefs(); setRepeatIcon();
  });
  u.badge.addEventListener('click', () => setVersion(MP.version === 'preview' ? 'full' : 'preview'));
  u.queueBtn.addEventListener('click', () => { MP.queueOpen = !MP.queueOpen; paintQueue(); });
  u.close.addEventListener('click', () => close());
  u.muteBtn.addEventListener('click', () => { MP.muted = !MP.muted; applyVolume(); savePrefs(); paintVolume(); });
  u.volume.addEventListener('input', () => {
    MP.volume = Math.min(1, Math.max(0, Number(u.volume.value) / 100 || 0));
    MP.muted = MP.volume === 0;
    applyVolume(); paintVolume(); savePrefs();
  });

  // Seek: clique + arrasto na barra (estilo Spotify)
  const seekFromEvent = (e) => {
    if (!MP.el || !Number.isFinite(MP.el.duration)) return;
    const rect = u.progress.getBoundingClientRect();
    const x = (e.clientX ?? 0) - rect.left;
    const pct = Math.min(1, Math.max(0, rect.width ? x / rect.width : 0));
    try { MP.el.currentTime = pct * MP.el.duration; } catch { /* faixa não pronta */ }
  };
  u.progress.addEventListener('pointerdown', (e) => {
    seekFromEvent(e);
    const move = (ev) => seekFromEvent(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function bindAudio() {
  const el = MP.el;
  el.addEventListener('timeupdate', paintProgress);
  el.addEventListener('durationchange', paintProgress);
  el.addEventListener('ended', onEnded);
  el.addEventListener('error', () => onTrackError('Falha ao carregar o áudio.'));
  el.addEventListener('play', () => { paintAll(); paintQueue(); setMediaSessionState(); });
  el.addEventListener('pause', () => { paintAll(); paintQueue(); });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (!isActive() || e.defaultPrevented) return;
    const t = e.target;
    const editable = t && (t.isContentEditable
      || /INPUT|TEXTAREA|SELECT/.test(String(t.tagName || '')));
    if (editable) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft' && MP.el && Number.isFinite(MP.el.duration)) { e.preventDefault(); try { MP.el.currentTime = Math.max(0, MP.el.currentTime - 10); } catch {} }
    else if (e.key === 'ArrowRight' && MP.el && Number.isFinite(MP.el.duration)) { e.preventDefault(); try { MP.el.currentTime = Math.min(MP.el.duration, MP.el.currentTime + 10); } catch {} }
  });
}

// ─────────────────────────────────────────────────────────────
// Fila
// ─────────────────────────────────────────────────────────────
function normalizeDto(t) {
  return {
    id: String(pick(t, 'id') ?? ''),
    title: String(pick(t, 'title') ?? 'Faixa'),
    trackNumber: Number(pick(t, 'trackNumber', 'track_index') || 0),
    albumId: String(pick(t, 'albumId') ?? ''),
    albumTitle: String(pick(t, 'albumTitle') ?? ''),
    coverUrl: pick(t, 'coverUrl', 'cover') || '',
    previewPath: pick(t, 'previewPath', 'preview_path'),
    fullPath: pick(t, 'fullPath', 'full_path'),
    streamKey: pick(t, 'streamKey', 'stream_key')
  };
}

function setQueue(tracks, opts = {}) {
  if (!MP.mounted) initAdminMiniPlayer();
  if (!Array.isArray(tracks) || !tracks.length) { toast('Nada para tocar.', '⚠'); return; }

  const dto = tracks.map(normalizeDto).filter(t => t.id);
  const playable = dto.filter(t => hasPreview(t) || hasFull(t));
  if (!playable.length) { toast('Nenhuma faixa da fila tem áudio cadastrado.', '⚠'); return; }

  MP.queue = playable;
  const startIdx = Math.max(0, MP.queue.findIndex(t => opts.startId && String(t.id) === String(opts.startId)));
  MP.version = opts.version === 'full' ? 'full' : (opts.version === 'preview' ? 'preview' : MP.version);
  MP.errors = 0;
  MP.visible = true;
  MP.order = MP.shuffle
    ? shuffleIndices(MP.queue.length, startIdx)
    : Array.from({ length: MP.queue.length }, (_, i) => i);
  MP.pos = MP.shuffle ? MP.order.indexOf(startIdx) : startIdx;

  MP.ui.root.hidden = false;
  paintQueue();
  playCurrent();
}

function rebuildOrder(shuffleChanged) {
  if (!shuffleChanged) return;
  const current = MP.order[MP.pos]; // índice da faixa atual em queue
  MP.order = MP.shuffle
    ? shuffleIndices(MP.queue.length, current >= 0 ? current : -1)
    : Array.from({ length: MP.queue.length }, (_, i) => i);
  MP.pos = current >= 0 ? MP.order.indexOf(current) : 0;
}

function hasPreview(t) { return !!(t.previewPath || t.preview_path); }
function hasFull(t) { return !!(t.fullPath || t.full_path || t.streamKey || t.stream_key); }

function currentTrack() {
  const qi = MP.order[MP.pos];
  return qi >= 0 ? MP.queue[qi] : null;
}

// ─────────────────────────────────────────────────────────────
// Reprodução (com guarda anti-corrida seq)
// ─────────────────────────────────────────────────────────────
async function playCurrent() {
  if (!MP.mounted) return;
  const seq = ++MP.seq;
  const track = currentTrack();
  if (!track) { close(); return; }

  paintMeta(track);
  document.dispatchEvent(new CustomEvent('admin-miniplayer:start'));

  // Versão pedida → cai para a outra se a faixa não tiver (DL-01 parity no full)
  let version = MP.version;
  if (version === 'full' && !hasFull(track)) version = 'preview';
  if (version === 'preview' && !hasPreview(track)) version = 'full';
  if ((version === 'preview' && !hasPreview(track)) || (version === 'full' && !hasFull(track))) {
    onTrackError(`${track.title}: nenhum áudio cadastrado (prévia ou completo).`);
    return;
  }
  if (version !== MP.version) {
    toast(version === 'preview'
      ? `"${track.title}" sem áudio completo — tocando prévia.`
      : `"${track.title}" sem prévia — tocando versão completa.`, 'ℹ');
  }

  let url = '';
  try {
    if (version === 'preview') {
      url = resolvePreviewUrl(track.previewPath);
      if (!url) throw new Error('Prévia indisponível.');
    } else {
      const res = await apiFetch('download-url', { method: 'GET', query: { id: track.id, type: 'full' } });
      if (!res?.ok || !res.url) throw new Error(res?.error || 'Falha ao gerar URL.');
      url = String(res.url);
    }
  } catch (err) {
    if (seq !== MP.seq) return;
    onTrackError(`${track.title}: ${err.message}`);
    return;
  }

  if (seq !== MP.seq) return; // usuário pulou durante o fetch

  try {
    paintVersionBadge(version);
    MP.el.src = url;
    MP.el.volume = MP.muted ? 0 : MP.volume;
    MP.el.load();
    await MP.el.play();
    MP.errors = 0;
    updateMediaSession(track, version);
  } catch (err) {
    if (seq !== MP.seq) return;
    // Autoplay bloqueado ou decode: mostra estado pausado, sem avanço automático
    console.warn('[miniplayer] play() falhou:', err?.name, err?.message);
    paintAll();
  }
}

function onTrackError(msg) {
  MP.errors += 1;
  if (MP.errors > MAX_CONSECUTIVE_ERRORS) {
    toast(`Miniplayer parado após ${MAX_CONSECUTIVE_ERRORS} falhas seguidas.`, '⚠');
    pause();
    return;
  }
  toast(msg, '⚠');
  advance(1); // pula faixa problemática
}

function onEnded() {
  if (MP.repeat === 'one' && MP.el) {
    try { MP.el.currentTime = 0; MP.el.play(); } catch {}
    return;
  }
  const next = computeNext(MP.order, MP.pos, MP.repeat);
  if (next < 0) { pause(); paintAll(); return; }
  MP.pos = next;
  playCurrent();
}

// Avanço MANUAL (botões next/prev e pulo por erro): circula a fila
function advance(dir) {
  if (!MP.queue.length) return;
  let next = MP.pos + dir;
  if (next >= MP.order.length) next = 0;
  if (next < 0) next = MP.order.length - 1;
  MP.pos = next;
  MP.errors = 0;
  playCurrent();
}

// Volta: reinicia a atual se passou de 3s; senão vai para a anterior.
// Na primeira faixa, reinicia (não salta para o fim da fila).
function prevTrack() {
  if (MP.el && Number.isFinite(MP.el.duration) && MP.el.currentTime > 3) {
    try { MP.el.currentTime = 0; } catch {}
    return;
  }
  if (MP.pos > 0) { advance(-1); return; }
  if (MP.el && MP.el.src) {
    try { MP.el.currentTime = 0; MP.el.play().catch(() => {}); } catch {}
  } else if (MP.queue.length) {
    playCurrent();
  }
}

function toggle() {
  if (!MP.el) return;
  if (MP.el.paused) { if (MP.el.src) MP.el.play().catch(() => {}); else if (MP.queue.length) playCurrent(); }
  else MP.el.pause();
}

function pause() { try { MP.el?.pause(); } catch {} }

function close() {
  pause();
  try { MP.el?.removeAttribute('src'); MP.el?.load(); } catch {}
  MP.queue = []; MP.order = []; MP.pos = -1; MP.queueOpen = false;
  MP.visible = false;
  if (MP.ui) MP.ui.root.hidden = true;
  paintQueue();
}

function isActive() {
  return !!(MP.mounted && MP.el && !MP.el.paused && !MP.el.ended && MP.el.src);
}

function setVersion(v) {
  const target = v === 'full' ? 'full' : 'preview';
  if (target === MP.version) return;
  MP.version = target;
  savePrefs();
  const t = currentTrack();
  if (t && ((target === 'full' && !hasFull(t)) || (target === 'preview' && !hasPreview(t)))) {
    toast(target === 'full' ? 'Faixa atual sem áudio completo — muda ao avançar.' : 'Faixa atual sem prévia — muda ao avançar.', 'ℹ');
  }
  if (isActive() || MP.el?.src) playCurrent(); else paintAll();
}

// ─────────────────────────────────────────────────────────────
// Pintura / UI
// ─────────────────────────────────────────────────────────────
function paintAll() {
  if (!MP.ui) return;
  const u = MP.ui;
  const playing = MP.el && !MP.el.paused && !MP.el.ended;
  setPlayIcon(!!playing);
  u.shuffle.classList.toggle('is-on', MP.shuffle);
  u.shuffle.setAttribute('aria-pressed', String(MP.shuffle));
  setRepeatIcon();
  paintVolume();
}

function paintVolume() {
  const u = MP.ui;
  if (!u) return;
  const v = MP.muted ? 0 : MP.volume;
  u.volume.value = String(Math.round(v * 100));
  u.volume.disabled = MP.muted;
  u.muteBtn.title = MP.muted ? 'Ativar som' : 'Mudo';
  u.volwrap.style.setProperty('--amp-vol', `${v * 100}%`);
  setVolumeIcon();
}

function paintMeta(track) {
  const u = MP.ui;
  u.title.textContent = track.title || '—';
  u.album.textContent = track.albumTitle || '';
  // Capa: <img> segura (A-18: sem handler inline; fallback ícone)
  const safe = safeMediaUrl(track.coverUrl);
  u.cover.textContent = '';
  if (safe) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = safe;
    img.addEventListener('error', () => { img.remove(); u.cover.textContent = '♪'; }, { once: true });
    u.cover.appendChild(img);
  } else {
    u.cover.textContent = '♪';
  }
}

function paintVersionBadge(version) {
  const u = MP.ui;
  u.badge.textContent = version === 'full' ? 'COMPLETO' : 'PREVIEW';
  u.badge.classList.toggle('is-full', version === 'full');
  u.badge.title = 'Alternar prévia/completo';
}

function paintProgress() {
  const u = MP.ui;
  if (!u || !MP.el) return;
  const cur = MP.el.currentTime || 0;
  const dur = Number.isFinite(MP.el.duration) ? MP.el.duration : 0;
  const pct = dur > 0 ? (cur / dur) * 100 : 0;
  u.fill.style.width = pct + '%';
  u.thumb.style.left = pct + '%';
  u.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
  u.time.textContent = dur > 0 ? `${formatTime(cur)} / ${formatTime(dur)}` : formatTime(cur);
}

function paintQueue() {
  const u = MP.ui;
  if (!u) return;
  u.queuePanel.hidden = !MP.queueOpen;
  if (!MP.queueOpen) return;
  u.queueCount.textContent = String(MP.queue.length);
  u.queueList.textContent = '';
  MP.order.forEach((qi, oi) => {
    const t = MP.queue[qi];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'amp-queue__row' + (oi === MP.pos ? ' is-current' : '');
    row.setAttribute('role', 'option');
    const num = document.createElement('span');
    num.className = 'amp-queue__num';
    num.textContent = oi === MP.pos ? (MP.el && !MP.el.paused ? '▶' : '⏸') : String(t.trackNumber || oi + 1);
    const label = document.createElement('span');
    label.className = 'amp-queue__title';
    label.textContent = t.title;
    const sub = document.createElement('span');
    sub.className = 'amp-queue__sub';
    sub.textContent = t.albumTitle || '';
    label.appendChild(sub);
    row.appendChild(num);
    row.appendChild(label);
    row.addEventListener('click', () => { MP.pos = oi; MP.errors = 0; playCurrent(); });
    u.queueList.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────────
// MediaSession (controles do SO / fones)
// ─────────────────────────────────────────────────────────────
function updateMediaSession(track, version) {
  if (!('mediaSession' in navigator)) return;
  try {
    const artwork = safeMediaUrl(track.coverUrl);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.albumTitle || 'Joseph Matthos',
      album: version === 'full' ? 'Painel · completo' : 'Painel · prévia',
      artwork: artwork ? [{ src: artwork, sizes: '512x512', type: 'image/jpeg' }] : []
    });
    navigator.mediaSession.setActionHandler('play', () => toggle());
    navigator.mediaSession.setActionHandler('pause', () => pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => advance(1));
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (MP.el && d && Number.isFinite(d.seekTime)) MP.el.currentTime = d.seekTime;
    });
  } catch { /* MediaSession indisponível: ignora */ }
}

function setMediaSessionState() {
  if (!('mediaSession' in navigator)) return;
  try { navigator.mediaSession.playbackState = MP.el && !MP.el.paused ? 'playing' : 'paused'; } catch {}
}
