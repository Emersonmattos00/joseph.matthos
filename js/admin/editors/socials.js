/* ============================================================
   js/admin/editors/socials.js — Editor de redes sociais
   ------------------------------------------------------------
   - Lista fixa de redes conhecidas
   - 🛡️ Validação em 3 camadas:
       1. Bloqueio de protocolos perigosos
          (javascript:, data:, file:, vbscript:, blob:)
       2. Whitelist: apenas http(s)
       3. Detecção de disfarces (unicode, percent-encoding)
   - Salva apenas URLs http(s) válidas
   - Renderização pública utiliza safeExternalUrl()
     em js/utils.js — defesa em profundidade
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
// Protocolos permitidos e proibidos
// ─────────────────────────────────────────────────────────────
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);

const FORBIDDEN_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'ms-its:',
  'mhtml:',
  'opera:',
  'res:',
  'resource:',
  'view-source:',
  'ws:',
  'wss:',
  'ftp:',
  'ftps:'
]);

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
export function renderSocialEditor(content = AdminState.content) {
  const wrap = document.getElementById('socialEditor');
  if (!wrap) return;

  if (!content.contato) content.contato = {};
  if (!Array.isArray(content.contato.socials)) {
    content.contato.socials = [];
  }

  const socials = content.contato.socials;

  if (!socials.length) {
    wrap.innerHTML = `
      <p class="hint" style="color:var(--text-dim);padding:1rem;">
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
            aria-label="Remover">🗑</button>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="social-network-${i}">Rede</label>
            <select id="social-network-${i}"
                    data-field="network"
                    data-i="${i}">
              ${NETWORKS.map((n) => `
                <option value="${esc(n.key)}"
                        ${network === n.key ? 'selected' : ''}>
                  ${esc(n.label)}
                </option>
              `).join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="social-url-${i}">URL</label>
            <input id="social-url-${i}"
                   type="url"
                   value="${esc(currentUrl)}"
                   data-field="url"
                   data-i="${i}"
                   placeholder="https://..."
                   spellcheck="false"
                   autocomplete="off"
                   inputmode="url"
                   style="${urlOk ? '' : 'border-color:var(--danger);'}">

            ${urlOk ? '' : `
              <p class="hint"
                 style="color:var(--danger);font-size:0.75rem;margin-top:0.3rem;">
                URL inválida — use apenas http(s).
              </p>
            `}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // ── Select de rede
  wrap.querySelectorAll('[data-field="network"]').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      const network = el.value;
      if (!Number.isInteger(i)) return;
      if (!content.contato.socials[i]) return;

      content.contato.socials[i].network = network;
      content.contato.socials[i].icon = network;
      content.contato.socials[i].label = LABEL_BY_KEY[network] || network;

      markDirty();
      renderSocialEditor(content);
    });
  });

  // ── URL
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

      const raw = String(content.contato.socials[i].url || '').trim();

      if (!raw) {
        el.style.borderColor = '';
        return;
      }

      const normalized = normalizeExternalUrl(raw);

      if (normalized) {
        content.contato.socials[i].url = normalized;
        el.value = normalized;
        el.style.borderColor = '';
        markDirty();
      } else {
        el.style.borderColor = 'var(--danger)';
        // ⚠️ Não salva URL inválida
        content.contato.socials[i].url = '';
        toast('URL inválida. Não foi salva.', '⚠');
      }
    });
  });

  // ── Remover
  wrap.querySelectorAll('[data-action="remove"]').forEach((button) => {
    button.addEventListener('click', () => {
      const i = Number(button.dataset.i);
      if (!Number.isInteger(i)) return;

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
// 🛡️ VALIDAÇÃO — 3 camadas
// ─────────────────────────────────────────────────────────────

/**
 * Limpa a string antes de qualquer análise:
 *  - Remove espaços, tabs, newlines no início/fim
 *  - Remove caracteres de controle (incluindo \0, \x00-\x1F)
 *  - Remove BOM e zero-width spaces
 */
function sanitizeInput(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')   // controles
    .replace(/[\u200B-\u200D\uFEFF]/g, '')   // zero-width
    .trim();
}

/**
 * Detecta tentativas de disfarce de protocolo.
 * Ex: "java\nscript:", "jav&#x09;ascript:", "%6a%61%76%61script:"
 */
function looksLikeProtocolDisguise(input) {
  const lower = input.toLowerCase();

  // Decodifica percent-encoding simples
  let decoded = lower;
  try {
    decoded = decodeURIComponent(lower);
  } catch {
    // Se decodeURIComponent falhar, mantém o original
  }

  // Remove caracteres que podem quebrar o parser
  const stripped = decoded.replace(/[\s\u0000-\u001F]/g, '');

  // Verifica se algum protocolo proibido aparece (com ou sem disfarce)
  for (const proto of FORBIDDEN_PROTOCOLS) {
    if (
      lower.includes(proto) ||
      decoded.includes(proto) ||
      stripped.includes(proto)
    ) {
      return true;
    }
  }

  // Detecta "java script:" / "jav ascript:" (com espaços no meio)
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(stripped)) {
    return true;
  }

  return false;
}

/**
 * Valida uma URL externa.
 * Aceita apenas http(s) com host válido.
 */
function isValidExternalUrl(raw) {
  if (typeof raw !== 'string') return false;
  const cleaned = sanitizeInput(raw);
  if (!cleaned) return false;

  // 🛡️ Camada 1: bloqueia disfarces de protocolo perigoso
  if (looksLikeProtocolDisguise(cleaned)) return false;

  // Se não tem esquema explícito, considera inválido para validação
  // (a normalização cuida de adicionar "https://" no blur)
  if (!/^[a-z][a-z0-9+.\-]*:/i.test(cleaned)) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return false;
  }

  // 🛡️ Camada 2: whitelist de protocolos
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;

  // 🛡️ Camada 3: sanity check do host
  if (!parsed.hostname || !parsed.hostname.includes('.')) return false;

  return true;
}

/**
 * Normaliza uma URL.
 * Adiciona "https://" se o usuário digitou sem esquema.
 * Retorna null se inválida.
 */
function normalizeExternalUrl(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = sanitizeInput(raw);
  if (!cleaned) return null;

  // 🛡️ Bloqueia disfarces ANTES de tentar adicionar https://
  if (looksLikeProtocolDisguise(cleaned)) return null;

  // Adiciona "https://" se não tiver esquema
  let candidate = cleaned;
  if (!/^[a-z][a-z0-9+.\-]*:/i.test(candidate)) {
    candidate = 'https://' + candidate;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }

  // 🛡️ Whitelist de protocolos
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;

  // 🛡️ Host válido
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;

  // 🛡️ Bloqueio extra: host não pode ser IP privado
  if (isPrivateHostname(parsed.hostname)) return null;

  return parsed.toString();
}

/**
 * Detecta hostnames que não deveriam aparecer em URLs públicas:
 *  - localhost
 *  - IPs privados (10.x, 172.16-31.x, 192.168.x, 127.x)
 *  - link-local (169.254.x)
 */
function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();

  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  // IPv4 privado
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }

  // IPv6 link-local / ULA
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h === '::1' || h === '[::1]') return true;

  return false;
}
