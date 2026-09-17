/* ============================================================
   admin/editors/socials.js — Editor de redes sociais
   ============================================================ */

import { AdminState } from '../index.js';
import { esc } from '../ui/dom.js';

const NETWORKS = [
  { key: 'spotify',   label: 'Spotify' },
  { key: 'youtube',   label: 'YouTube' },
  { key: 'amazon',    label: 'Amazon Music' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'tiktok',    label: 'TikTok' },
  { key: 'apple',     label: 'Apple Music' },
  { key: 'audiomack', label: 'Audiomack' },
  { key: 'itunes',    label: 'iTunes' },
  { key: 'deezer',    label: 'Deezer' }
];

const LABEL_BY_KEY = Object.fromEntries(NETWORKS.map((n) => [n.key, n.label]));

export function renderSocialEditor(content = AdminState.content) {
  const wrap = document.getElementById('socialEditor');
  if (!wrap) return;

  wrap.innerHTML = content.contato.socials.map((s, i) => `
    <div class="track-editor">
      <div class="track-head">
        <strong>${esc(s.label || LABEL_BY_KEY[s.network || s.icon] || 'Rede')}</strong>
        <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}" aria-label="Remover">🗑</button>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Rede</label>
          <select data-field="network" data-i="${i}">
            ${NETWORKS.map((n) =>
              `<option value="${n.key}" ${(s.network || s.icon) === n.key ? 'selected' : ''}>${n.label}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label>URL</label>
          <input type="text" value="${esc(s.url || '')}" data-field="url" data-i="${i}" placeholder="https://...">
        </div>
      </div>
    </div>`).join('');

  // Bind
  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (field === 'network') {
        const net = el.value;
        content.contato.socials[i].network = net;
        content.contato.socials[i].icon = net;    // compatibilidade
        content.contato.socials[i].label = LABEL_BY_KEY[net] || net;
        renderSocialEditor(content);              // re-render para atualizar título
      } else {
        content.contato.socials[i][field] = el.value;
      }
    });
  });

  wrap.querySelectorAll('[data-action="remove"]').forEach((b) =>
    b.addEventListener('click', () => {
      content.contato.socials.splice(Number(b.dataset.i), 1);
      renderSocialEditor(content);
    }));
}

export function bindSocialsAddButton() {
  const btn = document.getElementById('addSocialBtn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    AdminState.content.contato.socials.push({
      network: 'spotify',
      icon: 'spotify',
      label: 'Spotify',
      url: '#'
    });
    renderSocialEditor(AdminState.content);
  });
}