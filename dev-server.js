// dotenv removido — usando --env-file nativo
const express = require('express');
const path = require('path');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(req.method + ' ' + req.url);
  next();
});

// ─────────────────────────────────────────────────────────────
// SERVIDOR ESTÁTICO SEGURO
// ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
  // Impede que arquivos ocultos (como .env, .git) sejam servidos
  dotfiles: 'deny',
  // Bloqueia a listagem de diretórios
  setHeaders: (res, filePath) => {
    // Adiciona cabeçalhos de segurança básicos para dev
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// Rota explícita para o Service Worker (precisa ser servido da raiz)
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// ─────────────────────────────────────────────────────────────
// ROTAS DA API
// ─────────────────────────────────────────────────────────────
const apiFiles = ['public', 'auth', 'stream', 'payments', 'admin'];

for (const name of apiFiles) {
  try {
    const handler = require('./api/' + name + '.js');
    app.all('/api/' + name, async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        console.error('Erro em /api/' + name + ':', err);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: err.message });
        }
      }
    });
    console.log('✅ Rota /api/' + name + ' carregada');
  } catch (err) {
    console.warn('⚠️  Falha ao carregar /api/' + name + ':', err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// FALLBACK (SPA)
// ─────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api/')) return next();
  // Não serve arquivos que começam com ponto (ex: .env)
  if (path.basename(req.path).startsWith('.')) {
    return res.status(403).send('Acesso negado');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Dev server rodando em http://localhost:${PORT}`);
});