 'use strict';

const express = require('express');
const path = require('path');

// ============================================================
// AMBIENTE
// ============================================================

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({
    path: path.join(__dirname, '.env.local')
  });
}

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'development';
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');

// ============================================================
// CABEÇALHOS DE SEGURANÇA
// ============================================================

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// ============================================================
// LOGS
// Não registrar query strings, cookies ou tokens.
// ============================================================

app.use((req, res, next) => {
  console.log(`[DEV] ${req.method} ${req.path}`);
  next();
});

// ============================================================
// BODY PARSER
// ============================================================

app.use(express.json({ limit: '10mb' }));

app.use(express.urlencoded({
  extended: true,
  limit: '100kb',
  parameterLimit: 1000
}));

// ============================================================
// ARQUIVOS PÚBLICOS
// ============================================================

const publicFiles = new Set([
  '/',
  '/index.html',
  '/player.html',
  '/offline.html',
  '/politica-privacidade.html',
  '/termos-uso.html',
  '/sw.js'
]);

function isPublicStaticPath(urlPath) {
  const normalized = path.posix.normalize(
    '/' + String(urlPath).replace(/\\/g, '/').replace(/^\/+/, '')
  );

  return (
    publicFiles.has(normalized) ||
    normalized.startsWith('/assets/') ||
    normalized.startsWith('/css/') ||
    normalized.startsWith('/js/')
  );
}

const staticMiddleware = express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html',
  dotfiles: 'deny',
  fallthrough: true,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
});

app.use((req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) {
    return next();
  }

  if (!isPublicStaticPath(req.path)) {
    return next();
  }

  return staticMiddleware(req, res, next);
});

// ============================================================
// ROTAS DA API
// ============================================================

const apiFiles = [
  'public',
  'auth',
  'stream',
  'payments',
  'admin'
];

for (const name of apiFiles) {
  const apiPath = path.join(__dirname, 'api', `${name}.js`);

  let handler;

  try {
    handler = require(apiPath);

    if (typeof handler !== 'function') {
      throw new TypeError(
        `A API "${name}" não exporta uma função válida.`
      );
    }
  } catch (error) {
    console.error(
      `[DEV] Falha ao carregar a API "${name}":`,
      error
    );

    // Não iniciar o ambiente com APIs essenciais ausentes.
    throw error;
  }

  app.all(`/api/${name}`, async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error(`[DEV API ${name}]`, error);

      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: 'Erro interno do servidor.'
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }
  });

  console.log(`[DEV] API carregada: /api/${name}`);
}

// ============================================================
// API INEXISTENTE
// ============================================================

app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Endpoint não encontrado.'
  });
});

// ============================================================
// FALLBACK DO SITE
// ============================================================

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return next();
  }

  if (
    req.path.startsWith('/assets/') ||
    req.path.startsWith('/css/') ||
    req.path.startsWith('/js/') ||
    req.path === '/sw.js'
  ) {
    return res.status(404).send('Arquivo não encontrado.');
  }

  if (
    req.path === '/' ||
    [
      '/index.html',
      '/player.html',
      '/offline.html',
      '/politica-privacidade.html',
      '/termos-uso.html'
    ].includes(req.path)
  ) {
    return res.sendFile(
      path.join(__dirname, 'index.html'),
      (error) => {
        if (error && !res.headersSent) {
          next(error);
        }
      }
    );
  }

  return res.status(404).send('Página não encontrada.');
});

// ============================================================
// TRATAMENTO FINAL DE ERROS
// ============================================================

app.use((error, req, res, next) => {
  console.error('[DEV SERVER]', error);

  if (res.headersSent) {
    return next(error);
  }

  res.status(error.status || 500).json({
    ok: false,
    error: 'Erro interno do servidor.'
  });
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('======================================');
  console.log(' JOSEPH MATTHOS — DESENVOLVIMENTO');
  console.log('================================
