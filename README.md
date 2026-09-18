# Joseph Matthos — Plataforma Oficial

Site oficial + painel administrativo + loja de faixas e assinaturas.

Rapper poético, filosófico e inspirador. Discografia completa, prévias gratuitas, loja de faixas individuais e assinatura premium.

---

## 📋 Índice

- [Arquitetura](#arquitetura)
- [Estrutura de arquivos](#estrutura-de-arquivos)
- [Endpoints](#endpoints)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Banco de dados](#banco-de-dados)
- [Geração de hash do admin](#geração-de-hash-do-admin)
- [Deploy](#deploy)
- [Painel admin](#painel-admin)
- [Desenvolvimento local](#desenvolvimento-local)
- [Segurança](#segurança)
- [Manutenção](#manutenção)

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENTE (navegador)                     │
│                                                             │
│  index.html                                                 │
│   ├── site.js         → site público                        │
│   └── admin/index.js  → painel administrativo               │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              VERCEL SERVERLESS FUNCTIONS                    │
│                                                             │
│  /api/public    → conteúdo + catálogo + planos (público)    │
│  /api/auth      → login, signup, logout, refresh, me        │
│  /api/admin     → painel admin (protegido por HMAC)         │
│  /api/payments  → Mercado Pago (subscription, rental, WH)   │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       SUPABASE                              │
│                                                             │
│  Auth        → usuários                                     │
│  Postgres    → profiles, albums, tracks, subscriptions,    │
│                rentals, payments_*, site_content, audit    │
│  Storage     → imagens e áudios (bucket: site-assets)      │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    SERVIÇOS EXTERNOS                        │
│                                                             │
│  Mercado Pago  → checkout (assinaturas e aluguéis)          │
│  Upstash Redis → rate limit (opcional)                      │
└─────────────────────────────────────────────────────────────┘
```

### Stack

- **Frontend**: HTML + CSS + JavaScript (ES modules nativos, sem bundler)
- **Backend**: Vercel Serverless Functions (Node.js 20+)
- **Banco de dados**: Supabase (PostgreSQL 15+)
- **Autenticação**: Supabase Auth (usuários) + HMAC (admin)
- **Pagamentos**: Mercado Pago (preapproval + checkout preferences)
- **Storage**: Supabase Storage
- **Cache/Rate limit**: Upstash Redis (opcional, fail-open)
- **Deploy**: Vercel

---

## 📁 Estrutura de arquivos

```
josephmatthos/
│
├── index.html                  # Página principal (site + painel admin)
├── vercel.json                 # Configuração de deploy (opcional)
├── README.md                   # Este arquivo
├── schema.sql                  # Schema completo do banco
│
├── css/
│   └── style.css               # Todos os estilos (site + admin)
│
├── js/
│   ├── config.js               # Conteúdo padrão (fallback)
│   ├── utils.js                # Helpers (esc, format, toast, etc)
│   ├── site.js                 # Site público (entry point)
│   │
│   └── admin/                  # Painel administrativo
│       ├── index.js            # Entry point do painel
│       ├── state.js            # Estado compartilhado
│       ├── api.js              # Wrapper de fetch
│       ├── auth.js             # Login / logout / sessão
│       ├── content.js          # Conteúdo (GET/PUT)
│       ├── uploads.js          # Upload de imagens/áudios
│       ├── dashboard.js        # Cards de estatísticas
│       ├── users.js            # Gestão de usuários
│       ├── sales.js            # Vendas e assinaturas
│       ├── backup.js           # Info de backup
│       │
│       ├── ui/                 # Componentes de UI
│       │   ├── dom.js          # getByPath, setByPath, esc
│       │   ├── format.js       # formatPrice, formatDate, formatCents
│       │   ├── modal.js        # Modal genérico
│       │   └── toast.js        # Notificações
│       │
│       └── editors/            # Editores específicos
│           ├── frases.js       # Frases da filosofia
│           ├── albums.js       # Álbuns e faixas
│           ├── playlists.js    # Playlists
│           ├── plans.js        # Planos de assinatura
│           └── socials.js      # Redes sociais
│
├── api/                        # Serverless Functions
│   ├── _lib.js                 # Módulos internos compartilhados
│   ├── public.js               # Endpoints públicos
│   ├── auth.js                 # Autenticação de usuários
│   ├── admin.js                # Painel administrativo
│   └── payments.js             # Mercado Pago
│
├── assets/
│   └── img/                    # Imagens estáticas
│       ├── tema.png
│       ├── vinil.png
│       ├── josephmatthos.png
│       └── album-boom-boom-bap.jpg
│
├── scripts/
│   └── hash-admin-password.js  # Gera hash scrypt da senha admin
│
└── sw.js                       # Service Worker (opcional)
```

---

## 🌐 Endpoints

### Público (sem autenticação)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/public` | Conteúdo + catálogo + planos (agregado) |
| `GET` | `/api/public?resource=content` | Apenas o conteúdo do site |
| `GET` | `/api/public?resource=tracks` | Apenas o catálogo de faixas |
| `GET` | `/api/public?resource=plans` | Apenas os planos de assinatura |

**Cache HTTP**: 60s browser / 300s CDN (`stale-while-revalidate`).

### Autenticação de usuários

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/auth?action=login` | Login com e-mail + senha |
| `POST` | `/api/auth?action=signup` | Cadastro |
| `POST` | `/api/auth?action=logout` | Encerra sessão |
| `POST` | `/api/auth?action=refresh` | Renova tokens |
| `GET`  | `/api/auth?action=me` | Dados do usuário + aluguéis ativos |

### Painel administrativo

Todas as ações (exceto `login`) exigem sessão válida via cookie `__Host-jm_admin`.

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/admin?action=login` | Login do admin |
| `GET`  | `/api/admin?action=session` | Valida sessão |
| `POST` | `/api/admin?action=logout` | Encerra sessão |
| `GET`  | `/api/admin?action=content` | Lê o conteúdo do site |
| `PUT`  | `/api/admin?action=content` | Salva o conteúdo (com controle de versão) |
| `POST` | `/api/admin?action=upload` | Upload de imagem/áudio |
| `GET`  | `/api/admin?action=users` | Lista usuários + planos |
| `PATCH`| `/api/admin?action=users` | Altera plano do usuário |
| `GET`  | `/api/admin?action=sales` | Assinaturas + aluguéis + eventos |

### Pagamentos

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/payments?type=subscription` | Cria assinatura no Mercado Pago |
| `POST` | `/api/payments?type=rental` | Cria aluguel de 48h |
| `POST` | `/api/payments?type=webhook` | Recebe notificações do MP |

---

## 🔐 Variáveis de ambiente

Configurar no Vercel em **Project → Settings → Environment Variables**.

Marcar como **Production**, **Preview** e **Development** quando aplicável.

### Supabase (obrigatórias)

| Variável | Descrição | Exemplo |
|---|---|---|
| `SUPABASE_URL` | URL do projeto Supabase | `https://xxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Chave anon (pública) | `eyJhbGci...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service_role (server-only) | `eyJhbGci...` |

### Admin (obrigatórias)

| Variável | Descrição |
|---|---|
| `ADMIN_USER` | Login do admin (ex: `admin`) |
| `ADMIN_PASSWORD_HASH` | Hash scrypt da senha (formato `scrypt$salt$hash`) |
| `ADMIN_SESSION_SECRET` | Segredo HMAC (64 hex chars) |
| `ALLOWED_ORIGINS` | Origins confiáveis para CSRF (ex: `https://seudominio.com`) |

### Mercado Pago (para pagamentos)

| Variável | Descrição |
|---|---|
| `MP_ACCESS_TOKEN` | Access token do MP |
| `MP_PUBLIC_KEY` | Public key do MP |
| `MP_WEBHOOK_SECRET` | Secret para validar webhooks |
| `MP_BACK_URL` | URL de retorno após checkout (HTTPS) |
| `MP_WEBHOOK_URL` | URL que recebe notificações |
| `MP_ENV` | `production` ou `sandbox` |
| `MP_PREMIUM_MONTHLY_PRICE` | Preço mensal em reais (ex: `19.90`) |
| `MP_PREMIUM_ANNUAL_PRICE` | Preço anual em reais (ex: `179.00`) |

### Upstash Redis (opcional)

| Variável | Descrição |
|---|---|
| `UPSTASH_REDIS_REST_URL` | URL do Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Token do Upstash |

> **Nota**: sem essas variáveis, o rate limit é desabilitado (fail-open). O sistema continua funcionando normalmente.

### Outras

| Variável | Descrição |
|---|---|
| `SIGNUP_REDIRECT_URL` | URL de confirmação de e-mail |
| `NODE_ENV` | `production` (garante `__Host-` + `Secure` em cookies) |

---

## 🗄️ Banco de dados

### Tabelas

| Tabela | Descrição |
|---|---|
| `profiles` | Dados públicos do usuário (sem plano) |
| `albums` | Álbuns, EPs e singles |
| `tracks` | Faixas com preço em centavos |
| `subscriptions` | Assinaturas ativas (fonte de verdade do plano) |
| `rentals` | Aluguéis de 48h por faixa |
| `payments_attempts` | Idempotência de checkout |
| `payments_events` | Idempotência de webhook |
| `site_content` | Conteúdo do site (JSON) |
| `site_content_history` | Histórico de versões |
| `admin_audit` | Auditoria de ações do painel |
| `auth_audit_log` | Auditoria de login/signup/logout |

### View

| View | Descrição |
|---|---|
| `effective_plan` | Plano efetivo derivado de `subscriptions` |

### Aplicar o schema

1. Abra o **SQL Editor** do Supabase
2. Cole o conteúdo de `schema.sql`
3. Clique em **Run**

O schema é **idempotente** — pode rodar várias vezes sem erro.

### RLS (Row Level Security)

**Todas as tabelas têm RLS habilitado.** O `service_role` **não bypassa RLS automaticamente** no Supabase — ele precisa de policies explícitas:

```sql
create policy "xxx_service_all" on public.xxx
  for all to service_role
  using (true) with check (true);
```

**Sem essas policies, os endpoints do admin retornam 502.**

### Bucket do Storage

1. Supabase → **Storage** → **New bucket**
2. Nome: `site-assets`
3. Marcar como **Public**
4. Policies: leitura pública, escrita só via service role

Estrutura:
```
site-assets/
  images/    ← imagens do site
  audio/     ← áudios das faixas
```

---

## 🔑 Geração de hash do admin

A senha do admin **nunca é armazenada em texto puro**. Usamos **scrypt** (N=16384, r=8, p=1).

### Opção A — via Node.js local

Instale Node.js (https://nodejs.org/) e rode:

```bash
node -e "const c=require('crypto');const p='SUA_SENHA_AQUI';const s=c.randomBytes(16);c.scrypt(p,s,64,{N:16384,r:8,p:1},(e,k)=>{if(e)throw e;console.log('scrypt$'+s.toString('hex')+'$'+k.toString('hex'));});"
```

Troque `SUA_SENHA_AQUI` pela senha real. Copie o resultado (começa com `scrypt$`).

### Opção B — via script

```bash
node scripts/hash-admin-password.js
```

### Configurar no Vercel

Cole o hash em `ADMIN_PASSWORD_HASH` no Vercel → Settings → Environment Variables.

### Segurança

- **Guarde a senha em claro** em um gerenciador de senhas (Bitwarden, 1Password, etc)
- **Nunca versione** o hash em repositório público
- **Rotacione** o `ADMIN_SESSION_SECRET` periodicamente
- **Não reutilize** a senha do admin em outros serviços

---

## 🚀 Deploy

### Primeiro deploy

1. **Fork** ou clone este repositório
2. **Conecte** ao Vercel (import project)
3. **Configure** as variáveis de ambiente
4. **Faça deploy**
5. **Rode o schema** no Supabase SQL Editor
6. **Crie o bucket** `site-assets` no Supabase Storage
7. **Teste** `https://seu-projeto.vercel.app` e o painel com `Ctrl+Shift+A`

### Deploys subsequentes

```bash
git add .
git commit -m "descrição da mudança"
git push
```

O Vercel detecta o push e faz deploy automático (~30s).

### Ambientes

| Environment | URL | Branch |
|---|---|---|
| Production | `seu-projeto.vercel.app` | `main` |
| Preview | `seu-projeto-xxx.vercel.app` | qualquer branch |
| Development | local | `vercel dev` |

> **⚠️ Atenção**: use **sempre** o domínio de Production. Os domínios de Preview têm URL temporária e podem não ter todas as envs.

---

## 🎛️ Painel admin

- **URL**: `https://seu-projeto.vercel.app`
- **Atalho**: `Ctrl + Shift + A`
- **Login**: `ADMIN_USER` + senha em claro

### Funcionalidades

| Aba | O que faz |
|---|---|
| **Dashboard** | Cards com estatísticas (usuários, vendas, receita) |
| **Geral** | Branding (nome, rodapé, SEO, imagem de fundo) |
| **Hero** | Seção principal (título, subtítulo, botões, vinil) |
| **Sobre** | Seção "Sobre Joseph" (texto, imagem, quote) |
| **Filosofia** | Frases e citações |
| **Discografia** | Álbuns, EPs, singles e faixas |
| **Vendas** | Assinaturas, aluguéis e eventos de pagamento |
| **Planos** | Planos de assinatura (textos e features) |
| **Contato** | Redes sociais e informações |
| **Usuários** | Lista de usuários + alteração manual de plano |
| **Aparência** | Cores e tipografia |
| **Backup** | Exportar/importar JSON do conteúdo |

### Sessão

- Duração: **4 horas**
- Cookie: `__Host-jm_admin` (HttpOnly, SameSite=Lax, Secure em produção)
- Assinatura: HMAC-SHA256 com `ADMIN_SESSION_SECRET`

---

## 💻 Desenvolvimento local

### Instalar Vercel CLI

```bash
npm i -g vercel
```

### Rodar localmente

```bash
# Na raiz do projeto
vercel dev
```

O site fica em `http://localhost:3000`.

### Configurar envs locais

Crie um arquivo `.env.local` na raiz:

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGci...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGci...
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=scrypt$...
ADMIN_SESSION_SECRET=...
ALLOWED_ORIGINS=http://localhost:3000
```

> **Nunca versione** o `.env.local`. Adicione ao `.gitignore`.

### Alternativa — servidor HTTP simples

Se você só quer ver o site público (sem backend), use:

```bash
python -m http.server 8000
```

E abra `http://localhost:8000`. **Funciona para o site público, mas o painel admin não funciona** (precisa do backend).

> **⚠️ Importante**: não abra `index.html` direto via `file://` — os ES modules são bloqueados por CORS.

---

## 🔒 Segurança

### Camadas de proteção

- ✅ **Nenhum dado sensível** em `localStorage` ou `IndexedDB`
- ✅ **Cookies `__Host-`** HttpOnly + SameSite=Lax em produção
- ✅ **Sessão admin** assinada com HMAC-SHA256 (4h)
- ✅ **Senha admin** com scrypt (N=16384) + salt de 16 bytes
- ✅ **Rate limit** por IP em login e endpoints sensíveis
- ✅ **Auditoria** em toda operação de escrita
- ✅ **RLS** habilitada em todas as tabelas
- ✅ **`service_role` só no servidor** — nunca exposta ao cliente
- ✅ **Whitelist** de tipos MIME em uploads
- ✅ **Sanitização** de input (remove HTML de campos de nome)
- ✅ **Content Security Policy** configurada
- ✅ **Idempotência** em pagamentos (evita cobranças duplicadas)
- ✅ **Timing-safe comparison** em senhas e tokens

### Secrets que NUNCA podem ir para o cliente

- `SUPABASE_SERVICE_ROLE_KEY`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_SESSION_SECRET`
- `MP_ACCESS_TOKEN`
- `MP_WEBHOOK_SECRET`
- `UPSTASH_REDIS_REST_TOKEN`

### Secrets que PODEM ir para o cliente

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `MP_PUBLIC_KEY`

### Reportar vulnerabilidades

Envie e-mail para o mantenedor. **Não abra issues públicas** para vulnerabilidades.

---

## 🔧 Manutenção

### Rotação de senha do admin

1. Gere um novo hash (`node scripts/hash-admin-password.js`)
2. Atualize `ADMIN_PASSWORD_HASH` no Vercel
3. **Faça redeploy** (Deployments → Redeploy)
4. Teste o login

### Rotação do `ADMIN_SESSION_SECRET`

1. Gere um novo segredo (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`)
2. Atualize no Vercel
3. **Faça redeploy**
4. **Todas as sessões ativas expiram** — o admin precisa logar de novo

### Limpeza de dados antigos

Rode periodicamente no SQL Editor (ou via pg_cron):

```sql
-- Aluguéis expirados
update public.rentals set status = 'expired'
where status = 'active' and expires_at < now();

-- Auditoria (retenção 90 dias)
delete from public.auth_audit_log where created_at < now() - interval '90 days';
delete from public.admin_audit   where created_at < now() - interval '90 days';

-- Eventos de pagamento (retenção 1 ano)
delete from public.payments_events where created_at < now() - interval '365 days';
```

### Monitoramento

- **Vercel → Project → Analytics**: visitas, performance
- **Vercel → Project → Logs**: erros das functions
- **Supabase → Logs**: queries lentas, erros de RLS
- **Mercado Pago → Developers**: notificações pendentes

---

## 📄 Licença

© 2026 Joseph Matthos. Todos os direitos reservados.

Este projeto é **proprietário**. Não é permitido:
- Redistribuir o código
- Usar em outros projetos
- Modificar e publicar sem autorização expressa

Para licenciamento, entre em contato.

---

## 📞 Contato

- **Site**: https://josephmatthos.vercel.app
- **Mantenedor**: Emerson Mattos

---

**Última atualização**: 18 de setembro de 2026
