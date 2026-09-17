/* ============================================================
   admin/backup.js — Info e ações da aba Backup
   ------------------------------------------------------------
   - Usa os helpers de admin/ui/format.js (sem duplicação)
   - Mostra versão, sessão, updatedAt e estado "dirty"
   ============================================================ */

import { esc, formatDate, formatDateTime } from './ui/format.js';

export function renderBackupInfo(state) {
  const el = document.getElementById('backupInfo');
  if (!el) return;

  const version = Number(state?.contentVersion) || 0;
  const user = extractUser(state?.user);
  const dirty = state?.dirty ? 'Sim (não salvo)' : 'Não';
  const updatedAt = state?.contentUpdatedAt
    ? formatDateTime(state.contentUpdatedAt)
    : '—';

  el.innerHTML = `
    <div class="backup-grid">
      <div class="backup-card">
        <div class="label">Versão atual</div>
        <div class="value">${version}</div>
      </div>
      <div class="backup-card">
        <div class="label">Última atualização</div>
        <div class="value" style="font-size:1rem;">${esc(updatedAt)}</div>
      </div>
      <div class="backup-card">
        <div class="label">Sessão</div>
        <div class="value" style="font-size:1.1rem;">${esc(user)}</div>
      </div>
      <div class="backup-card">
        <div class="label">Alterações pendentes</div>
        <div class="value" style="font-size:1.1rem;${state?.dirty ? 'color:var(--warning,#f0a100);' : ''}">${esc(dirty)}</div>
      </div>
    </div>

    <p style="color:var(--text-dim);margin-top:1rem;">
      Conteúdo persistido no servidor (Supabase <code>site_content</code>).
      Histórico completo em <code>site_content_history</code>.
    </p>
    <p style="color:var(--text-dim);">
      <strong>Export</strong> baixa um JSON com a versão atual.<br>
      <strong>Import</strong> faz merge profundo com <code>DEFAULT_CONTENT</code> e salva no servidor.
    </p>
  `;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function extractUser(user) {
  if (!user) return '—';
  if (typeof user === 'string') return user;
  if (typeof user === 'object') {
    return user.user || user.email || user.name || '—';
  }
  return '—';
}