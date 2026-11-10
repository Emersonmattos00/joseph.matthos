'use strict';

const express = require('express');
const path = require('path');

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: '.env.local' });
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');

// Cabeçalhos básicos de segurança.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Limites de requisição.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({
  extended: true,
  limit: '100kb',
  parameterLimit: 1000
}));

// ─── Whitelist de caminhos públicos ─────────────────────────
function isPublicPath(urlPath) {
  const normalized = path.posix.normalize(
    '/' + String(urlPath).replace(/\\/g, '/').replace(/^\/+/, '')
  );

  if (
    normalized === '/' ||
    [
      '/index.html',
      '/player.html',
      '/offline.html',
      '/politica-privacidade.html',
      '/termos-uso.html',
      '/sw.js'
    ].includes(normalized)
  ) {
    return true;
  }

  return (
    normalized.startsWith('/assets/') ||
    normalized.startsWith('/css/') ||
    normalized.startsWith('/js/')
  );
}

// ─── Estáticos com whitelist ────────────────────────────────
const staticMiddleware = express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html',
  dotfiles: 'deny',
  fallthrough: true
});

app.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  if (!isPublicPath(req.path)) return next();
  return staticMiddleware(req, res, next);
});

// ─── APIs ──────────────────────────────────────────────────
const apiFiles = ['public', 'auth', 'stream', 'payments', 'admin'];

for (const name of apiFiles) {
  try {
    const handler = require(path.join(__dirname, 'api', `${name}.js`));

    if (typeof handler !== 'function') {
      throw new TypeError(`A API "${name}" não exporta uma função válida.`);
    }

    app.all(`/api/${name}`, async (req, res) => {
      try {
        await handler(req, res);
      } catch (error) {
        console.error(`[API ${name}] Erro não tratado:`, error);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
        } else if (!res.writableEnded) {
          res.destroy();
        }
      }
    });

    console.log(`API carregada: /api/${name}`);
  } catch (error) {
    console.error(`Falha ao carregar API "${name}":`, error);
    if (process.env.NODE_ENV === 'production') throw error;
  }
}

// ─── API inexistente ───────────────────────────────────────
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint não encontrado.' });
});

// ─── Fallback do site ──────────────────────────────────────
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (!isPublicPath(req.path) && req.path !== '/') {
    return res.status(404).send('Página não encontrada.');
  }
  res.sendFile(path.join(__dirname, 'index.html'), (error) => {
    if (error && !res.headersSent) next(error);
  });
});

// ─── Tratamento de erros do Express ────────────────────────
app.use((error, req, res, next) => {
  console.error('[SERVER] Erro:', error);
  if (res.headersSent) return next(error);
  res.status(error.status || 500).json({ ok: false, error: 'Erro interno do servidor.' });
});

// ─── Start ─────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});

// ─── Encerramento controlado (server + pool) ───────────────
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Recebido ${signal}. Encerrando servidor...`);

  // Timeout de segurança: força saída após 10s
  const forceExit = setTimeout(() => {
    console.error('[SERVER] Timeout de shutdown, forçando saída.');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // 1) Para de aceitar novas requisições
  await new Promise((resolve) => {
    server.close((error) => {
      if (error) {
        console.error('[SERVER] Erro ao encerrar servidor:', error);
        process.exitCode = 1;
      }
      resolve();
    });
  });

  // 2) Encerra pool do Neon (idempotente)
  try {
    const { closeDatabase } = require('./api/_db');
    await closeDatabase();
  } catch (err) {
    console.error('[SERVER] Erro ao encerrar pool:', err.message);
  }

  clearTimeout(forceExit);
  console.log('[SERVER] Encerrado.');
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));