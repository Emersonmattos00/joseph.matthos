# Joseph Matthos — Plataforma Oficial

Site oficial + painel administrativo + loja de faixas e assinaturas.

## Arquitetura

- **Frontend**: HTML + CSS + JavaScript (ES modules)
- **Backend**: Vercel Serverless Functions (Node.js)
- **Banco de dados**: Supabase (PostgreSQL)
- **Autenticação**: Supabase Auth (usuários) + HMAC (admin)
- **Pagamentos**: Mercado Pago (assinaturas + aluguéis)
- **Storage**: Supabase Storage (imagens + áudios)
- **Cache/Rate limit**: Upstash Redis (opcional)

## Estrutura

├── index.html # Página principal (site + admin)
├── css/
│ └── style.css
├── js/
│ ├── config.js # Conteúdo padrão do site
│ ├── utils.js # Helpers (formatação, validação)
│ ├── site.js # Site público
│ └── admin/ # Painel administrativo
│ ├── index.js # Entry point
│ ├── state.js # Estado compartilhado
│ ├── api.js # Wrapper de fetch
│ ├── auth.js # Login/logout/sessão
│ ├── content.js # Conteúdo (GET/PUT)
│ ├── uploads.js # Upload de imagens/áudios
│ ├── dashboard.js # Cards de estatísticas
│ ├── users.js # Gestão de usuários
│ ├── sales.js # Vendas e assinaturas
│ ├── backup.js # Info de backup
│ ├── ui/ # Componentes (dom, format, modal, toast)
│ └── editors/ # Editores (frases, álbuns, playlists, planos, redes)
├── api/
│ ├── _lib.js # Módulos internos (Supabase, audit, rate limit, plano)
│ ├── public.js # Endpoints públicos (content, tracks, plans)
│ ├── auth.js # Autenticação de usuários
│ ├── admin.js # Painel administrativo
│ └── payments.js # Mercado Pago (subscription, rental, webhook)
└── sw.js # Service Worker (opcional)


## Endpoints

### Público

| Método | Endpoint | Descrição |
|---|---|---|
| GET | `/api/public` | Conteúdo + faixas + planos |
| GET | `/api/public?resource=content` | Só conteúdo |
| GET | `/api/public?resource=tracks` | Só catálogo |
| GET | `/api/public?resource=plans` | Só planos |

### Auth (usuários)

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/api/auth?action=login` | Login |
| POST | `/api/auth?action=signup` | Cadastro |
| POST | `/api/auth?action=logout` | Logout |
| POST | `/api/auth?action=refresh` | Renova sessão |
| GET | `/api/auth?action=me` | Dados do usuário + aluguéis |

### Admin

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/api/admin?action=login` | Login admin |
| GET | `/api/admin?action=session` | Valida sessão |
| POST | `/api/admin?action=logout` | Encerra sessão |
| GET/PUT | `/api/admin?action=content` | Lê/salva conteúdo |
| POST | `/api/admin?action=upload` | Upload de arquivo |
| GET/PATCH | `/api/admin?action=users` | Lista/altera usuários |
| GET | `/api/admin?action=sales` | Assinaturas + aluguéis + eventos |

### Payments

| Método | Endpoint | Descrição |
|---|---|---|
| POST | `/api/payments?type=subscription` | Cria preapproval MP |
| POST | `/api/payments?type=rental` | Cria preference MP |
| POST | `/api/payments?type=webhook` | Webhook do MP |

## Variáveis de ambiente

Configurar no Vercel → Settings → Environment Variables:

| Variável | Descrição |
|---|---|
| `SUPABASE_URL` | URL do projeto Supabase |
| `SUPABASE_ANON_KEY` | Chave anon (pública) |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave service_role (server-only) |
| `ADMIN_USER` | Login do admin (ex: `admin`) |
| `ADMIN_PASSWORD_HASH` | Hash scrypt da senha do admin |
| `ADMIN_SESSION_SECRET` | Segredo HMAC da sessão (64 hex chars) |
| `ALLOWED_ORIGINS` | Origins confiáveis (CSRF) |
| `MP_ACCESS_TOKEN` | Token do Mercado Pago |
| `MP_PUBLIC_KEY` | Public key do MP |
| `MP_WEBHOOK_SECRET` | Secret do webhook MP |
| `MP_BACK_URL` | URL de retorno após checkout |
| `MP_WEBHOOK_URL` | URL do webhook |
| `MP_PREMIUM_MONTHLY_PRICE` | Preço mensal (ex: `19.90`) |
| `MP_PREMIUM_ANNUAL_PRICE` | Preço anual (ex: `179.00`) |
| `UPSTASH_REDIS_REST_URL` | URL do Upstash (opcional) |
| `UPSTASH_REDIS_REST_TOKEN` | Token do Upstash (opcional) |
| `SIGNUP_REDIRECT_URL` | URL de confirmação de e-mail |

## Banco de dados (Supabase)

Rodar o `schema.sql` no SQL Editor do Supabase. Ele cria:

- `profiles` — dados públicos do usuário
- `albums`, `tracks` — catálogo
- `subscriptions` — assinaturas ativas
- `rentals` — aluguéis de 48h
- `payments_attempts` — idempotência de checkout
- `payments_events` — idempotência de webhook
- `site_content` — conteúdo do site
- `site_content_history` — histórico
- `admin_audit`, `auth_audit_log` — auditoria
- `effective_plan` (view) — plano derivado

**Políticas RLS:** todas as tabelas usam RLS. O `service_role` precisa de policy explícita `for all to service_role using (true) with check (true)` para escrever.

## Geração de hash do admin

O hash é gerado com **scrypt** (N=16384, r=8, p=1).

**Opção A — via Node.js local:**

```bash
node -e "const c=require('crypto');const p='SUA_SENHA';const s=c.randomBytes(16);c.scrypt(p,s,64,{N:16384,r:8,p:1},(e,k)=>{if(e)throw e;console.log('scrypt$'+s.toString('hex')+'$'+k.toString('hex'));});"

Opção B — via navegador (WebCrypto):

Use o console do site em produção ou um script separado.

Deploy
Faça push para main.

Vercel detecta e faz deploy automático.

Configurar env vars antes do primeiro deploy de produção.

Rodar schema.sql no Supabase.

Criar bucket site-assets no Supabase Storage (público).

Acessar / e testar Ctrl+Shift+A.

Painel admin
URL: https://josephmatthos.vercel.app

Atalho: Ctrl + Shift + A

Login: ADMIN_USER + senha em claro

Desenvolvimento local
bash
# Instalar Vercel CLI
npm i -g vercel

# Rodar localmente (com env vars de .env.local)
vercel dev
Criar .env.local com as mesmas variáveis do Vercel.

Segurança
✅ Nenhum dado de negócio em localStorage/IndexedDB

✅ Cookies __Host- HttpOnly + SameSite=Lax (produção)

✅ Sessão admin com HMAC assinado (4h de validade)

✅ Senha admin com scrypt + salt de 16 bytes

✅ Rate limit por IP em login

✅ Auditoria em toda escrita

✅ RLS em todas as tabelas

✅ service_role só no servidor

✅ Content Security Policy configurada

✅ Sem exposição de chaves privadas no cliente

text

**Substitua o `README.md` inteiro por isso.**

---

## Ordem de correção recomendada

| # | Correção | Impacto | Prioridade |
|---|---|---|---|
| 1 | `api/payments.js` — imports | Alto (quebra pagamentos) | 🔴 Urgente |
| 2 | `js/site.js` — endpoints | Alto (quebra compra) | 🔴 Urgente |
| 3 | `api/admin.js` — remover `__gen_hash__` | Alto (segurança) | 🔴 Urgente |
| 4 | `admin.html` — deletar | Baixo (não usado) | 🟡 Médio |
| 5 | `sw.js` — ativar ou desativar | Baixo | 🟡 Médio |
| 6 | `README.md` — atualizar | Baixo (documentação) | 🟢 Baixo |

---

## Faça isto agora, nesta ordem

**1.** Corrija os imports do `api/payments.js` → commit.
**2.** Corrija os endpoints do `js/site.js` → commit.
**3.** Substitua o `api/admin.js` pela versão limpa (sem `__gen_hash__`) → commit.
**4.** Delete o `admin.html` → commit.
**5.** Aguarde o deploy (~1 min).
**6.** Teste:
   - Login admin funciona?
   - Salvar conteúdo funciona?
   - Lista de usuários carrega sem 502?

**Me diga o resultado de cada passo.** Depois passamos para os itens 5 (SW) e 6 (README).

**Se algum dos passos der erro**, me mande a mensagem exata que eu ajudo a corrigir.
