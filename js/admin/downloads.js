/* ============================================================
   js/admin/downloads.js — Aba "Downloads"
   ------------------------------------------------------------
   - Lista todos os álbuns (com faixas)
   - Baixar faixa individual (URL assinada 1h)
   - Baixar álbum completo (múltiplas URLs assinadas)
   - Baixar tudo (itera sobre todos os álbuns)
   - Progresso visual + log em tempo real
   - Delay de 600ms entre downloads para não sobrecarregar
     o navegador (evita bloqueio de "downloads múltiplos")

   🔌 Depende de:
     - api.js (listAlbums, listTracks, getDownloadUrl, getDownloadAlbum)
     - ui/dom.js (esc)
     - ui/toast.js (toast)
   ============================================================ */

import {
  listAlbums,
  listTracks,
  getDownloadUrl,
  getDownloadAlbum
} from './api.js';

import { esc } from './ui/dom.js';
import { toast } from './ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Estado
// ─────────────────────────────────────────────────────────────
const state = {
  albums: [],
  tracks: new Map(),        // albumId → tracks[]
  loading: false,
  error: null,
  expanded: new Set(),      // albumIds expandidos
  downloading: false
};

// ─────────────────────────────────────────────────────────────
// Entrada pública
// ─────────────────────────────────────────────────────────────
export async function renderDownloads({ force = false } = {}) {
  const wrap = document.getElementById('downloadsContainer');
  if (!wrap) return;

  if (force || !state.albums.length) {
    await fetchAll();
  }
  paint();
}

// ─────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────
async function fetchAll() {
  state.loading = true;
  state.error = null;
  paint();

  try {
    const res = await listAlbums();
    state.albums = Array.isArray(res?.albums) ? res.albums : [];
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) throw err;
    state.error = err?.message || 'Falha ao carregar álbuns.';
    state.albums = [];
  } finally {
    state.loading = false;
  }
}

async function loadTracks(albumId) {
  if (state.tracks.has(albumId)) return state.tracks.get(albumId);
  try {
    const res = await listTracks(albumId);
    const tracks = Array.isArray(res?.tracks) ? res.tracks : [];
    state.tracks.set(albumId, tracks);
    return tracks;
  } catch (err) {
    console.error('[downloads] loadTracks:', err);
    state.tracks.set(albumId, []);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
function paint() {
  const wrap = document.getElementById('downloadsContainer');
  if (!wrap) return;

  if (state.loading) {
    wrap.innerHTML = '<div class="admin-loading">Carregando álbuns…</div>';
    return;
  }

  if (state.error) {
    wrap.innerHTML = `
      <div class="admin-error-box">
        <p>${esc(state.error)}</p>
        <button class="btn btn-outline btn-sm" id="downloadsRetry">Tentar novamente</button>
      </div>`;
    document.getElementById('downloadsRetry')?.addEventListener('click', () => renderDownloads({ force: true }));
    return;
  }

  if (!state.albums.length) {
    wrap.innerHTML = '<p class="admin-empty">Nenhum álbum cadastrado.</p>';
    return;
  }

  const totalAlbums = state.albums.length;

  wrap.innerHTML = `
    <div class="downloads-toolbar">
      <p class="hint" style="color:var(--text-dim);font-size:0.85rem;margin:0;">
        Baixe as faixas em qualidade original. As URLs são assinadas e expiram em 1 hora.
      </p>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="downloadAllBtn" type="button">
          ⬇ Baixar tudo (${totalAlbums} álbuns)
        </button>
      </div>
    </div>

    <div id="downloadsLog" class="downloads-log" hidden></div>

    <div class="downloads-list">
      ${state.albums.map((album) => renderAlbumBlock(album)).join('')}
    </div>
  `;

  bindToolbar();
  bindAlbumButtons();
}

function renderAlbumBlock(album) {
  const isExpanded = state.expanded.has(album.id);
  const tracks = state.tracks.get(album.id);
  const hasTracksLoaded = Array.isArray(tracks);

  const tracksWithAudio = hasTracksLoaded
    ? tracks.filter((t) => t.full_path).length
    : null;

  return `
    <div class="downloads-album ${isExpanded ? 'expanded' : ''}" data-album="${esc(album.id)}">
      <div class="downloads-album-header">
        <button type="button" class="downloads-toggle"
                data-action="toggle"
                data-album="${esc(album.id)}"
                aria-label="Expandir/recolher">
          ▼
        </button>
        <div class="downloads-album-info">
          <strong>${esc(album.title)}</strong>
          <span class="hint">
            ${album.year || '—'} · ${esc((album.type || 'album').toUpperCase())}
            ${tracksWithAudio !== null ? ` · ${tracksWithAudio} faixa${tracksWithAudio === 1 ? '' : 's'} com áudio` : ''}
            ${album.published ? '' : ' · <span style="color:var(--warning)">RASCUNHO</span>'}
          </span>
        </div>
        <button class="btn btn-outline btn-sm" type="button"
                data-action="download-album"
                data-album="${esc(album.id)}">
          ⬇ Baixar álbum
        </button>
      </div>

      ${isExpanded ? `
        <div class="downloads-tracks" data-tracks-for="${esc(album.id)}">
          ${hasTracksLoaded ? renderTracksList(album.id, tracks) : '<div class="admin-loading">Carregando faixas…</div>'}
        </div>
      ` : ''}
    </div>
  `;
}

function renderTracksList(albumId, tracks) {
  if (!tracks.length) {
    return '<p class="admin-empty">Nenhuma faixa cadastrada.</p>';
  }

  return `
    <table class="admin-table">
      <thead>
        <tr>
          <th style="width:40px;">#</th>
          <th>Título</th>
          <th style="width:100px;">Duração</th>
          <th style="width:120px;">Áudio</th>
          <th style="width:140px;">Ações</th>
        </tr>
      </thead>
      <tbody>
        ${tracks.map((t) => {
          const hasFull = !!t.full_path;
          const badge = hasFull
            ? '<span class="badge-mini badge-premium">Completo</span>'
            : '<span class="badge-mini badge-free">Sem áudio</span>';

          return `
            <tr>
              <td>${Number(t.track_index) + 1}</td>
              <td>${esc(t.title || '—')}</td>
              <td>${esc(t.duration || '—')}</td>
              <td>${badge}</td>
              <td>
                <button class="btn btn-ghost btn-sm"
                        type="button"
                        data-action="download-track"
                        data-track-id="${esc(String(t.id))}"
                        data-track-title="${esc(t.title || '')}"
                        ${hasFull ? '' : 'disabled'}>
                  ⬇ Baixar
                </button>
              </td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

// ─────────────────────────────────────────────────────────────
// Binds
// ─────────────────────────────────────────────────────────────
function bindToolbar() {
  document.getElementById('downloadAllBtn')?.addEventListener('click', downloadAll);
}

function bindAlbumButtons() {
  document.querySelectorAll('[data-action="toggle"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const albumId = btn.dataset.album;
      if (!albumId) return;

      if (state.expanded.has(albumId)) {
        state.expanded.delete(albumId);
      } else {
        state.expanded.add(albumId);
        if (!state.tracks.has(albumId)) {
          await loadTracks(albumId);
        }
      }
      paint();
    });
  });

  document.querySelectorAll('[data-action="download-album"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadAlbum(btn.dataset.album));
  });

  document.querySelectorAll('[data-action="download-track"]').forEach((btn) => {
    btn.addEventListener('click', () => downloadTrack(btn.dataset.trackId, btn.dataset.trackTitle));
  });
}

// ─────────────────────────────────────────────────────────────
// Ações de download
// ─────────────────────────────────────────────────────────────
async function downloadTrack(trackId, titleHint) {
  if (state.downloading) {
    toast('Já existe um download em andamento.', '⚠');
    return;
  }
  state.downloading = true;

  try {
    logLine(`Preparando "${titleHint || trackId}"…`);
    const res = await getDownloadUrl(trackId);
    if (!res?.ok || !res.url) {
      throw new Error(res?.error || 'Falha ao gerar URL.');
    }

    triggerDownload(res.url, res.filename);
    logLine(`✓ "${res.filename}" pronto.`);
    toast('Download iniciado.', '⬇');
  } catch (err) {
    console.error('[downloads] track:', err);
    logLine(`✕ Erro: ${err.message}`);
    toast(err?.message || 'Falha ao baixar faixa.', '⚠');
  } finally {
    state.downloading = false;
  }
}

async function downloadAlbum(albumId) {
  if (state.downloading) {
    toast('Já existe um download em andamento.', '⚠');
    return;
  }
  state.downloading = true;

  const album = state.albums.find((a) => a.id === albumId);
  const albumTitle = album?.title || albumId;

  try {
    logLine(`Preparando álbum "${albumTitle}"…`);
    const res = await getDownloadAlbum(albumId);

    if (!res?.ok || !Array.isArray(res.tracks)) {
      throw new Error(res?.error || 'Falha ao listar faixas.');
    }

    const valid = res.tracks.filter((t) => t.url);
    if (!valid.length) {
      logLine(`✕ Nenhuma faixa com áudio em "${albumTitle}".`);
      toast('Este álbum não tem áudios completos.', '⚠');
      return;
    }

    logLine(`▶ ${valid.length} faixa(s) em "${albumTitle}". Iniciando…`);

    let ok = 0;
    let fail = 0;

    for (let i = 0; i < valid.length; i++) {
      const t = valid[i];
      try {
        triggerDownload(t.url, t.filename);
        ok++;
        logLine(`  ✓ ${i + 1}/${valid.length} — ${t.filename}`);
      } catch (err) {
        fail++;
        logLine(`  ✕ ${i + 1}/${valid.length} — ${t.title} (${err.message})`);
      }
      await sleep(600);
    }

    logLine(`✓ Álbum "${albumTitle}" concluído: ${ok} ok, ${fail} falha(s).`);
    toast(`Álbum baixado (${ok}/${valid.length}).`, '⬇');
  } catch (err) {
    console.error('[downloads] album:', err);
    logLine(`✕ Erro: ${err.message}`);
    toast(err?.message || 'Falha ao baixar álbum.', '⚠');
  } finally {
    state.downloading = false;
  }
}

async function downloadAll() {
  if (state.downloading) {
    toast('Já existe um download em andamento.', '⚠');
    return;
  }
  if (!state.albums.length) {
    toast('Nenhum álbum para baixar.', 'ℹ');
    return;
  }

  const confirmed = confirm(
    `Isso vai baixar TODAS as faixas de ${state.albums.length} álbuns.\n\n` +
    `O navegador vai pedir permissão para salvar múltiplos arquivos. ` +
    `Pode levar alguns minutos.\n\nContinuar?`
  );
  if (!confirmed) return;

  state.downloading = true;

  try {
    logLine(`▶ Baixando TODA a discografia (${state.albums.length} álbuns)…`);

    let totalOk = 0;
    let totalFail = 0;

    for (let ai = 0; ai < state.albums.length; ai++) {
      const album = state.albums[ai];
      logLine(`── Álbum ${ai + 1}/${state.albums.length}: "${album.title}" ──`);

      try {
        const res = await getDownloadAlbum(album.id);
        if (!res?.ok || !Array.isArray(res.tracks)) {
          logLine(`  ✕ Falha ao listar faixas.`);
          totalFail++;
          continue;
        }

        const valid = res.tracks.filter((t) => t.url);
        for (let i = 0; i < valid.length; i++) {
          const t = valid[i];
          try {
            triggerDownload(t.url, t.filename);
            totalOk++;
            logLine(`  ✓ ${i + 1}/${valid.length} — ${t.filename}`);
          } catch (err) {
            totalFail++;
            logLine(`  ✕ ${i + 1}/${valid.length} — ${t.title}`);
          }
          await sleep(600);
        }
      } catch (err) {
        logLine(`  ✕ Erro no álbum: ${err.message}`);
        totalFail++;
      }

      await sleep(400);
    }

    logLine(`✓ Concluído: ${totalOk} ok, ${totalFail} falha(s).`);
    toast(`Downloads concluídos (${totalOk} arquivos).`, '⬇');
  } catch (err) {
    console.error('[downloads] all:', err);
    logLine(`✕ Erro geral: ${err.message}`);
    toast('Falha durante o download em massa.', '⚠');
  } finally {
    state.downloading = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

function logLine(text) {
  const log = document.getElementById('downloadsLog');
  if (!log) return;
  log.hidden = false;
  const line = document.createElement('div');
  line.className = 'downloads-log-line';
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
