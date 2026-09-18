javascript
/* ============================================================
   js/admin/editors/socials.js — Editor de redes sociais
   ------------------------------------------------------------
   - Lista fixa de redes conhecidas
   - Valida URL no editor
   - Salva apenas URLs http(s) válidas
   - Renderização pública utiliza safeExternalUrl()
     em js/utils.js, não neste editor
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Redes permitidas
// ─────────────────────────────────────────────────────────────
const NETWORKS = [
  { key: 'spotify',   label: 'Spotify' },
  { key: 'youtube',   label: 'YouTube' },
  { key: 'amazon',    label: 'Amazon Music' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'tiktok',    label: 'TikTok' },
  { key: 'apple',     label: 'Apple Music' },
  { key: 'audiomack', label: 'Audiomack' },
  { key: 'deezer',    label: 'Deezer' },
  { key: 'soundcloud',label: 'SoundCloud' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'x',         label: 'X (Twitter)' }
];

const LABEL_BY_KEY = Object.fromEntries(
  NETWORKS.map((n) => [n.key, n.label])
);

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
export function renderSocialEditor(content = AdminState.content) {
  const wrap = document.getElementById('socialEditor');
  if (!wrap) return;

  // Garante estrutura mínima
  if (!content.contato) content.contato = {};
  if (!Array.isArray(content.contato.socials)) {
    content.contato.socials = [];
  }

  const socials = content.contato.socials;

  if (!socials.length) {
    wrap.innerHTML = `
      <p class="hint"
         style="color:var(--text-dim);padding:1rem;">
        Nenhuma rede social configurada.
        Clique em "+ Adicionar rede".
      </p>`;
    return;
  }

  wrap.innerHTML = socials.map((s, i) => {
    const network = s.network || s.icon || 'spotify';
    const currentUrl = String(s.url || '');
    const urlOk = !currentUrl || isValidExternalUrl(currentUrl);

    return `
      <div class="track-editor">
        <div class="track-head">
          <strong>
            ${esc(s.label || LABEL_BY_KEY[network] || network)}
          </strong>

          <button
            type="button"
            class="btn btn-ghost btn-sm"
            data-action="remove"
            data-i="${i}"
            aria-label="Remover"
          >🗑</button>
        </div>

        <div class="form-row">

          <div class="form-group">
            <label for="social-network-${i}">Rede</label>

            <select
              id="social-network-${i}"
              data-field="network"
              data-i="${i}"
            >
              ${NETWORKS.map((n) => `
                <option
                  value="${esc(n.key)}"
                  ${network === n.key ? 'selected' : ''}
                >
                  ${esc(n.label)}
                </option>
              `).join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="social-url-${i}">URL</label>

            <input
              id="social-url-${i}"
              type="url"
              value="${esc(currentUrl)}"
              data-field="url"
              data-i="${i}"
              placeholder="https://..."
              spellcheck="false"
              autocomplete="off"
              inputmode="url"
              style="${urlOk ? '' : 'border-color:var(--danger);'}"
            >

            ${
              urlOk
                ? ''
                : `
                  <p
                    class="hint"
                    style="
                      color:var(--danger);
                      font-size:0.75rem;
                      margin-top:0.3rem;
                    "
                  >
                    URL inválida — use apenas http(s).
                  </p>
                `
            }
          </div>

        </div>
      </div>
    `;
  }).join('');

  // ───────────────────────────────────────────────────────────
  // Select de rede
  // ───────────────────────────────────────────────────────────
  wrap.querySelectorAll('[data-field="network"]').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      const network = el.value;

      if (!Number.isInteger(i)) return;
      if (!content.contato.socials[i]) return;

      content.contato.socials[i].network = network;
      content.contato.socials[i].icon = network;
      content.contato.socials[i].label =
        LABEL_BY_KEY[network] || network;

      markDirty();
      renderSocialEditor(content);
    });
  });

  // ───────────────────────────────────────────────────────────
  // URL
  // ───────────────────────────────────────────────────────────
  wrap.querySelectorAll('[data-field="url"]').forEach((el) => {

    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);

      if (!Number.isInteger(i)) return;
      if (!content.contato.socials[i]) return;

      const raw = el.value.trim();
      const ok = !raw || isValidExternalUrl(raw);

      el.style.borderColor = ok ? '' : 'var(--danger)';

      content.contato.socials[i].url = raw;
      markDirty();
    });

    el.addEventListener('blur', () => {
      const i = Number(el.dataset.i);

      if (!Number.isInteger(i)) return;
      if (!content.contato.socials[i]) return;

      const raw = String(
        content.contato.socials[i].url || ''
      ).trim();

      if (!raw) {
        el.style.borderColor = '';
        return;
      }

      const normalized = normalizeExternalUrl(raw);

      if (normalized) {
        content.contato.socials[i].url = normalized;
        el.value = normalized;
        el.style.borderColor = '';
      } else {
        el.style.borderColor = 'var(--danger)';
      }
    });
  });

  // ───────────────────────────────────────────────────────────
  // Remover
  // ───────────────────────────────────────────────────────────
  wrap.querySelectorAll('[data-action="remove"]').forEach((button) => {
    button.addEventListener('click', () => {
      const i = Number(button.dataset.i);

      if (!Number.isInteger(i)) return;

      const network =
        content.contato.socials[i]?.network || 'rede';

      if (!confirm(`Remover "${network}"?`)) return;

      content.contato.socials.splice(i, 1);

      markDirty();
      renderSocialEditor(content);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Botão "+ Adicionar rede"
// ─────────────────────────────────────────────────────────────
export function bindSocialsAddButton() {
  const btn = document.getElementById('addSocialBtn');

  if (!btn || btn.dataset.bound === '1') return;

  btn.dataset.bound = '1';

  btn.addEventListener('click', () => {
    const content = AdminState.content;

    if (!content.contato) content.contato = {};

    if (!Array.isArray(content.contato.socials)) {
      content.contato.socials = [];
    }

    const existing = new Set(
      content.contato.socials.map((s) => s.network)
    );

    const firstFree = NETWORKS.find(
      (n) => !existing.has(n.key)
    );

    if (!firstFree) {
      toast(
        'Todas as redes disponíveis já foram adicionadas.',
        'ℹ'
      );
      return;
    }

    content.contato.socials.push({
      network: firstFree.key,
      icon: firstFree.key,
      label: firstFree.label,
      url: ''
    });

    markDirty();
    renderSocialEditor(content);
  });
}

// ─────────────────────────────────────────────────────────────
// Validação
// ─────────────────────────────────────────────────────────────
function isValidExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;

  try {
    const u = new URL(raw);

    return (
      u.protocol === 'https:' ||
      u.protocol === 'http:'
    );
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// Normalização
// ─────────────────────────────────────────────────────────────
function normalizeExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;

  let candidate = raw.trim();

  // Aceita:
  // spotify.com/...
  // youtube.com/...
  // e transforma em https://...
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }

  try {
    const u = new URL(candidate);

    if (
      u.protocol !== 'https:' &&
      u.protocol !== 'http:'
    ) {
      return null;
    }

    // Rejeita URLs sem host válido
    if (!u.hostname || !u.hostname.includes('.')) {
      return null;
    }

    return u.toString();
  } catch {
    return null;
  }
}
