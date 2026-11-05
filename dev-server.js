'use strict';

// ============================================================
// dev-server.js — Servidor de desenvolvimento seguro
// ============================================================

const path = require('node:path');

require('dotenv').config({
  path: path.join(__dirname, '.env.local'),
});

const express = require('express');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');
app.set('trust proxy', false);

// ============================================================
// GUARD: bloqueia arquivos sensíveis (executa ANTES de qualquer static)
// ============================================================

const BLOCKED_PREFIXES = [
  '/.env',
  '/.git',
  '/.vercel',
  '/.next',
  '/.husky',
  '/node_modules',
  '/drizzle',
  '/src',
  '/scripts',
  '/tests',
];

const BLOCKED_EXACT = new Set([
  '/package.json',
  '/package-lock.json',
  '/server.js',
  '/dev-server.js',
  '/drizzle.config.js',
  '/drizzle.config.mjs',
  '/tsconfig.json',
  '/README.md',
]);

app.use((req, res, next) => {
  const p = req.path;

  if (
    BLOCKED_PREFIXES.some(prefix => p.startsWith(prefix)) ||
    BLOCKED_EXACT.has(p)
  ) {
    return res.status(404).type('text/plain').send('Not found');
  }

  next();
});

// ============================================================
// HEADERS + LOG
// ============================================================

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);

  next();
});

// ============================================================
// PARSERS
// ============================================================

app.use(express.json({
  limit: '1mb',
  strict: true,
}));

app.use(express.urlencoded({
  extended: false,
  limit: '100kb',
}));

// ============================================================
// ESTÁTICOS PERMITIDOS (lista branca — nada de __dirname)
// ============================================================

const publicDirectories = ['assets', 'css', 'js'];

for (const directory of publicDirectories) {
  app.use(
    `/${directory}`,
    express.static(path.join(__dirname, directory), {
      dotfiles: 'deny',
      index: false,
      fallthrough: true,
      maxAge: 0,
    })
  );
}

// ============================================================
// PÁGINAS HTML AUTORIZADAS
// ============================================================

const allowedPages = new Set([
  'index.html',
  'player.html',
  'offline.html',
  'termos-uso.html',
  'politica-privacidade.html',
]);

app.get(
  ['/', ...Array.from(allowedPages).map(page => `/${page}`)],
  (req, res, next) => {
    const page = req.path === '/'
      ? 'index.html'
      : path.basename(req.path);

    if (!allowedPages.has(page)) {
      return res.sendStatus(404);
    }

    res.sendFile(path.join(__dirname, page), err => {
      if (err) next(err);
    });
  }
);

// ============================================================
// SERVICE WORKER
// ============================================================

app.get('/sw.js', (req, res, next) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache');

  res.sendFile(path.join(__dirname, 'sw.js'), err => {
    if (err) next(err);
  });
});

// ============================================================
// APIs
// ============================================================

const apiFiles = ['public', 'auth', 'stream', 'payments', 'admin'];

for (const name of apiFiles) {
  const handlerPath = path.join(__dirname, 'api', `${name}.js`);

  let handler;

  try {
    handler = require(handlerPath);
  } catch (err) {
    console.error(`Falha ao carregar API: ${name}`, err);
    throw err;
  }

  if (typeof handler !== 'function') {
    throw new TypeError(
      `A API "${name}" não exporta uma função handler válida.`
    );
  }

  app.all(`/api/${name}`, async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`Erro em /api/${name}:`, err);
      if (res.headersSent) return next(err);
      res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
    }
  });

  console.log(`API carregada: /api/${name}`);
}

// ============================================================
// API 404
// ============================================================

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'Endpoint não encontrado.' });
});

// ============================================================
// FALLBACK SPA
// ============================================================

app.get('*', (req, res, next) => {
  if (path.extname(req.path)) return next();

  res.sendFile(path.join(__dirname, 'index.html'), err => {
    if (err) next(err);
  });
});

// ============================================================
// ERROS
// ============================================================

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'Requisição muito grande.' });
  }

  if (
    err.type === 'entity.parse.failed' ||
    (err instanceof SyntaxError && err.status === 400)
  ) {
    return res.status(400).json({ ok: false, error: 'JSON inválido.' });
  }

  console.error('Erro não tratado:', err);
  res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor de desenvolvimento ativo em http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`Recebido ${signal}. Encerrando servidor...`);

  server.close(err => {
    if (err) {
      console.error('Erro ao encerrar servidor:', err);
      process.exitCode = 1;
    }
    process.exit();
  });

  setTimeout(() => {
    console.error('Tempo limite de encerramento excedido.');
    process.exit(1);
  }, 10000).unref();
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));