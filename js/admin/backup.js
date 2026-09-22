/* ============================================================
   admin/backup.js — Info e ações da aba "Backup do conteúdo"
   ------------------------------------------------------------
   🎯 ESCOPO
   ------------------------------------------------------------
   Este módulo exporta/importa APENAS o `site_content`:
     ✅ textos (branding, hero, sobre, filosofia)
     ✅ playlists
     ✅ planos (apenas textos/features — preços ficam no servidor)
     ✅ contato / redes sociais
     ✅ aparência (cores, fontes)

   NÃO faz parte deste backup:
     ❌ Discografia (tabelas `albums`, `tracks` — exportar via SQL)
     ❌ Usuários (tabela `profiles`)
     ❌ Assinaturas (tabela `subscriptions`)
     ❌ Aluguéis (tabela `rentals`)
     ❌ Pagamentos (tabela `payments_events`)
     ❌ Arquivos no Supabase Storage (áudios, imagens)
     ❌ Variáveis de ambiente (Vercel)
   ------------------------------------------------------------
   - Usa os helpers de admin/ui/format.js
   - Mostra versão, sessão, updatedAt, estado "dirty"
   - Painel de escopo explícito
   - Links para backup manual (Supabase, Vercel)
   ============================================================ */

import { esc, formatDateTime } from './ui/format.js';

// ─────────────────────────────────────────────────────────────
// Definição do escopo — fonte da verdade sobre o que é backupeado
// ─────────────────────────────────────────────────────────────
const INCLUDED = [
  { label: 'Branding', note: 'nome, rodapé, meta, imagem de fundo' },
  { label: 'Hero', note: 'título, subtítulo, botões, vinil' },
  { label: 'Sobre', note: 'título, parágrafos, citação, imagem' },
  { label: 'Filosofia', note: 'frases e autores' },
  { label: 'Discografia (textos)', note: 'títulos de seção — os álbuns em si ficam no banco' },
  { label: 'Playlists', note: 'nome, capa, descrição, IDs das faixas' },
  { label: 'Planos (textos)', note: 'nome, descrição, features — preços ficam no servidor' },
  { label: 'Contato', note: 'textos e redes sociais' },
  { label: 'Aparência', note: 'cores e fontes' }
];

const EXCLUDED = [
  { label: 'Discografia', note: 'tabelas `albums` e `tracks`', how: 'SQL Editor do Supabase' },
  { label: 'Usuários', note: 'tabela `profiles`', how: 'SQL Editor do Supabase' },
  { label: 'Assinaturas', note: 'tabela `subscriptions`', how: 'SQL Editor do Supabase' },
  { label: 'Aluguéis', note: 'tabela `rentals`', how: 'SQL Editor do Supabase' },
  { label: 'Pagamentos', note: 'tabela `payments_events`', how: 'SQL Editor do Supabase' },
  { label: 'Arquivos', note: 'áudios e imagens no Storage', how: 'Supabase Storage' },
  { label: 'Env vars', note: 'segredos e tokens', how: 'Vercel / .env' }
];

// ─────────────────────────────────────────────────────────────
// Render principal
// ─────────────────────────────────────────────────────────────
export function renderBackupInfo(state) {
  const el = document.getElementById('backupInfo');
  if (!el) return;

  const version = Number(state?.contentVersion) || 0;
  const user = extractUser(state?.user);
  const dirty = !!state?.dirty;
  const updatedAt = state?.contentUpdatedAt
    ? formatDateTime(state.contentUpdatedAt)
    : '—';

  el.innerHTML = `
    <div class="backup-scope-header">
      <h3 style="margin:0 0 0.5rem;">Backup do conteúdo do site</h3>
      <p class="hint" style="color:var(--text-dim);font-size:0.85rem;margin:0;">
        Este painel exporta e importa <strong>apenas o conteúdo editorial</strong>
        (textos, playlists, planos, contato, aparência).
        A discografia, usuários, vendas e arquivos <strong>não</strong> estão inclusos.
      </p>
    </div>

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
        <div class="value" style="font-size:1.1rem;${dirty ? 'color:var(--warning,#f0a100);' : ''}">
          ${dirty ? 'Sim (não salvo)' : 'Não'}
        </div>
      </div>
    </div>

    <div class="backup-actions-hint">
      <p style="color:var(--text-dim);font-size:0.85rem;margin:0;">
        <strong style="color:var(--text);">Export</strong> baixa um JSON com a versão atual do conteúdo.<br>
        <strong style="color:var(--text);">Import</strong> faz merge profundo com o conteúdo padrão e salva no servidor.
      </p>
    </div>

    <div class="backup-scope">
      <div class="backup-scope__col backup-scope__col--in">
        <h4>✅ Incluído neste backup</h4>
        <ul>
          ${INCLUDED.map((item) => `
            <li>
              <strong>${esc(item.label)}</strong>
              <span class="hint">${esc(item.note)}</span>
            </li>
          `).join('')}
        </ul>
      </div>

      <div class="backup-scope__col backup-scope__col--out">
        <h4>❌ Não incluído — faça backup separadamente</h4>
        <ul>
          ${EXCLUDED.map((item) => `
            <li>
              <strong>${esc(item.label)}</strong>
              <span class="hint">${esc(item.note)}</span>
              <em class="backup-scope__how">→ ${esc(item.how)}</em>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>

    <div class="backup-external">
      <h4>Como fazer backup do resto</h4>
      <div class="backup-external__grid">
        <a class="backup-external__link"
           href="https://supabase.com/dashboard/project/_/sql"
           target="_blank" rel="noopener noreferrer">
          <strong>Supabase SQL Editor</strong>
          <span>Exportar álbuns, faixas, usuários, vendas</span>
        </a>
        <a class="backup-external__link"
           href="https://supabase.com/dashboard/project/_/storage/buckets"
           target="_blank" rel="noopener noreferrer">
          <strong>Supabase Storage</strong>
          <span>Baixar áudios e imagens</span>
        </a>
        <a class="backup-external__link"
           href="https://vercel.com/dashboard"
           target="_blank" rel="noopener noreferrer">
          <strong>Vercel</strong>
          <span>Conferir variáveis de ambiente</span>
        </a>
      </div>
    </div>
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
