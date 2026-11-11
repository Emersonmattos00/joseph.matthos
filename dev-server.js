process.loadEnvFile('.env.local');
const express = require('express');
const path = require('path');

const STATIC_DIR = path.join(__dirname, 'public');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(req.method + ' ' + req.url);
  next();
});

// ─────────────────────────────────────────────────────────────
// ORDEM CRÍTICA: static ANTES das rotas de API e do SPA fallback
// ─────────────────────────────────────────────────────────────
app.use(express.static(STATIC_DIR, {
  extensions: ['html'],
  index: 'index.html',
  dotfiles: 'deny',
  setHeaders: (res, filePath) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
}));

// ─────────────────────────────────────────────────────────────
// ROTAS DA API
// ─────────────────────────────────────────────────────────────
const apiFiles = ['public', 'auth', 'stream', 'payments', 'admin'];

const handlers = {};
for (const name of apiFiles) {
  try {
    handlers[name] = require('./api/' + name + '.js');
    console.log('✅ Handler /api/' + name + ' carregado');
  } catch (err) {
    if (err.message.includes('require() cannot be used on an ESM graph')) {
      console.log('⚠️ Handler /api/' + name + ' é ESM, será carregado sob demanda');
    } else {
      console.warn('⚠️ Falha ao carregar /api/' + name + ':', err.message);
    }
  }
}

app.use('/api', async (req, res, next) => {
  const parts = req.path.split('/').filter(Boolean);
  const name = parts[0];
  if (!name) return next();

  const handler = handlers[name];
  if (!handler) {
    try {
      const module = await import('./api/' + name + '.js');
      const dynamicHandler = module.default || module;
      await dynamicHandler(req, res);
      return;
    } catch (e) {
      return res.status(404).json({ ok: false, error: 'Rota não encontrada: ' + name });
    }
  }

  try {
    await handler(req, res);
  } catch (err) {
    console.error('Erro em /api/' + name + ':', err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }
});

// ─────────────────────────────────────────────────────────────
// FALLBACK SPA (DEVE SER O ÚLTIMO)
// ─────────────────────────────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api/')) return next();
  if (path.basename(req.path).startsWith('.')) {
    return res.status(403).send('Acesso negado');
  }
  // Se não for um arquivo existente em public/, devolve index.html
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Dev server rodando em http://0.0.0.0:${PORT}`);
});