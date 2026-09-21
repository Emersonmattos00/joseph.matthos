/* ============================================================
   admin/editors/albums.js — Editor de álbuns (DESABILITADO)
   ------------------------------------------------------------
   ⚠️ Álbuns foram movidos para a tabela `albums` no Supabase.
      Este editor mostra apenas uma mensagem informativa.

   📌 Fase 2 (futuro): implementar CRUD via `action=albums`
      no backend e reescrever este editor para consumir a API.
   ============================================================ */

import { esc } from '../ui/dom.js';

export function renderAlbumsEditor() {
  const wrap = document.getElementById('albumsEditor');
  if (!wrap) return;

  wrap.innerHTML = `
    <div style="
      background:var(--card);
      border:1px solid var(--border);
      border-radius:8px;
      padding:1rem 1.25rem;
      color:var(--text);
    ">
      <p style="margin:0 0 0.5rem;font-weight:600;">
        ⚠️ Edição de álbuns movida para o banco de dados
      </p>
      <p style="color:var(--text-dim);margin:0;font-size:0.9rem;line-height:1.5;">
        Álbuns e faixas agora vivem nas tabelas
        <code style="background:rgba(255,255,255,0.05);padding:0.1em 0.4em;border-radius:3px;">albums</code>
        e
        <code style="background:rgba(255,255,255,0.05);padding:0.1em 0.4em;border-radius:3px;">tracks</code>
        do Supabase.
      </p>
      <p style="color:var(--text-dim);margin:0.75rem 0 0;font-size:0.85rem;">
        Enquanto o CRUD no painel não estiver pronto, edite diretamente pelo
        <strong>SQL Editor do Supabase</strong>.
      </p>
    </div>`;
}

export function bindAlbumsAddButton() {
  // no-op — editor de álbuns desabilitado
}
