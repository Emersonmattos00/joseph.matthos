/* ============================================================
   admin/editors/socials.js — Editor de redes sociais
   ============================================================ */

import { AdminState } from '../state.js';
import { esc } from '../ui/dom.js';

const NETWORKS = [
  { key: 'spotify',   label: 'Spotify' },
  { key: 'youtube',   label: 'YouTube' },
  { key: 'amazon',    label: 'Amazon Music' },
  { key: 'facebook',  label: 'Facebook' },
  { key: 'tiktok',    label: 'TikTok' },
  { key: 'apple',     label: 'Apple Music' },
  { key: 'audiomack', label: 'Audiomack' }
];

export function renderSocialEditor(content = AdminState.content) {
  const wrap = document.getElementById('socialEditor');
  if (!wrap) return;

  if (!content.contato) content.contato = {};
  if (!Array.isArray(content.contato.socials)) content.contato.socials = [];

  const socials = content.contato.socials;

  if (!socials.length) {
    wrap.innerHTML = '<p class="hint" style="color:var(--text-dim);padding:1rem;">Nenhuma rede social ainda.</p>';
    return;
  }

  wrap.innerHTML = socials.map((s, i) => {
    const network = s.network || s.icon || 'spotify';
    return `
      <div class="track-editor">
        <div class="track-head">
          <strong>${esc(s.label || network)}</strong>
          <button class="btn btn-ghost btn-sm" data-action="remove" data-i="${i}">🗑</button>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Rede</label>
            <select data-field="network" data-i="${i}">
              ${NETWORKS.map((n) => `<option value="${n.key}" ${network === n.key ? 'selected' : ''}>${n.label}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>URL</label>
            <input value="${esc(s.url || '')}" data-field="url" data-i="${i}" placeholder="https://...">
          </div>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('[data-field]').forEach((el) => {
    el.addEventListener('input', () => {
      const i = Number(el.dataset.i);
      const field = el.dataset.field;
      if (!content.contato.socials[i]) return;
      content.contato.socials[i][field] = el.value;
      if (field === 'network') {
        content.contato.socials[i].icon = el.value;
        const net = NETWORKS.find((n) => n.key === el.value);
        content.contato.socials[i].label = net ? net.label : el.value;
        renderSocialEditor(content);
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
    const content = AdminState.content;
    if (!content.contato) content.contato = {};
    if (!Array.isArray(content.contato.socials)) content.contato.socials = [];
    content.contato.socials.push({
      network: 'spotify',
      icon: 'spotify',
      label: 'Spotify',
      url: ''
    });
    renderSocialEditor(content);
  });
}
