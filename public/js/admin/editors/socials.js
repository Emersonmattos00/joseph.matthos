/* ============================================================
   js/admin/editors/socials.js — Editor de Redes Sociais (v2)
   ------------------------------------------------------------
   - Removida a limpeza destrutiva na renderização
   - URL inválida NÃO é apagada (mantida para revisão, com borda vermelha)
   - markDirty() aplicado em todas as alterações reais
   - Validação por domínio esperado (Spotify, YouTube, etc.)
   - Limite de caracteres e quantidade de registros
   - Registros malformados são preservados (não silenciados)
   ============================================================ */

import { AdminState, markDirty } from '../state.js';
import { esc } from '../ui/dom.js';
import { toast } from '../ui/toast.js';

// ─────────────────────────────────────────────────────────────
// Redes permitidas e domínios esperados
// ─────────────────────────────────────────────────────────────
const NETWORKS = [
  { key: 'spotify',    label: 'Spotify',      domains: ['open.spotify.com', 'spotify.com'] },
  { key: 'youtube',    label: 'YouTube',      domains: ['youtube.com', 'youtu.be', 'www.youtube.com'] },
  { key: 'amazon',     label: 'Amazon Music', domains: ['music.amazon.com', 'amazon.com'] },
  { key: 'facebook',   label: 'Facebook',     domains: ['facebook.com', 'fb.com', 'www.facebook.com'] },
  { key: 'tiktok',     label: 'TikTok',       domains: ['tiktok.com', 'www.tiktok.com'] },
  { key: 'apple',      label: 'Apple Music',  domains: ['music.apple.com', 'apple.com'] },
  { key: 'audiomack',  label: 'Audiomack',    domains: ['audiomack.com'] },
  { key: 'deezer',     label: 'Deezer',       domains: ['deezer.com', 'www.deezer.com'] },
  { key: 'soundcloud', label: 'SoundCloud',   domains: ['soundcloud.com'] },
  { key: 'instagram',  label: 'Instagram',    domains: ['instagram.com', 'www.instagram.com'] },
  { key: 'x',          label: 'X (Twitter)',  domains: ['x.com', 'twitter.com'] }
];

const LABEL_BY_KEY = Object.fromEntries(NETWORKS.map((n) => [n.key, n.label]));
const DOMAINS_BY_KEY = Object.fromEntries(NETWORKS.map((n) => [n.key, n.domains]));

const MAX_SOCIALS = 15;
const MAX_URL_LEN = 500;

// ─────────────────────────────────────────────────────────────
// Protocolos permitidos e proibidos
// ─────────────────────────────────────────────────────────────
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:']);
const FORBIDDEN_PROTOCOLS = new Set([
  'javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:',
  'chrome:', 'chrome-extension:', 'ms-its:', 'mhtml:', 'opera:',
  'res:', 'resource:', 'view-source:', 'ws:', 'wss:', 'ftp:', 'ftps:'
]);

// ─────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────
export function renderSocialEditor(content = AdminState.content) {
  const wrap = document.getElementById('socialEditor');
  if (!wrap) return;

  if (!content || typeof content !== 'object') {
    wrap.innerHTML = '<div class="admin-error-box"><p>Conteúdo inválido.</p></div>';
    return;
  }

  if (!content.contato) content.contato = {};
  if (!Array.isArray(content.contato.socials)) content.contato.socials = [];

  const socials = content.contato.socials;

  if (!socials.length) {
    wrap.innerHTML = `
      <p class="hint" style="color:var(--text-dim);padding:1rem;">
        Nenhuma rede social configurada. Clique em "+ Rede social".
      </p>`;
    return;
  }

  wrap.innerHTML = socials.map((s, i) => {
    // 🛡️ Normaliza o registro (sem apagar)
    const safe = (s && typeof s === 'object') ? s : {};
    const network = String(safe.network || 'spotify');
    const currentUrl = String(safe.url || '');
    const urlOk = !currentUrl || isValidExternalUrl(currentUrl);
    const isKnownNetwork = !!LABEL_BY_KEY[network];

    return `
      <div class="track-editor" style="border:1px solid #333;padding:1rem;margin-bottom:0.8rem;border-radius:8px;">
        <div class="track-head" style="display:flex;justify-content:space-between;align-items:center;">
          <strong>
            ${esc(safe.label || LABEL_BY_KEY[network] || network)}
            ${!isKnownNetwork ? '<span class="hint" style="color:#f0a100;font-size:0.7rem;">(rede antiga)</span>' : ''}
          </strong>
          <button type="button" class="btn btn-ghost btn-sm"
                  data-action="remove" data-i="${i}"
                  style="color:#ff4d4d;" aria-label="Remover">🗑</button>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="social-network-${i}">Rede</label>
            <select id="social-network-${i}" data-field="network" data-i="${i}">
              ${NETWORKS.map((n) => `
                <option value="${esc(n.key)}" ${network === n.key ? 'selected' : ''}>
                  ${esc(n.label)}
                </option>
              `).join('')}
              ${!isKnownNetwork ? `<option value="${esc(network)}" selected>${esc(network)} (antiga)</option>` : ''}
            </select>
          </div>

          <div class="form-group">
            <label for="social-url-${i}">URL</label>
            <input id="social-url-${i}"
                   type="url"
                   maxlength="${MAX_URL_LEN}"
                   value="${esc(currentUrl)}"
                   data-field="url"
                   data-i="${i}"
                   placeholder="https://..."
                   spellcheck="false"
                   autocomplete="off"
                   inputmode="url"
                   style="${urlOk ? '' : 'border-color:var(--danger);'}">

            ${!urlOk ? `
              <p class="hint" style="color:var(--danger);font-size:0.75rem;margin-top:0.3rem;">
                URL inválida — use apenas http(s) de um domínio oficial.
              </p>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // ── Select de rede
  wrap.querySelectorAll('[data-field="network"]').forEach((el) => {
    el.addEventListener('change', () => {
      const i = Number(el.dataset.i);
      if (!Number.isInteger(i) || !content.contato.socials[i]) return;

      const network = el.value;
      content.contato.socials[i].network = network;
      content.contato.socials[i].icon = network;
      content.contato.socials[i].label = LABEL_BY_KEY[network] || network;

      markDirty();
      renderSocialEditor(content);
    });
  });

  // ── Input de URL (atualiza modelo sem re-renderizar)
  wrap.querySelectorAll('[data-field="url"]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      if (!Number.isInteger(i) || !content.contato.socials[i]) return;

      const raw = el.value.trim();
      const ok = !raw || isValidExternalUrl(raw);
      el.style.borderColor = ok ? '' : 'var(--danger)';

      if (content.contato.socials[i].url !== raw) {
        content.contato.socials[i].url = raw;
        markDirty();
      }
    });

    el.addEventListener('blur', () => {
      const i = Number(el.dataset.i);
      if (!Number.isInteger(i) || !content.contato.socials[i]) return;

      const raw = String(content.contato.socials[i].url || '').trim();
      if (!raw) {
        el.style.borderColor = '';
        return;
      }

      const network = content.contato.socials[i].network || 'spotify';
      const normalized = normalizeExternalUrl(raw, network);

      if (normalized) {
        content.contato.socials[i].url = normalized;
        el.value = normalized;
        el.style.borderColor = '';
        markDirty();
      } else {
        el.style.borderColor = 'var(--danger)';
        toast('URL inválida. Corrija antes de salvar.', '⚠');
        // ✅ Não apagamos a URL. O admin vê o que digitou e corrige.
      }
    });
  });

  // ── Remover
  wrap.querySelectorAll('[data-action="remove"]').forEach((button) => {
    button.addEventListener('click', () => {
      const i = Number(button.dataset.i);
      if (!Number.isInteger(i) || i < 0 || i >= content.contato.socials.length) return;

      const network = content.contato.socials[i]?.network || 'rede';
      if (!confirm(`Remover "${network}"?`)) return;

      content.contato.socials.splice(i, 1);
      markDirty();
      renderSocialEditor(content);
    });
  });
}

// ─────────────────────────────────────────────────────────────
// Botão "+ Rede social"
// ─────────────────────────────────────────────────────────────
export function bindSocialsAddButton() {
  const btn = document.getElementById('addSocialBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  btn.addEventListener('click', () => {
    const content = AdminState.content;
    if (!content.contato) content.contato = {};
    if (!Array.isArray(content.contato.socials)) content.contato.socials = [];

    if (content.contato.socials.length >= MAX_SOCIALS) {
      toast(`Máximo de ${MAX_SOCIALS} redes sociais.`, '⚠');
      return;
    }

    const existing = new Set(content.contato.socials.map((s) => s?.network));
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
function sanitizeInput(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim();
}

function looksLikeProtocolDisguise(input) {
  const lower = input.toLowerCase();
  let decoded = lower;
  try { decoded = decodeURIComponent(lower); } catch {}
  const stripped = decoded.replace(/[\s\u0000-\u001F]/g, '');

  for (const proto of FORBIDDEN_PROTOCOLS) {
    if (lower.includes(proto) || decoded.includes(proto) || stripped.includes(proto)) return true;
  }
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(stripped)) return true;
  return false;
}

function isValidExternalUrl(raw) {
  if (typeof raw !== 'string') return false;
  const cleaned = sanitizeInput(raw);
  if (!cleaned || cleaned.length > MAX_URL_LEN) return false;
  if (looksLikeProtocolDisguise(cleaned)) return false;

  if (!/^[a-z][a-z0-9+.\-]*:/i.test(cleaned)) return false;

  let parsed;
  try { parsed = new URL(cleaned); } catch { return false; }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return false;
  if (isPrivateHostname(parsed.hostname)) return false;

  return true;
}

/**
 * Normaliza e valida URL, verificando se o domínio bate com a rede esperada.
 */
function normalizeExternalUrl(raw, network) {
  if (typeof raw !== 'string') return null;
  const cleaned = sanitizeInput(raw);
  if (!cleaned || cleaned.length > MAX_URL_LEN) return null;
  if (looksLikeProtocolDisguise(cleaned)) return null;

  let candidate = cleaned;
  if (!/^[a-z][a-z0-9+.\-]*:/i.test(candidate)) {
    candidate = 'https://' + candidate;
  }

  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
  if (isPrivateHostname(parsed.hostname)) return null;

  // 🛡️ Validação por rede: se conhecemos a rede, o domínio deve bater
  const expected = DOMAINS_BY_KEY[network];
  if (expected && expected.length > 0) {
    const host = parsed.hostname.toLowerCase();
    const ok = expected.some(d => host === d || host.endsWith('.' + d));
    if (!ok) {
      return null; // Domínio não bate com a rede
    }
  }

  return parsed.toString();
}

function isPrivateHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // Multicast/Reservado
  }

  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  if (h === '::1' || h === '[::1]') return true;

  return false;
}