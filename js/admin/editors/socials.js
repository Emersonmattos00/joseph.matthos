/* ============================================================
   js/admin/editors/socials.js — Editor de redes sociais
   ------------------------------------------------------------
   - Lista fixa de redes conhecidas (evita URLs maliciosas
     com `network` arbitrário)
   - Valida URL no editor (feedback imediato)
   - Sempre passa por safeExternalUrl() na renderização
     pública (site.js), como defesa em profundidade
   - Salva apenas URLs http(s) válidas
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc, safeExternalUrl } from '../ui/dom.js';
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

const LABEL_BY_KEY = Object.fromEntries(NETWORKS.map((n) => [n.key, n.label]));

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
export function renderSocialEditor(content = AdminState.content) {
  const wrap = document.getElementById('socialEditor');
  if (!wrap) return;

  // Guard: garante estrutura mínima
  if (!content.contato) content.contato = {};
  if (!Array.isArray(content.contato.socials)) content.contato.socials = [];

  const socials = content.contato.socials;

  if (!socials.length) {
    wrap.innerHTML = `
      <p class="hint" style="color:var(--text-dim);padding:1rem;">
        Nenhuma rede social configurada. Clique em "+ Adicionar rede".
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
          <strong>${esc(s.label || LABEL_BY_KEY[network] || network)}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" aria-label="Remover">🗑</button>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Rede</label>
            <select data-field="network" data-i="${i}">
              ${NETWORKS.map((n) =>
                `<option value="${n.key}" ${network === n.key ? 'selected' : ''}>${esc(n.label)}</option>`
              ).join('')}
            </select>
          </div>

          <div class="form-group">
            <label>URL</label>
            <input
              type="url"
              value="${esc(currentUrl)}"
              data-field="url"
              data-i="${i}"
              placeholder="https://..."
              spellcheck="false"
              autocomplete="off"
              style="${urlOk ? '' : 'border-color:var(--danger);'}"
            >
            ${urlOk ? '' : `<p class="hint" style="color:var(--danger);font-size:0.75rem;margin-top:0.3rem;">URL inválida — só http(s).</p>`}
          </div>
        </div>
      </div>`;
  }).join('');

  // ── Bind: select de rede
  wrap.querySelectorAll('[data-field="network"]').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      const network = el.value;
      if (!content.contato.socials[i]) return;

      content.contato.socials[i].network = network;
      content.contato.socials[i].icon = network;    // compatibilidade
      content.contato.socials[i].label = LABEL_BY_KEY[network] || network;

      markDirty();
      renderSocialEditor(content);                  // re-render para atualizar título
    });
  });

  // ── Bind: input de URL (com normalização)
  wrap.querySelectorAll('[data-field="url"]').forEach((el) => {
    // Feedback visual imediato enquanto digita
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      if (!content.contato.socials[i]) return;

      const raw = el.value.trim();
      const ok = !raw || isValidExternalUrl(raw);

      // Atualiza o estilo do input sem re-render
      el.style.borderColor = ok ? '' : 'var(--danger)';

      // Salva o valor cru (será validado no save do plano)
      content.contato.socials[i].url = raw;
      markDirty();
    });

    // Normaliza ao sair do campo
    el.addEventListener('blur', () => {
      const i = Number(el.dataset.i);
      if (!content.contato.socials[i]) return;

      const raw = String(content.contato.socials[i].url || '').trim();
      if (!raw) return;

      const normalized = normalizeExternalUrl(raw);
      if (normalized) {
        content.contato.socials[i].url = normalized;
        el.value = normalized;
        el.style.borderColor = '';
      } else {
        // URL inválida — mantém o valor, mas deixa o aviso
        el.style.borderColor = 'var(--danger)';
      }
    });
  });

  // ── Bind: botão remover
  wrap.querySelectorAll('[data-action="remove"]').forEach((b) => {
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      const network = content.contato.socials[i]?.network || 'rede';
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
    if (!Array.isArray(content.contato.socials)) content.contato.socials = [];

    // Evita duplicar rede já existente (só avisa)
    const existing = new Set(content.contato.socials.map((s) => s.network));

    const firstFree = NETWORKS.find((n) => !existing.has(n.key));
    if (!firstFree) {
      toast('Todas as redes disponíveis já foram adicionadas.', 'ℹ');
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
// Helpers — validação e normalização de URL
// ─────────────────────────────────────────────────────────────
function isValidExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function normalizeExternalUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;

  let candidate = raw.trim();

  // Aceita "spotify.com/..." → "https://spotify.com/..."
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = 'https://' + candidate;
  }

  try {
    const u = new URL(candidate);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    // Rejeita URLs sem host válido
    if (!u.hostname || !u.hostname.includes('.')) return null;
    return u.toString();
  } catch {
    return null;
  }
}
