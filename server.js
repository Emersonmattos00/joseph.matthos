'use strict';

const path = require('path');
const express = require('express');

const ROOT_DIR = __dirname;
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';

const PORT = Number(process.env.PORT) || 3000;

const app = express();

// ------------------------------------------------------------
// CONFIGURAÇÕES BÁSICAS
// ------------------------------------------------------------

app.disable('x-powered-by');
app.set('env', NODE_ENV);
app.set('query parser', 'simple');

// ------------------------------------------------------------
// VARIÁVEIS DE AMBIENTE
// ------------------------------------------------------------

if (!IS_PRODUCTION) {
  try {
    require('dotenv').config({
      path: path.join(ROOT_DIR, '.env.local'),
    });
  } catch {
    console.warn(
      '[ENV] dotenv não disponível. Utilizando variáveis existentes.'
    );
  }
}

// ------------------------------------------------------------
// CABEÇALHOS DE SEGURANÇA
// ------------------------------------------------------------

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );

  if (IS_PRODUCTION) {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains'
    );
  }

  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }

  next();
});

// ------------------------------------------------------------
// GUARD: bloqueia arquivos sensíveis (executa ANTES de qualquer static)
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// BODY PARSER
// ------------------------------------------------------------

app.use(express.json({
  limit: '1mb',
  strict: true,
}));

app.use(express.urlencoded({
  extended: false,
  limit: '100kb',
  parameterLimit: 100,
}));

// ------------------------------------------------------------
// ARQUIVOS ESTÁTICOS PERMITIDOS (lista branca)
// ------------------------------------------------------------

const staticDirectories = [
  'assets',
  'css',
  'js',
];

for (const directory of staticDirectories) {
  app.use(
    `/${directory}`,
    express.static(path.join(ROOT_DIR, directory), {
      dotfiles: 'deny',
      index: false,
      fallthrough: true,
      redirect: false,
      maxAge: IS_PRODUCTION ? '1h' : 0,
    })
  );
}

// ------------------------------------------------------------
// PÁGINAS HTML AUTORIZADAS
// ------------------------------------------------------------

const publicPages = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/player.html', 'player.html'],
  ['/offline.html', 'offline.html'],
  ['/termos-uso.html', 'termos-uso.html'],
  ['/politica-privacidade.html', 'politica-privacidade.html'],
]);

for (const [route, filename] of publicPages) {
  app.get(route, (req, res) => {
    res.sendFile(path.join(ROOT_DIR, filename));
  });
}

app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'sw.js'), {
    headers: {
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/',
    },
  });
});

// ------------------------------------------------------------
// CARREGAMENTO DAS APIs
// ------------------------------------------------------------

const apiFiles = [
  'public',
  'auth',
  'stream',
  'payments',
  'admin',
];

for (const name of apiFiles) {
  const modulePath = path.join(ROOT_DIR, 'api', `${name}.js`);

  let handler;

  try {
    handler = require(modulePath);

    if (typeof handler !== 'function') {
      throw new TypeError(
        `O módulo api/${name}.js não exporta uma função.`
      );
    }
  } catch (error) {
    console.error(
      `[API] Falha ao carregar api/${name}.js:`,
      error
    );
    throw error;
  }

  app.all(`/api/${name}`, async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      console.error(
        `[API] Erro inesperado em /api/${name}:`,
        error
      );

      if (res.headersSent) {
        return next(error);
      }

      return res.status(500).json({
        ok: false,
        error: 'Erro interno do servidor.',
      });
    }
  });

  console.log(`[API] /api/${name} carregada`);
}

// ------------------------------------------------------------
// API NÃO ENCONTRADA
// ------------------------------------------------------------

app.use('/api', (req, res) => {
  return res.status(404).json({
    ok: false,
    error: 'Endpoint não encontrado.',
  });
});

// ------------------------------------------------------------
// FALLBACK SPA
// ------------------------------------------------------------

app.get('*', (req, res, next) => {
  if (path.extname(req.path)) {
    return next();
  }

  return res.sendFile(
    path.join(ROOT_DIR, 'index.html')
  );
});

// ------------------------------------------------------------
// TRATAMENTO DE ERROS DO EXPRESS
// ------------------------------------------------------------

app.use((err, req, res, next) => {
  console.error('[SERVER] Erro Express:', err);

  if (res.headersSent) {
    return next(err);
  }

  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      error: 'Corpo da requisição muito grande.',
    });
  }

  if (err instanceof SyntaxError && err.status === 400) {
    return res.status(400).json({
      ok: false,
      error: 'JSON inválido.',
    });
  }

  return res.status(500).json({
    ok: false,
    error: 'Erro interno do servidor.',
  });
});

// ------------------------------------------------------------
// INICIALIZAÇÃO
// ------------------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SERVER] Joseph Matthos iniciado em 0.0.0.0:${PORT}`);
  console.log(`[SERVER] Ambiente: ${NODE_ENV}`);
});

// ------------------------------------------------------------
// ENCERRAMENTO CONTROLADO
// ------------------------------------------------------------

function shutdown(signal) {
  console.log(`[SERVER] Recebido ${signal}. Encerrando...`);

  server.close((error) => {
    if (error) {
      console.error('[SERVER] Erro ao encerrar:', error);
      process.exitCode = 1;
      return;
    }

    console.log('[SERVER] Servidor encerrado.');
  });

  setTimeout(() => {
    console.error('[SERVER] Encerramento forçado.');
    process.exit(1);
  }, 10000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));