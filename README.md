# 🎤 Joseph Matthos — Plataforma Oficial

Plataforma completa de artista: site público com player de áudio, discografia,
planos de assinatura (simulados), área do usuário e **painel administrativo**
com CMS embutido — todo o conteúdo é editável e salvo no navegador.

> ⚠️ **Projeto de demonstração.** Autenticação, pagamentos e armazenamento usam
> `localStorage` + `IndexedDB`. Para produção real: backend + banco de dados +
> gateway de pagamento (Stripe / Mercado Pago / Pagar.me).

> **Estado atual:** o login do painel administrativo já valida a senha no
> backend Vercel com bcrypt. Cadastro/login de usuários, assinaturas, compras e
> uploads de áudio ainda precisam de banco, gateway e storage externos antes de
> serem habilitados em produção.

---

## ✨ Funcionalidades

### 🎧 Site público
- **Player de áudio** com prévias de 30s configuráveis por faixa
- **Discografia completa** (álbuns, EPs, singles) com filtros por tipo
- **3 planos de assinatura**: Free, Premium mensal, Premium anual
- **Download de faixas** liberado para assinantes Premium
- **Sistema de login/cadastro** de usuários
- **Design responsivo** (mobile, tablet, desktop)
- **Acessibilidade**: foco visível, ARIA, `prefers-reduced-motion`

### 🎛 Painel administrativo (`Ctrl + Shift + A`)
- **Dashboard** com estatísticas em tempo real
- **CMS completo** — edite todas as seções sem tocar em código
- **Personalização visual**: cores, fontes, imagens de fundo
- **Upload de áudios** (IndexedDB) ou URLs externas
- **Gestão de usuários**: mudar plano, banir, excluir
- **Backup/restauração** em JSON
- **Login de admin separado** (primeiro acesso demo: `admin` / `admin123`)

---

## 🚀 Rodar localmente

```bash
# Opção 1 — abrir direto no navegador
open index.html          # macOS
start index.html         # Windows
xdg-open index.html      # Linux

# Opção 2 — servidor local (recomendado, evita restrições de file://)
npx serve .              # Node.js
python3 -m http.server 8000   # Python 3
php -S localhost:8000    # PHP
```

Depois acesse **http://localhost:8000** (ou a porta indicada).

> **Por que usar servidor local?** Abrir `index.html` diretamente pode
> bloquear `fetch` e `IndexedDB` em alguns navegadores por causa da política
> de same-origin em `file://`. O servidor resolve isso.

---

## 🌐 Deploy no Vercel

```bash
# 1. Instalar a CLI (uma vez)
npm i -g vercel

# 2. Deploy de preview
vercel

# 3. Deploy em produção
vercel --prod
```

O `vercel.json` já configura:
- Headers de segurança (HSTS, CSP, X-Frame-Options, Permissions-Policy)
- Cache otimizado para `/assets/`, `/css/` e `/js/`

### Configurar autenticação do admin no Vercel

Em produção, o login usa a função `/api/admin-login` e não lê credenciais do
navegador. Configure estas variáveis no projeto Vercel:

```bash
vercel env add ADMIN_USER production
vercel env add ADMIN_PASSWORD_HASH production
vercel env add ADMIN_SESSION_SECRET production
vercel env add SUPABASE_URL production
vercel env add SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add MP_ACCESS_TOKEN production
vercel env add MP_BACK_URL production
vercel env add MP_PREMIUM_MONTHLY_PRICE production
vercel env add MP_PREMIUM_ANNUAL_PRICE production
```

Gere o hash bcrypt localmente antes de cadastrar a senha:

```bash
node -e "require('bcryptjs').hash('uma-senha-forte', 12).then(console.log)"
```

Gere `ADMIN_SESSION_SECRET` com:

```bash
openssl rand -hex 32
```

O modo demo continua disponível em `localhost`, usando `admin` / `admin123`.
No primeiro acesso do modo demo, a troca da senha é obrigatória. O link
`Esqueci minha senha` restaura as credenciais demo para `admin` / `admin123`.
Em produção, a redefinição deve ser feita atualizando `ADMIN_PASSWORD_HASH` no
Vercel; não existe senha universal de recuperação no ambiente publicado.

Para a autenticação pública, crie um projeto Supabase, configure o envio de
e-mail de confirmação conforme a política do produto e cadastre `SUPABASE_URL`
e `SUPABASE_ANON_KEY` no Vercel. As chaves ficam no backend; não use a
`service_role` no navegador.

Execute `supabase/schema.sql` no SQL Editor do Supabase. Depois configure as
notificações de assinatura do Mercado Pago para apontar para
`https://seu-dominio.com/api/payments-webhook`. O site usa checkout hospedado;
nenhum número de cartão é recebido pelo frontend.

### Próxima arquitetura de produção

Para transformar o protótipo em plataforma multiusuário, a recomendação é
usar Supabase (Auth + PostgreSQL + Storage) ou serviços equivalentes:

| Recurso | Implementação necessária |
|---------|--------------------------|
| Cadastro e login | API de autenticação com sessão em cookie `HttpOnly` |
| Usuários e planos | Banco de dados; nunca `localStorage` |
| Assinaturas e compras | Stripe, Mercado Pago ou Pagar.me com webhooks |
| Áudios | Storage privado com URLs assinadas e expiração |
| CMS admin | API autorizada por função/role, com auditoria |

Enquanto essas integrações não forem configuradas, o site bloqueia pagamentos
simulados em domínios publicados e mantém esses recursos apenas no modo demo
local.

---

## 🗂 Estrutura de arquivos

```
.
├── index.html              # HTML principal (site + painel admin)
├── css/
│   └── style.css           # Todos os estilos
├── js/
│   ├── utils.js            # Funções utilitárias (esc, hashStr, toast…)
│   ├── audioDB.js          # IndexedDB para áudios enviados pelo admin
│   ├── config.js           # Conteúdo padrão do site (DEFAULT_CONTENT)
│   ├── store.js            # Persistência (localStorage)
│   ├── site.js             # Site público + player + prévias
│   └── admin.js            # Painel administrativo
├── api/
│   ├── admin-login.js      # Login bcrypt no Vercel
│   ├── admin-session.js    # Verificação de sessão
│   └── admin-logout.js     # Encerramento de sessão
├── assets/
│   └── img/
│       ├── LEIA-ME.md      # Instruções das imagens
│       ├── joseph-sobre.jpg
│       ├── hero-bg.jpg
│       ├── boom-boom-bap-clean.jpg
│       └── album-boom-boom-bap.jpg
├── .gitignore
├── README.md
├── package.json
├── package-lock.json
└── vercel.json
```

---

## 🎛 Como personalizar

### ✅ Pelo painel admin (recomendado)

1. Abra o site
2. Pressione **Ctrl + Shift + A**
3. No primeiro acesso demo, use `admin` / `admin123` e troque a senha.
4. Edite qualquer seção (Geral, Hero, Sobre, Discografia…)
5. Clique em **💾 Salvar alterações**

As alterações ficam no `localStorage` do navegador — **não** afetam outros
visitantes nem outros dispositivos. Para publicar para todos, edite os
arquivos e faça commit.

### ✏️ Editando arquivos

| O que mudar | Onde |
|-------------|------|
| Conteúdo padrão (textos, faixas, planos) | `js/config.js` |
| Estilos e cores | `css/style.css` |
| Imagens | `assets/img/` (ver `LEIA-ME.md`) |
| SEO (título, descrição, og:image) | `index.html` no `<head>` |

---

## 🎵 Formato de uma faixa

Cada faixa aceita:

```js
{
  title: "Nome da Faixa",
  duration: "4:32",              // exibido na lista

  fullAudio: "assets/audio/faixa.mp3",  // OU "idb://<id>" (upload) OU URL externa
  previewAudio: "",               // opcional — se vazio, corta o fullAudio

  previewStart: 30,               // segundo onde a prévia começa
  previewDuration: 30             // duração do corte em segundos
}
```

**Lógica de reprodução:**

| Usuário | O que toca |
|---------|------------|
| **Free** | `previewAudio` (cortado em `previewDuration`) OU `fullAudio` cortado de `previewStart` por `previewDuration` |
| **Premium** | `fullAudio` completo, do início ao fim |

---

## 🔐 Segurança

> ⚠️ **Este projeto é uma demonstração.** O armazenamento em `localStorage`
> é editável por qualquer pessoa com acesso ao DevTools.

### O que **não** é seguro para produção

- ❌ Senhas com hash simples no navegador
- ❌ Sessão armazenada em `localStorage` (vulnerável a XSS)
- ❌ Pagamentos simulados (sem gateway real)
- ❌ URLs de áudio completos acessíveis publicamente

### Como migrar para produção real

| Camada | Solução recomendada |
|--------|---------------------|
| **Backend** | Supabase, Firebase, Node.js + PostgreSQL, Laravel |
| **Autenticação** | Supabase Auth, Firebase Auth, Clerk, Auth0 |
| **Pagamentos** | Stripe, Mercado Pago, Pagar.me |
| **Storage de áudio** | Supabase Storage, S3, Cloudinary |
| **Proteção de áudio** | URLs assinadas com expiração (signed URLs) |

---

## 📱 Atalhos de teclado

| Tecla | Ação |
|-------|------|
| `Espaço` | Play / Pause |
| `←` / `→` | Retroceder / Avançar 5s |
| `Esc` | Fechar modais |
| `Ctrl + Shift + A` | Abrir painel admin |

---

## 📄 Licença

© 2026 Joseph Matthos. Todos os direitos reservados.

---

## 🤝 Suporte

Projeto privado. Para sugestões ou reportar problemas, entre em contato
pelas redes sociais oficiais.
