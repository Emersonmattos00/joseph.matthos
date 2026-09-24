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
│  /api/stream    → resolve URL de áudio (preview/full)       │
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
│  Postgres    → profiles, albums, tracks, subscriptions,     │
│                rentals, payments_*, site_content, audit     │
│  Storage     → site-assets (público) + audio-preview        │
│                (público) + audio-premium (privado)          │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    SERVIÇOS EXTERNOS                        │
│                                                             │
│  Mercado Pago     → checkout (assinaturas e aluguéis)       │
│  Upstash Redis    → rate limit (recomendado)                │
│  Google Fonts     → tipografia (Inter + Playfair Display)   │
│  Cloudflare CDN   → Font Awesome 6.5.1                      │
│  Google AdSense   → anúncios (produção apenas)              │
└─────────────────────────────────────────────────────────────┘
```

### Fluxo de áudio (proteção de conteúdo premium)

```
Cliente pede /api/stream?albumId=X&trackIndex=Y
       ↓
Backend verifica sessão + plano + aluguel
       ↓
   Sem acesso → retorna URL pública de audio-preview
   Com acesso → gera signed URL (30 min) para audio-premium
       ↓
Cliente toca a URL retornada (que expira no TTL configurado)
```

**Por que o bucket `audio-premium` é privado:** se a URL do arquivo completo fosse pública, qualquer pessoa com DevTools poderia copiá-la e baixar sem pagar. Como o bucket é privado, a única forma de tocar a faixa completa é passando pelo `/api/stream`, que verifica permissão a cada requisição e gera URL assinada de curta duração.

### Camadas de cache

O Service Worker (`sw.js`) atua como uma **camada de cache no cliente**, com estratégias diferentes por tipo de recurso:

| Recurso | Estratégia | Fallback offline |
|---|---|---|
| Navegação (HTML) | network-first | `offline.html` |
| Assets (CSS/JS/imagens) | cache-first + revalidate em background | placeholder / 504 |
| **JS do admin (`/js/admin/**`)** | **network-first (nunca cacheia)** | erro de rede |
| API (`/api/*`) | nunca cacheada | erro de rede |
| Range requests (áudio) | passa direto | erro de rede |
| Cross-origin (CDNs) | passa direto | erro de rede |

> **Nota sobre admin:** arquivos em `/js/admin/**` usam network-first puro. Isso evita que correções no painel fiquem presas no cache durante manutenção.

> **⚠️ O Service Worker ainda NÃO está registrado no `index.html`.** O arquivo `sw.js` existe e está funcional, mas o `<script>` que chama `navigator.serviceWorker.register('/sw.js')` precisa ser adicionado manualmente no `index.html` antes do fechamento do `</body>`. Enquanto isso, o SW permanece inativo.

---

## 🧱 Stack

- **Frontend**: HTML + CSS + JavaScript (ES modules nativos, sem bundler)
- **Backend**: Vercel Serverless Functions (Node.js 20+)
- **Banco de dados**: Supabase (PostgreSQL 15+)
- **Autenticação**: Supabase Auth (usuários) + HMAC (admin)
- **Pagamentos**: Mercado Pago (preapproval + checkout preferences)
- **Storage**: Supabase Storage (3 buckets)
- **Cache/Rate limit**: Upstash Redis (recomendado, fail-closed no admin)
- **PWA / Offline**: Service Worker nativo + Cache API
- **Fontes**: Google Fonts (Inter + Playfair Display)
- **Ícones**: Font Awesome 6.5.1 (via cdnjs)
- **Ads**: Google AdSense (apenas em produção, carregado inline no `<head>`)
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
├── vercel.json                 # Configuração de deploy (headers, cache, CSP)
├── package.json                # Engines + @upstash/redis
├── package-lock.json           # Lockfile (obrigatório — gerar com `npm install`)
├── README.md                   # Este arquivo
├── .gitignore                  # Exclusões do git
│
├── supabase/
│   └── schema.sql              # Schema completo do banco (idempotente)
│
├── css/
│   └── style.css               # Todos os estilos (site + admin + player)
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
│       ├── backup.js           # Painel informativo de backup
│       ├── playlists-api.js    # Helpers de playlist
│       │
│       ├── ui/                 # Componentes de UI
│       │   ├── dom.js          # getByPath, setByPath, esc
│       │   ├── format.js       # formatCents, formatDate, formatDateTime
│       │   ├── modal.js        # Modal genérico
│       │   └── toast.js        # Notificações
│       │
│       └── editors/            # Editores específicos
│           ├── frases.js       # Frases da filosofia
│           ├── albums.js       # Álbuns e faixas (CRUD + drag & drop + upload)
│           ├── playlists.js    # Playlists
│           ├── plans.js        # Planos de assinatura
│           └── socials.js      # Redes sociais
│
├── api/                        # Serverless Functions
│   ├── _lib.js                 # Módulos internos compartilhados
│   ├── public.js               # Endpoints públicos
│   ├── stream.js               # Resolve URL de áudio (com verificação)
│   ├── auth.js                 # Autenticação de usuários
│   ├── admin.js                # Painel administrativo
│   ├── payments.js             # Mercado Pago
│   └── debug-mp.js             # Diagnóstico do MP (⚠️ APAGAR em produção)
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

> **⚠️ Arquivos que NÃO existem mais** (foram abandonados em versões anteriores):
> - `js/adsense.js` — o AdSense agora é carregado **inline** no `<head>` do `index.html`
> - `js/sw-register.js` — o registro do SW deve ser feito **inline** no `index.html` (a fazer)
>
> **⚠️ `package-lock.json` é OBRIGATÓRIO.** Se ainda não estiver no repositório, rode `npm install` localmente e commite o arquivo gerado (ver seção [Dependências npm](#dependências-npm)).

---

## 🌐 Endpoints

### Público (sem autenticação)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/public` | Conteúdo + álbuns + faixas + planos (agregado) |
| `GET` | `/api/public?resource=content` | Apenas o conteúdo do site |
| `GET` | `/api/public?resource=albums` | Apenas os álbuns (com faixas agregadas) |
| `GET` | `/api/public?resource=tracks` | Apenas o catálogo de faixas (flat) |
| `GET` | `/api/public?resource=plans` | Apenas os planos de assinatura |
| `GET` | `/api/public?resource=rental-plans` | Apenas os planos de aluguel |

**Cache HTTP**: 60s browser / 300s CDN (`stale-while-revalidate`).

### Stream de áudio (com verificação de permissão)

| Método | Endpoint | Descrição |
|---|---|---|
| `GET` | `/api/stream?albumId=X&trackIndex=Y` | Resolve URL de áudio (preview ou full) |
| `GET` | `/api/stream?albumId=X&trackIndex=Y&debug=1` | Estado completo da faixa (sem URLs) |

**Comportamento:**
- **Sem login** → retorna `{ unlocked: false, previewUrl }`
- **Free sem aluguel** → idem
- **Premium ou aluguel ativo** → retorna `{ unlocked: true, fullUrl, expiresIn }`

`fullUrl` é uma **signed URL** que expira em TTL configurável (padrão: 30 min, entre 1 min e 1 h).

### Autenticação de usuários

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/auth?action=login` | Login com e-mail + senha |
| `POST` | `/api/auth?action=signup` | Cadastro |
| `POST` | `/api/auth?action=logout` | Encerra sessão |
| `POST` | `/api/auth?action=refresh` | Renova tokens |
| `GET`  | `/api/auth?action=me` | Dados do usuário + aluguéis ativos |
| `HEAD` | `/api/auth?action=me` | Só headers |

### Painel administrativo

Todas as ações (exceto `login`) exigem sessão válida via cookie `__Host-jm_admin`.

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/admin?action=login` | Login do admin (fail-closed no rate limit) |
| `GET`  | `/api/admin?action=session` | Valida sessão |
| `POST` | `/api/admin?action=logout` | Encerra sessão |
| `GET`  | `/api/admin?action=content` | Lê o conteúdo do site |
| `PUT`  | `/api/admin?action=content` | Salva o conteúdo (com controle de versão) |
| `POST` | `/api/admin?action=upload` | Upload Base64 (imagens) |
| `POST` | `/api/admin?action=upload-sign` | Gera signed URL de PUT (áudios) |
| `POST` | `/api/admin?action=upload-confirm` | Confirma upload e grava path no banco |
| `GET`  | `/api/admin?action=users` | Lista usuários + planos |
| `PATCH`| `/api/admin?action=users` | Altera plano do usuário |
| `GET`  | `/api/admin?action=sales` | Assinaturas + aluguéis + eventos |
| `GET`  | `/api/admin?action=audit` | Eventos de auditoria (`admin_audit` / `auth_audit_log`) |
| `GET`  | `/api/admin?action=gen-hash` | Gera hash scrypt (⚠️ TEMPORÁRIO — remover após uso) |
| `GET`  | `/api/admin?action=albums` | Lista álbuns |
| `POST` | `/api/admin?action=albums` | Cria álbum |
| `GET`  | `/api/admin?action=album&id=X` | Detalhe do álbum |
| `PATCH`| `/api/admin?action=album&id=X` | Atualiza álbum |
| `DELETE`| `/api/admin?action=album&id=X` | Exclui álbum (com `force=true` para excluir faixas) |
| `GET`  | `/api/admin?action=tracks&albumId=X` | Lista faixas de um álbum |
| `POST` | `/api/admin?action=tracks` | Cria faixa |
| `PATCH`| `/api/admin?action=track&id=X` | Atualiza faixa |
| `DELETE`| `/api/admin?action=track&id=X` | Exclui faixa |
| `PATCH`| `/api/admin?action=track-order` | Reordena faixas |

**Upload** — roteia para o bucket correto conforme `kind`:

| `kind` | Bucket de destino | Retorno |
|---|---|---|
| `image` | `site-assets` | `{ url, path, bucket }` |
| `audio-preview` | `audio-preview` | `{ url, path, bucket }` |
| `audio-full` | `audio-premium` | `{ url: null, path, bucket }` |

**Fluxo de upload de áudio (presigned):**
1. `POST ?action=upload-sign` → backend gera URL assinada de PUT
2. Browser faz `PUT` **direto** no Supabase Storage (sem passar pela Vercel)
3. `POST ?action=upload-confirm` → backend valida que o arquivo existe e (opcionalmente) grava `preview_path`/`full_path` em `tracks`

### Pagamentos

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/payments?type=subscription` | Cria assinatura no Mercado Pago |
| `POST` | `/api/payments?type=rental` | Cria aluguel (24h a 15d) |
| `POST` | `/api/payments?type=webhook` | Recebe notificações do MP |
| `GET`  | `/api/payments?type=manage` | Status da assinatura do usuário |
| `POST` | `/api/payments?type=manage` | Cancela assinatura (`{ action: "cancel" }`) |

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
| `ADMIN_SESSION_SECRET` | Segredo HMAC (64 hex chars — mínimo 32) |
| `ALLOWED_ORIGINS` | Origins confiáveis para CSRF (CSV, ex: `https://seudominio.com`) |

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

### Aluguéis (opcionais — fallback usa `tracks.price_cents`)

| Variável | Descrição |
|---|---|
| `RENTAL_PRICE_24H` | Preço em reais (ex: `2.90`) |
| `RENTAL_PRICE_48H` | Preço em reais |
| `RENTAL_PRICE_3D`  | Preço em reais |
| `RENTAL_PRICE_5D`  | Preço em reais |
| `RENTAL_PRICE_10D` | Preço em reais |
| `RENTAL_PRICE_15D` | Preço em reais |

### Upstash Redis (recomendado)

| Variável | Descrição |
|---|---|
| `UPSTASH_REDIS_REST_URL` | URL do Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | Token do Upstash |

> **Importante:** o login do admin usa `{ failClosed: true }` no rate limit. **Sem o Upstash configurado, o login do admin sempre retorna 429.** Configure as variáveis antes de fazer deploy do `api/admin.js`.

### Outras

| Variável | Descrição |
|---|---|
| `SIGNUP_REDIRECT_URL` | URL de confirmação de e-mail |
| `SIGNED_URL_TTL_SEC` | TTL da signed URL de áudio (padrão 1800s) |
| `NODE_ENV` | `production` (garante `__Host-` + `Secure` em cookies) |

---

## 🗄️ Banco de dados

### Tabelas

| Tabela | Descrição |
|---|---|
| `profiles` | Dados públicos do usuário (sem plano) |
| `albums` | Álbuns, EPs e singles |
| `tracks` | Faixas com preço em centavos e paths de áudio |
| `subscriptions` | Assinaturas ativas (fonte de verdade do plano) |
| `rentals` | Aluguéis por faixa (24h a 15d) |
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

### Tabela `tracks` (detalhe)

| Coluna | Tipo | Descrição |
|---|---|---|
| `id` | bigserial | PK |
| `album_id` | text | FK para `albums.id` |
| `track_index` | int | Índice da faixa no álbum (0-based) |
| `title` | text | Título |
| `duration` | text | Duração formatada (ex: `3:45`) |
| `full_path` | text | Nome do arquivo em `audio-premium` (privado) |
| `preview_path` | text | Nome do arquivo em `audio-preview` (público) |
| `preview_start` | int | Segundo onde a prévia começa |
| `preview_duration` | int | Duração da prévia (5–120s) |
| `price_cents` | int | Preço em centavos (ex: `499` = R$ 4,99) |
| `for_sale` | boolean | Se está à venda individualmente |
| `lyrics` | jsonb | Array de `{ time, text }` |
| `published` | boolean | Se aparece no site |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | |

> **Importante:** as colunas `full_audio` e `preview_audio` **não existem mais**. Foram substituídas por `full_path` e `preview_path` para separar "caminho no bucket" de "URL pública", permitindo o uso de signed URLs no bucket privado.

### Aplicar o schema

1. Abra o **SQL Editor** do Supabase
2. Cole o conteúdo de `supabase/schema.sql`
3. Clique em **Run**

O schema é **idempotente** — pode rodar várias vezes sem erro. A seção 16 do arquivo contém uma **migração automática** que corrige bancos antigos (`full_audio`/`preview_audio` → `full_path`/`preview_path`).

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

O projeto usa **três buckets** no Supabase Storage, com finalidades e visibilidades distintas:

| Bucket | Visibilidade | Conteúdo | Acesso |
|---|---|---|---|
| `site-assets` | 🌐 Público | Imagens de layout (capas, vinil, sobre, fundos) | URL pública direta |
| `audio-preview` | 🌐 Público | Trechos de 30s das faixas | URL pública direta via `/api/stream` |
| `audio-premium` | 🔒 **Privado** | Áudios completos das faixas | Somente via **signed URL** de curta duração |

### Estrutura dos buckets

```
site-assets/
  images/
    <timestamp>_<random>.webp     ← capas, vinil, sobre, fundos

audio-preview/
  <timestamp>_<random>.mp3        ← previews (30s)

audio-premium/
  <timestamp>_<random>.mp3        ← áudios completos
```

> Os nomes dos arquivos em `audio-preview/` e `audio-premium/` são gravados nas colunas `tracks.preview_path` e `tracks.full_path`. O cliente **nunca** vê esses nomes diretamente — pede `/api/stream`, que resolve o path para uma URL (pública no caso de preview, assinada no caso de full).

### Criação dos buckets

**⚠️ Os buckets NÃO podem ser criados via SQL** — a role do SQL Editor não tem permissão de owner sobre `storage.buckets`. Crie manualmente pelo Dashboard:

**Storage → New bucket**

| Nome | Público? | Limite | MIME types |
|---|---|---|---|
| `site-assets` | ✅ Sim | 10 MB | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| `audio-preview` | ✅ Sim | 10 MB | `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/ogg` |
| `audio-premium` | ❌ **Não** | 50 MB | `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/ogg` |

> **⚠️ ATENÇÃO:** `audio-premium` deve ser **PRIVADO**. Se marcar como público, o sistema de signed URLs perde a proteção — qualquer pessoa com a URL direta consegue baixar o áudio completo.

### Policies RLS do Storage

Depois de criar os buckets, rode no SQL Editor:

```sql
-- site-assets: leitura pública (imagens)
drop policy if exists "site_assets_public_read" on storage.objects;
create policy "site_assets_public_read"
  on storage.objects for select
  using (bucket_id = 'site-assets');

-- audio-preview: leitura pública (previews)
drop policy if exists "audio_preview_public_read" on storage.objects;
create policy "audio_preview_public_read"
  on storage.objects for select
  using (bucket_id = 'audio-preview');

-- audio-premium: NENHUMA policy de SELECT
--   O bucket é privado. Só o service_role pode gerar signed URLs via /api/stream.

-- service_role: acesso total a todos os buckets
drop policy if exists "storage_service_role_all" on storage.objects;
create policy "storage_service_role_all"
  on storage.objects for all
  to service_role
  using (true) with check (true);
```

### Como o backend usa

- Uploads feitos via `/api/admin?action=upload-sign` + `/api/admin?action=upload-confirm` (presigned, com `service_role`)
- O upload roteia para o bucket correto conforme o `kind`:
  - `image` → `site-assets`
  - `audio-preview` → `audio-preview`
  - `audio-full` → `audio-premium`
- Para áudio full, o retorno **não tem `url`** (bucket privado). O `path` deve ser gravado em `tracks.full_path`
- O cliente **nunca recebe a `service_role`**

### Direitos LGPD

Quando um titular exerce direito de exclusão (Art. 18 LGPD), o backend remove:
1. Os metadados no PostgreSQL
2. O objeto correspondente no bucket

Ambos os passos são necessários — remover só metadados deixa o arquivo "órfão" no bucket.

---

## 🔑 Geração de hash do admin

A senha do admin **nunca é armazenada em texto puro**. Usamos **scrypt** (N=16384, r=8, p=1) com salt de 16 bytes.

### Opção A — via script (recomendado)

```bash
node scripts/hash-admin-password.js
```

Modos alternativos:

```bash
node scripts/hash-admin-password.js "senha"
echo "senha" | node scripts/hash-admin-password.js --stdin
```

### Opção B — via Node.js inline

```bash
node -e "const c=require('crypto');const p='SUA_SENHA_AQUI';const s=c.randomBytes(16);c.scrypt(p,s,64,{N:16384,r:8,p:1},(e,k)=>{if(e)throw e;console.log('scrypt$'+s.toString('hex')+'$'+k.toString('hex'));});"
```

Troque `SUA_SENHA_AQUI` pela senha real. Copie o resultado (começa com `scrypt$`).

### Configurar no Vercel

Cole o hash em `ADMIN_PASSWORD_HASH` no Vercel → Settings → Environment Variables. Faça **redeploy** (variáveis só se aplicam em novos deploys).

### Segurança

- **Guarde a senha em claro** em um gerenciador de senhas (Bitwarden, 1Password, etc)
- **Nunca versione** o hash em repositório público
- **Rotacione** o `ADMIN_SESSION_SECRET` periodicamente
- **Não reutilize** a senha do admin em outros serviços

---

## 📴 PWA / Offline

O projeto inclui um **Service Worker** (`sw.js`) que fornece suporte offline parcial e cache de assets.

### Registro (⚠️ A FAZER)

O SW **ainda não está registrado** no `index.html`. Para ativar, adicione antes do fechamento do `</body>`:

```html
<script>
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function (err) {
        console.warn('[SW] falha ao registrar:', err);
      });
    });
  }
</script>
```

> Em `localhost` e `https://`, o registro funciona. Em `file://`, o navegador bloqueia — sempre teste via servidor HTTP.

### Estratégias por tipo de requisição

| Tipo | Estratégia | Observação |
|---|---|---|
| Navegação (HTML) | network-first → `offline.html` | Se offline, serve a página salva |
| Assets (CSS/JS/imagens) | cache-first + revalidate em background | Atualiza em background sem bloquear |
| **JS do admin (`/js/admin/**`)** | **network-first (nunca cacheia)** | Correções no painel nunca ficam presas |
| API (`/api/*`) | **nunca cacheada** | Sempre vai à rede |
| Range requests (`Range:` header) | **nunca interceptada** | Áudio com seek vai direto à rede |
| Cross-origin | **nunca interceptada** | Fonts, CDNs, AdSense, MP ficam fora |

### Precache (`CACHE_STATIC`)

O SW pré-cacheia no `install`:

- Páginas: `/`, `/index.html`, `/offline.html`, `/termos-uso.html`, `/politica-privacidade.html`
- CSS: `/css/style.css`
- JS público: `/js/utils.js`, `/js/config.js`, `/js/site.js`
- Imagens padrão: `/assets/img/tema.webp`, `/assets/img/vinil.webp`, `/assets/img/josephmatthos.webp`

> ⚠️ **Importante**: `js/admin/**` **não** entra no precache. Esses arquivos usam network-first.

### Atualização do cache

Quando você alterar assets, **bumpe a versão** no topo do `sw.js`:

```js
const CACHE_VERSION = 'jm-v18';  // ← incremente aqui
```

Ao subir, o SW:
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
❌ Áudios das faixas (streaming, não cacheados)
❌ Conteúdo dinâmico (vem de `/api/public`)

---

## 📦 Dependências npm

Runtime = **1 dependência opcional** (`@upstash/redis`, para rate limit).

O `package.json` declara também a versão mínima do Node.js:

```json
{
  "private": true,
  "engines": {
    "node": ">=18"
  },
  "dependencies": {
    "@upstash/redis": "1.34.0"
  }
}
```

> **Histórico**: uma versão anterior usava `bcryptjs`, que foi removido ao migrar o hash de senha do admin para `crypto.scrypt` nativo.

### Lockfile (⚠️ OBRIGATÓRIO)

O projeto **deve** ter um `package-lock.json` commitado. Sem ele:

- O build da Vercel não é determinístico (versões de dependências transitivas podem variar)
- `npm ci` falha com `npm ci can only install packages when your package.json and package-lock.json are in sync`
- Uma atualização silenciosa de dependência pode quebrar produção

### Como gerar o lockfile

Na raiz do projeto:

```bash
rm -rf node_modules package-lock.json
npm install
```

Isso cria:
- `node_modules/` (ignorado pelo git)
- `package-lock.json` (deve ser commitado)

Commit ambos os arquivos juntos:

```bash
git add package.json package-lock.json
git commit -m "chore: gera lockfile para build determinístico"
git push
```

### Fluxo correto depois disso

| Ambiente | Comando |
|---|---|
| Local (dev) | `npm install` |
| CI/CD (Vercel) | `npm ci` |
| Após editar `package.json` | `npm install` (regenera lockfile) e commitar ambos |

### Por que isso importa

- **Build rápido** na Vercel (~2s)
- **Superfície de ataque mínima** (só 1 dep)
- **Sem risco de supply chain attack** significativo
- **Build determinístico** com versões exatas cravadas

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

### AdSense (carregado inline)

O script do AdSense é carregado **inline** no `<head>` do `index.html`, condicionalmente:

```html
<script>
  (function () {
    var host = location.hostname;
    var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (isLocal) return; // não carrega em dev
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7190208592008203';
    s.crossOrigin = 'anonymous';
    document.head.appendChild(s);
  })();
</script>
```

Em produção, o script é injetado dinamicamente. Em `localhost`, é ignorado.

> **Nota:** arquivos `js/adsense.js` e `js/sw-register.js` **não existem mais** — toda a lógica está inline no `index.html`.

---

## 🚀 Deploy

### Primeiro deploy

1. **Fork** ou clone este repositório
2. **Confirme que `package-lock.json` está no repositório.**
   Se não estiver, rode `npm install` localmente e commite o arquivo gerado.
3. **Conecte** ao Vercel (import project)
4. **Configure** as variáveis de ambiente (incluindo Upstash)
5. **Faça deploy**
6. **Rode o schema** no Supabase SQL Editor (`supabase/schema.sql`)
7. **Crie os 3 buckets** (`site-assets`, `audio-preview`, `audio-premium`) + policies
8. **Teste** `https://seu-projeto.vercel.app` e o painel com `?admin` ou `Ctrl+Shift+A`

### Deploys subsequentes

```bash
git add .
git commit -m "descrição da mudança"
git push
```

O Vercel detecta o push e faz deploy automático (~30s).

> ⚠️ **Atenção ao Service Worker**: se você alterou assets (CSS, JS, imagens), **bumpe `CACHE_VERSION` no `sw.js`** antes do commit.

### Ambientes

| Environment | URL | Branch |
|---|---|---|
| Production | `seu-projeto.vercel.app` | `main` |
| Preview | `seu-projeto-xxx.vercel.app` | qualquer branch |
| Development | local | `vercel dev` |

> **⚠️ Atenção**: use **sempre** o domínio de Production. Os domínios de Preview têm URL temporária e podem não ter todas as envs.

---

## 🎛️ Painel admin

- **URL**: `https://seu-projeto.vercel.app/?admin`
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
| **Discografia** | Álbuns, EPs, singles (CRUD completo + drag & drop + upload de áudio) |
| **Vendas** | Assinaturas, aluguéis e eventos de pagamento |
| **Planos** | Planos de assinatura (textos e features — **preços não são editáveis aqui**) |
| **Contato** | Redes sociais e informações |
| **Usuários** | Lista de usuários + alteração manual de plano |
| **Aparência** | Cores e tipografia |
| **Backup** | Painel informativo + export/import JSON do conteúdo |

> **Nota sobre backup:** o painel da aba "Backup" (`admin/backup.js`) exibe o **escopo** do que é backupeado (só `site_content`) e links para backup manual do resto. Os botões **Exportar JSON** e **Importar JSON** ficam no `admin/index.js` e fazem merge profundo com `DEFAULT_CONTENT` antes de salvar.

### Fluxo de autenticação

```
?admin  (ou Ctrl+Shift+A)
   ↓
openAdminSite()
   ↓
GET /api/admin?action=session
   ↓
  ├── 401 → mostra login
   │            ↓
   │         POST /api/admin?action=login
   │            ↓
   │         (sucesso) → enterAdminDashboard() → bootContent()
   │
   └── OK → enterAdminDashboard() → bootContent()
              ↓
           loadContent() + applyContent() + renderDashboard()
```

> **Otimização:** após `POST /login` bem-sucedido, o `auth.js` **não refaz** `/session` — a resposta do `/login` já confirma a autenticação. Isso evita uma requisição duplicada.

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
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=...
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

1. Registre o SW no `index.html` (ver seção PWA)
2. Rode `vercel dev` ou um servidor HTTP
3. Abra o site uma vez (para o SW instalar)
4. DevTools → **Application → Service Workers** → confirme `jm-vN` ativo
5. DevTools → **Network** → marque **Offline**
6. Recarregue → deve aparecer `offline.html`
7. Navegue para `/politica-privacidade.html` → deve carregar (está no precache)

---

## 🔒 Segurança

### Camadas de proteção

- ✅ **Nenhum dado sensível** em `localStorage` ou `IndexedDB`
- ✅ **Cookies `__Host-`** HttpOnly + SameSite=Lax em produção
- ✅ **Sessão admin** assinada com HMAC-SHA256 (4h)
- ✅ **Senha admin** com scrypt (N=16384) + salt de 16 bytes
- ✅ **Comparação timing-safe** em senhas e tokens (`crypto.timingSafeEqual`)
- ✅ **Rate limit fail-closed** no login admin (bloqueia se Upstash cair)
- ✅ **Rate limit fail-open** em endpoints públicos (não derruba o site)
- ✅ **Auditoria** em toda operação de escrita
- ✅ **RLS** habilitada em todas as tabelas
- ✅ **`service_role` só no servidor** — nunca exposta ao cliente
- ✅ **Whitelist** de tipos MIME em uploads
- ✅ **Validação de URL em 3 camadas** no editor de redes sociais (bloqueio de protocolos perigosos, whitelist http(s), detecção de disfarces unicode/percent-encoding, bloqueio de IPs privados)
- ✅ **Sanitização** de input (remove HTML de campos de nome)
- ✅ **Content Security Policy** configurada (`vercel.json`)
- ✅ **Idempotência** em pagamentos (evita cobranças duplicadas)
- ✅ **Service Worker não cacheia API** — dados sensíveis sempre vão à rede
- ✅ **Service Worker não cacheia `/js/admin/**`** — painel sempre fresco
- ✅ **Service Worker não intercepta Range** — áudio vai direto à rede
- ✅ **Preços sempre do servidor** — frontend nunca define quanto cobrar

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
2. **Bumpe `CACHE_VERSION` no `sw.js`** (ex: `jm-v17` → `jm-v18`)
3. Commit + push
4. O SW novo será instalado na próxima visita de cada cliente

> ⚠️ Arquivos em `/js/admin/**` **não precisam** de bump (são network-first), mas o resto do site precisa.

### Atualizar dependências

1. Edite `package.json` (se necessário)
2. Rode `npm install` para regenerar `package-lock.json`
3. Commit **ambos** os arquivos juntos
4. Faça push

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
- **Upstash → Metrics**: contagem de rate limits disparados

---

## 🩺 Troubleshooting

### Login do admin retorna 429 sempre

**Causa**: rate limit com `{ failClosed: true }` e Upstash não configurado.

**Solução**: configure `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN` no Vercel → Settings → Environment Variables. Faça redeploy.

### Painel admin abre com dashboard vazio

**Sintoma**: você faz login, o painel abre, mas o conteúdo não carrega.

**Causa (histórica)**: a versão antiga do `auth.js` mostrava o dashboard antes de carregar o conteúdo.

**Solução**: confirme que `js/admin/auth.js` chama `window.__admin.bootContent()` depois de `showAdminDashboard()`. A versão atual já faz isso.

### Service Worker não atualiza

**Sintoma**: você alterou CSS/JS, fez deploy, mas o site continua com a versão antiga.

**Causa**: esqueceu de bumpar `CACHE_VERSION` no `sw.js`.

**Solução**:
1. Bumpe `CACHE_VERSION` (`jm-v17` → `jm-v18`)
2. Commit + push
3. No navegador: DevTools → Application → Service Workers → **Unregister**
4. Ctrl+Shift+R

### Service Worker nunca é instalado

**Causa**: o `index.html` não tem o `<script>` de registro do SW.

**Solução**: adicione o registro inline (ver seção PWA / Offline).

### Site não carrega offline

**Sintoma**: em modo offline, aparece erro de rede em vez de `offline.html`.

**Causas possíveis**:
- SW não registrado ou não instalado (primeira visita)
- `offline.html` não está em `CACHE_STATIC`
- URL acessada não está no cache e não é navegação

**Solução**: registre o SW, abra o site **uma vez online** para o SW instalar tudo. Depois teste offline.

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

### Login admin falha após rotação de secret

**Causa**: `ADMIN_SESSION_SECRET` mudou, todas as sessões HMAC existentes ficam inválidas.

**Solução**: faça login novamente. É o comportamento esperado.

### Áudio não toca offline

**Comportamento esperado**: o SW **não intercepta** Range requests, e os áudios das faixas ficam no Supabase Storage (cross-origin). Offline, o player não consegue baixar.

### `/api/stream` retorna `fullUrl: null` mesmo para premium

**Causas possíveis**:
- `tracks.full_path` vazio na faixa
- Arquivo não existe no bucket `audio-premium`
- `SUPABASE_SERVICE_ROLE_KEY` ausente

**Solução**: verifique `select full_path from tracks where album_id = 'X' and track_index = Y;` e confirme que o arquivo existe no bucket.

### Build da Vercel falha com "npm ci can only install..."

**Causa**: `package-lock.json` ausente ou dessincronizado com `package.json`.

**Solução**:

```bash
rm -rf node_modules package-lock.json
npm install
git add package.json package-lock.json
git commit -m "chore: sincroniza lockfile"
git push
```

Depois disso, o `npm ci` da Vercel vai funcionar corretamente. **Nunca** edite `package.json` sem rodar `npm install` em seguida e commitar o `package-lock.json` atualizado.

### Upload de áudio falha com "Falha ao preparar upload"

**Causas possíveis**:
- `kind` inválido (deve ser `image`, `audio-preview` ou `audio-full`)
- `contentType` não está na whitelist (`audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/ogg`)
- `size` maior que o limite (200 MB para áudio, 5 MB para imagem)
- `SUPABASE_SERVICE_ROLE_KEY` ausente

**Solução**: verifique a aba Network do DevTools e o log do Vercel.

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

**Última atualização**: 24 de setembro de 2026
