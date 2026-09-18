# Joseph Matthos — Plataforma Oficial

Site oficial + painel administrativo + loja de faixas e assinaturas.

Rapper poético, filosófico e inspirador. Discografia completa, prévias gratuitas, loja de faixas individuais e assinatura premium.

---

## 📋 Índice

- [Arquitetura](#arquitetura)
- [Stack](#stack)
- [Estrutura de arquivos](#estrutura-de-arquivos)
- [Endpoints](#endpoints)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Banco de dados](#banco-de-dados)
- [Storage (Supabase)](#storage-supabase)
- [Geração de hash do admin](#geração-de-hash-do-admin)
- [PWA / Offline](#pwa--offline)
- [Dependências npm](#dependências-npm)
- [SEO e metadados](#seo-e-metadados)
- [Deploy](#deploy)
- [Painel admin](#painel-admin)
- [Desenvolvimento local](#desenvolvimento-local)
- [Segurança](#segurança)
- [Manutenção](#manutenção)
- [Troubleshooting](#troubleshooting)

---

## 🏗️ Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENTE (navegador)                     │
│                                                             │
│  index.html                                                 │
│   ├── js/site.js          → site público                    │
│   ├── js/admin/index.js   → painel administrativo           │
│   └── sw.js               → Service Worker (cache/offline)  │
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
│  Mercado Pago     → checkout (assinaturas e aluguéis)       │
│  Upstash Redis    → rate limit (opcional)                   │
│  Google Fonts     → tipografia (Inter + Playfair Display)   │
│  Cloudflare CDN   → Font Awesome 6.5.1                      │
│  Google AdSense   → anúncios (produção apenas)              │
└─────────────────────────────────────────────────────────────┘
```

### Camadas de cache

O Service Worker (`sw.js`) atua como uma **camada de cache no cliente**, com estratégias diferentes por tipo de recurso:

| Recurso | Estratégia | Fallback offline |
|---|---|---|
| Navegação (HTML) | network-first | `offline.html` |
| Assets (CSS/JS/imagens) | cache-first + revalidate em background | placeholder / 504 |
| API (`/api/*`) | nunca cacheada | erro de rede |
| Range requests (áudio) | passa direto | erro de rede |
| Cross-origin (CDNs) | passa direto | erro de rede |

---

## 🧱 Stack

- **Frontend**: HTML + CSS + JavaScript (ES modules nativos, sem bundler)
- **Backend**: Vercel Serverless Functions (Node.js 20+)
- **Banco de dados**: Supabase (PostgreSQL 15+)
- **Autenticação**: Supabase Auth (usuários) + HMAC (admin)
- **Pagamentos**: Mercado Pago (preapproval + checkout preferences)
- **Storage**: Supabase Storage
- **Cache/Rate limit**: Upstash Redis (opcional, fail-open)
- **PWA / Offline**: Service Worker nativo + Cache API
- **Fontes**: Google Fonts (Inter + Playfair Display)
- **Ícones**: Font Awesome 6.5.1 (via cdnjs)
- **Ads**: Google AdSense (apenas em produção)
- **Deploy**: Vercel

---

## 📁 Estrutura de arquivos

```
josephmatthos/
│
├── index.html                  # Página principal (site + painel admin)
├── offline.html                # Página offline (usada pelo SW)
├── termos-uso.html             # Termos de Uso
├── politica-privacidade.html   # Política de Privacidade (LGPD)
├── sw.js                       # Service Worker (cache + offline)
├── vercel.json                 # Configuração de deploy (opcional)
├── package.json                # Engines apenas (zero deps runtime)
├── package-lock.json           # Lockfile (npm 9+)
├── schema.sql                  # Schema completo do banco
├── README.md                   # Este arquivo
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
│       ├── tema.webp
│       ├── vinil.webp
│       ├── josephmatthos.webp
│       ├── boomboombap.webp
│       └── placeholder.webp
│
└── scripts/
    └── hash-admin-password.js  # Gera hash scrypt da senha admin
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

---

## 📦 Storage (Supabase)

### Bucket

1. Supabase → **Storage** → **New bucket**
2. Nome: `site-assets`
3. Marcar como **Public** (para servir imagens/áudios diretamente)
4. Policies: leitura pública, escrita/edição/exclusão só via `service_role`

### Estrutura

```
site-assets/
  images/    ← imagens do site (hero, sobre, fundo, capas)
  audio/     ← áudios das faixas (completos e prévias)
```

### Como o backend usa

- Uploads feitos via `/api/admin?action=upload` (server-side, com `service_role`)
- O cliente **nunca** recebe a `service_role`
- URLs públicas são retornadas após o upload e persistidas em `albums`/`tracks`/`site_content`
- Exclusão de objetos via API do Supabase Storage (server-side)

### Direitos LGPD

Quando um titular exerce direito de exclusão (Art. 18 LGPD), o backend remove:
1. Os metadados no PostgreSQL
2. O objeto correspondente no bucket

Ambos os passos são necessários — remover só metadados deixa o arquivo "órfão" no bucket.

---

## 🔑 Geração de hash do admin

A senha do admin **nunca é armazenada em texto puro**. Usamos **scrypt** (N=16384, r=8, p=1) com salt de 16 bytes.

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

## 📴 PWA / Offline

O projeto inclui um **Service Worker** (`sw.js`) que fornece suporte offline parcial e cache de assets.

### Registro

O SW é registrado no final do `index.html`:

```js
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (err) {
      console.warn('[SW] Registro falhou:', err.message);
    });
  });
}
```

> Em `localhost` e `https://`, o registro funciona. Em `file://`, o navegador bloqueia — sempre teste via servidor HTTP.

### Estratégias por tipo de requisição

| Tipo | Estratégia | Observação |
|---|---|---|
| Navegação (HTML) | network-first → `offline.html` | Se offline, serve a página salva |
| Assets (CSS/JS/imagens) | cache-first + revalidate em background | Atualiza em background sem bloquear |
| API (`/api/*`) | **nunca cacheada** | Sempre vai à rede (dados sensíveis) |
| Range requests (`Range:` header) | **nunca interceptada** | Áudio com seek precisa ir direto à rede |
| Cross-origin | **nunca interceptada** | Fonts, CDNs, AdSense, MP ficam fora |

### Precache (`CACHE_STATIC`)

O SW pré-cacheia no `install`:

- Páginas: `/`, `/index.html`, `/offline.html`, `/termos-uso.html`, `/politica-privacidade.html`
- CSS: `/css/style.css`
- JS público: `utils.js`, `config.js`, `site.js`
- JS admin: todos os módulos (o SW **não segue imports**, então cada arquivo precisa estar listado)
- Imagens padrão: `tema.webp`, `vinil.webp`, `josephmatthos.webp`, `placeholder.webp`

> ⚠️ **Importante**: ao adicionar um novo módulo ES em `js/` ou `js/admin/`, você **precisa** adicioná-lo ao `CACHE_STATIC`, senão ele não estará disponível offline.

### Atualização do cache

Quando você alterar assets (CSS, JS, imagens), **bumpe a versão** no topo do `sw.js`:

```js
const CACHE_VERSION = 'jm-v9';  // ← incremente aqui
```

Ao subir para `jm-v10`, o SW:
1. Instala o novo cache
2. Ativa e **apaga** o cache antigo
3. Toma controle via `clients.claim()`

Clientes com o SW antigo pegam a atualização na próxima visita.

### Forçar atualização

Se um cliente ficar preso numa versão antiga:

```js
// No console do navegador (DevTools)
navigator.serviceWorker.getRegistrations().then(function (regs) {
  regs.forEach(function (r) { r.unregister(); });
});
```

Depois, Ctrl+Shift+R para recarregar sem cache.

### O que funciona offline

✅ Site público (HTML + CSS + JS + imagens padrão)
✅ Navegação entre páginas pré-cacheadas
✅ Página `offline.html` como fallback

### O que NÃO funciona offline

❌ Login / signup (dependem de `/api/auth`)
❌ Checkout / pagamentos
❌ Painel admin (depende de `/api/admin`)
❌ Áudios das faixas (streaming, não cacheados — apenas Range passa direto)
❌ Conteúdo dinâmico (vem de `/api/public`)

---

## 📦 Dependências npm

**Runtime = zero dependências npm.**

O `package.json` existe **apenas** para declarar a versão mínima do Node.js:

```json
{
  "private": true,
  "engines": {
    "node": ">=18"
  }
}
```

Todo o backend usa apenas módulos nativos do Node (`crypto`, `fetch` global, etc.). O `package-lock.json` reflete isso (árvore de dependências vazia).

> **Histórico**: uma versão anterior usava `bcryptjs`, que foi removido ao migrar o hash de senha do admin para `crypto.scrypt` nativo. Se você encontrar referências a `bcryptjs` em código antigo, são resquícios.

### Instalar

```bash
npm install    # apenas valida o package.json, não instala nada
```

### Por que isso importa

- **Build mais rápido** na Vercel (~2s)
- **Zero superfície de ataque** por dependências de terceiros
- **Sem `npm audit`** reclamando
- **Sem risco de supply chain attack**

---

## 🔍 SEO e metadados

### No `<head>` do `index.html`

- **Title** e **meta description** otimizados
- **Open Graph** completo (`og:type`, `og:title`, `og:image` em `.webp` 1200×1200, etc.)
- **Twitter Card** (`summary_large_image`)
- **JSON-LD** (`schema.org/MusicGroup`) com nome, gênero, descrição, imagem e URL
- **`theme-color`** (`#0b0a0c`) para a barra do navegador mobile
- **Favicon** em SVG inline (emoji 🎤)

### Páginas legais

Ambas têm `<link rel="canonical">` e são indexáveis (`robots: index, follow`):

- `/termos-uso.html`
- `/politica-privacidade.html`

### `offline.html`

Tem `<meta name="robots" content="noindex, follow">` — não deve aparecer em buscas.

### AdSense

O script do AdSense é carregado **condicionalmente**:

```js
var host = location.hostname;
var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
if (isLocal) return;  // não carrega em dev
```

Em produção (`josephmatthos.vercel.app`), o script é injetado dinamicamente. Em `localhost`, é ignorado — evita erros e requisições desnecessárias durante o desenvolvimento.

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

> ⚠️ **Atenção ao Service Worker**: se você alterou assets (CSS, JS, imagens), **bumpe `CACHE_VERSION` no `sw.js`** antes do commit. Caso contrário, clientes com cache antigo continuarão vendo a versão antiga.

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

> **⚠️ Importante**: não abra `index.html` direto via `file://` — os ES modules e o Service Worker são bloqueados por CORS.

### Testar offline

1. Rode `vercel dev` ou um servidor HTTP
2. Abra o site uma vez (para o SW instalar)
3. DevTools → **Application → Service Workers** → confirme `jm-vN` ativo
4. DevTools → **Network** → marque **Offline**
5. Recarregue → deve aparecer `offline.html`
6. Navegue para `/politica-privacidade.html` → deve carregar (está no precache)

---

## 🔒 Segurança

### Camadas de proteção

- ✅ **Nenhum dado sensível** em `localStorage` ou `IndexedDB`
- ✅ **Cookies `__Host-`** HttpOnly + SameSite=Lax em produção
- ✅ **Sessão admin** assinada com HMAC-SHA256 (4h)
- ✅ **Senha admin** com scrypt (N=16384) + salt de 16 bytes
- ✅ **Comparação timing-safe** em senhas e tokens (`crypto.timingSafeEqual`)
- ✅ **Rate limit** por IP em login e endpoints sensíveis (Upstash, opcional)
- ✅ **Auditoria** em toda operação de escrita
- ✅ **RLS** habilitada em todas as tabelas
- ✅ **`service_role` só no servidor** — nunca exposta ao cliente
- ✅ **Whitelist** de tipos MIME em uploads
- ✅ **Sanitização** de input (remove HTML de campos de nome)
- ✅ **Content Security Policy** configurada
- ✅ **Idempotência** em pagamentos (evita cobranças duplicadas)
- ✅ **Service Worker não cacheia API** — dados sensíveis sempre vão à rede
- ✅ **Service Worker não intercepta Range** — áudio vai direto à rede

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

### Atualizar assets (CSS/JS/imagens)

1. Edite os arquivos
2. **Bumpe `CACHE_VERSION` no `sw.js`** (ex: `jm-v9` → `jm-v10`)
3. Commit + push
4. O SW novo será instalado na próxima visita de cada cliente

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

## 🩺 Troubleshooting

### Service Worker não atualiza

**Sintoma**: você alterou CSS/JS, fez deploy, mas o site continua com a versão antiga.

**Causa**: esqueceu de bumpar `CACHE_VERSION` no `sw.js`.

**Solução**:
1. Bumpe `CACHE_VERSION` (`jm-v9` → `jm-v10`)
2. Commit + push
3. No navegador: DevTools → Application → Service Workers → **Unregister**
4. Ctrl+Shift+R

### Site não carrega offline

**Sintoma**: em modo offline, aparece erro de rede em vez de `offline.html`.

**Causas possíveis**:
- SW não instalado (primeira visita)
- `offline.html` não está em `CACHE_STATIC`
- URL acessada não está no cache e não é navegação

**Solução**: abra o site **uma vez online** para o SW instalar tudo. Depois teste offline.

### Admin retorna 502

**Sintoma**: login no painel admin retorna erro 502.

**Causa**: falta de policy RLS para `service_role` em alguma tabela.

**Solução**: verifique se todas as tabelas têm a policy:

```sql
create policy "xxx_service_all" on public.xxx
  for all to service_role
  using (true) with check (true);
```

Rode `select * from pg_policies where schemaname = 'public';` para auditar.

### AdSense não carrega em dev

**Comportamento esperado**: o script só carrega em produção. Em `localhost`, `127.0.0.1` e `[::1]`, é ignorado intencionalmente.

**Para testar AdSense localmente**: use um túnel (`ngrok`, `cloudflared`) e acesse via domínio público — o `hostname` não será `localhost`.

### Login admin falha após rotação de secret

**Causa**: `ADMIN_SESSION_SECRET` mudou, todas as sessões HMAC existentes ficam inválidas.

**Solução**: faça login novamente. É o comportamento esperado.

### Áudio não toca offline

**Comportamento esperado**: o SW **não intercepta** Range requests, e os áudios das faixas ficam no Supabase Storage (cross-origin). Offline, o player não consegue baixar.

**Para suportar áudio offline**, seria necessário:
1. Cachear áudios completos (grande uso de disco)
2. Interceptar Range requests e servir do cache (complexo)
3. Pré-carregar áudios via `Cache API` manualmente

Não é o objetivo atual.

### Build da Vercel falha com "npm ci can only install..."

**Causa**: `package.json` e `package-lock.json` estão dessincronizados.

**Solução**:

```bash
rm -rf node_modules package-lock.json
npm install
git add package.json package-lock.json
git commit -m "chore: sincroniza lockfile"
git push
```

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
