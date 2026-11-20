/* ============================================================
   public/js/admin/backup.js — Informações da aba "Backup"
   ------------------------------------------------------------
   ARQUITETURA OFICIAL:
     - Neon PostgreSQL: dados relacionais e conteúdo do site
     - Upstash Redis: cache/rate limit (não é fonte primária)
     - Cloudflare R2: áudios, prévias e imagens
     - Vercel: frontend, funções e variáveis de ambiente

   ESCOPO DO backup JSON desta aba:
     Inclui somente o documento editorial `site_content`:
       branding, hero, sobre, filosofia, textos de discografia,
       playlists, textos/features dos planos, contato e aparência.

   NÃO inclui:
     - tabelas relacionais de catálogo, usuários e transações;
     - objetos armazenados no Cloudflare R2;
     - dados temporários/cache do Upstash Redis;
     - variáveis secretas ou configurações de deploy da Vercel.

   IMPORTANTE:
     Este módulo apenas apresenta o escopo e os destinos de gestão.
     Exportação/importação JSON são tratadas em admin/index.js.
   ============================================================ */

import { esc, formatDateTime } from './ui/format.js';

const INCLUDED = [
  { label: 'Branding', note: 'nome, rodapé, metadados e imagem de fundo (URL/referência)' },
  { label: 'Hero', note: 'título, subtítulo, botões e configuração visual do vinil' },
  { label: 'Sobre', note: 'título, parágrafos, citação e referência da imagem' },
  { label: 'Filosofia', note: 'frases e autores' },
  { label: 'Discografia (textos)', note: 'títulos e textos das seções; não inclui álbuns/faixas do banco' },
  { label: 'Playlists editoriais', note: 'nome, capa/referência, descrição e IDs de faixas' },
  { label: 'Planos (apresentação)', note: 'nomes, descrições e recursos; preços e regras comerciais ficam no servidor' },
  { label: 'Contato', note: 'textos e redes sociais' },
  { label: 'Aparência', note: 'cores, fontes e preferências visuais' }
];

const EXCLUDED = [
  { label: 'Catálogo musical', note: 'tabelas `albums`, `tracks` e relações', how: 'Backup PostgreSQL no Neon' },
  { label: 'Usuários e autenticação', note: 'tabela `users`, tokens e registros de auditoria', how: 'Backup PostgreSQL no Neon' },
  { label: 'Pedidos e pagamentos', note: 'tabelas `orders`, `order_items` e `payments_events`', how: 'Backup PostgreSQL no Neon' },
  { label: 'Assinaturas e aluguéis', note: 'tabelas `subscriptions`, `rentals` e produtos relacionados', how: 'Backup PostgreSQL no Neon' },
  { label: 'Arquivos de mídia', note: 'áudios completos, prévias, capas e imagens', how: 'Backup/replicação de objetos no Cloudflare R2' },
  { label: 'Cache e rate limit', note: 'chaves temporárias e contadores; Redis não deve ser a fonte oficial dos dados', how: 'Backups do Upstash, se houver estado operacional que precise ser preservado' },
  { label: 'Variáveis e deploy', note: 'segredos, tokens, configurações e domínios', how: 'Configurações do projeto na Vercel; guardar segredos em cofre seguro' }
];

const DASHBOARDS = [
  {
    title: 'Neon PostgreSQL',
    description: 'Banco de dados, branches, snapshots e recuperação',
    url: 'https://console.neon.tech/'
  },
  {
    title: 'Cloudflare R2',
    description: 'Buckets, objetos, credenciais e armazenamento de mídia',
    url: 'https://dash.cloudflare.com/'
  },
  {
    title: 'Upstash Redis',
    description: 'Cache, rate limit e backups/exportações Redis',
    url: 'https://console.upstash.com/redis'
  },
  {
    title: 'Vercel',
    description: 'Deployments, domínios, logs e variáveis de ambiente',
    url: 'https://vercel.com/dashboard'
  }
];

export function renderBackupInfo(state) {
  const el = document.getElementById('backupInfo');
  if (!el) return;

  const versionValue = Number(state?.contentVersion);
  const version = Number.isSafeInteger(versionValue) && versionValue >= 0
    ? versionValue
    : 0;
  const user = extractUser(state?.user);
  const dirty = state?.dirty === true;
  const updatedAt = state?.contentUpdatedAt
    ? formatDateTime(state.contentUpdatedAt)
    : '—';

  el.innerHTML = `
    <section class="backup-scope-header" aria-labelledby="backup-title">
      <h3 id="backup-title" style="margin:0 0 0.5rem;">Backup do conteúdo do site</h3>
      <p class="hint" style="color:var(--text-dim);font-size:0.85rem;margin:0;">
        Esta ferramenta trabalha somente com o conteúdo editorial armazenado em
        <strong>Neon PostgreSQL</strong> na estrutura <code>site_content</code>.
        Não substitui o backup completo do banco nem o backup dos arquivos do R2.
      </p>
    </section>

    <div class="backup-grid">
      <div class="backup-card">
        <div class="label">Versão carregada</div>
        <div class="value">${version}</div>
      </div>
      <div class="backup-card">
        <div class="label">Última atualização conhecida</div>
        <div class="value" style="font-size:1rem;">${esc(updatedAt)}</div>
      </div>
      <div class="backup-card">
        <div class="label">Sessão administrativa</div>
        <div class="value" style="font-size:1.1rem;">${esc(user)}</div>
      </div>
      <div class="backup-card">
        <div class="label">Alterações locais pendentes</div>
        <div class="value" style="font-size:1.1rem;${dirty ? 'color:var(--warning,#f0a100);' : ''}">
          ${dirty ? 'Sim — não salvas' : 'Não'}
        </div>
      </div>
    </div>

    <div class="backup-actions-hint">
      <p style="color:var(--text-dim);font-size:0.85rem;margin:0;">
        <strong style="color:var(--text);">Exportar JSON</strong> gera um arquivo do conteúdo editorial carregado no painel.
        <strong style="color:var(--text);">Importar JSON</strong> envia o conteúdo para validação e gravação no servidor.
        Antes de exportar, salve as alterações pendentes para não confundir estado local com versão persistida.
      </p>
    </div>

    <div class="backup-scope">
      <div class="backup-scope__col backup-scope__col--in">
        <h4>Incluído no JSON editorial</h4>
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
        <h4>Fora do JSON editorial — backup separado</h4>
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
      <h4>Gestão e recuperação da infraestrutura</h4>
      <div class="backup-external__grid">
        ${DASHBOARDS.map((item) => `
          <a class="backup-external__link"
             href="${esc(item.url)}"
             target="_blank"
             rel="noopener noreferrer">
            <strong>${esc(item.title)}</strong>
            <span>${esc(item.description)}</span>
          </a>
        `).join('')}
      </div>
    </div>

    <p class="hint" style="color:var(--text-dim);font-size:0.8rem;margin-top:1rem;">
      Segurança: nunca inclua DATABASE_URL, tokens do Upstash, chaves do R2,
      credenciais do Mercado Pago ou segredos da Vercel no JSON editorial.
      Arquivos exportados podem conter URLs e identificadores internos; armazene-os em local privado.
    </p>
  `;
}

function extractUser(user) {
  if (!user) return '—';
  if (typeof user === 'string') return user.slice(0, 254);
  if (typeof user === 'object') {
    const value = user.user || user.email || user.name;
    return typeof value === 'string' ? value.slice(0, 254) : '—';
  }
  return '—';
}
