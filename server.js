'use strict';

require('dotenv').config({ path: '.env.local' });

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares básicos
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Servir arquivos estáticos (frontend)
app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
  dotfiles: 'deny',
}));

// Rotas de API (serverless functions)
const apiFiles = ['public', 'auth', 'stream', 'payments', 'admin'];

for (const name of apiFiles) {
  try {
    const handler = require('./api/' + name + '.js');
    app.all('/api/' + name, async (req, res) => {
      try {
        await handler(req, res);
      } catch (err) {
        console.error(`Erro em /api/${name}:`, err);
        if (!res.headersSent) {
          res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
        }
      }
    });
    console.log(`✅ Rota /api/${name} carregada`);
  } catch (err) {
    console.warn(`⚠️  Falha ao carregar /api/${name}:`, err.message);
  }
}

// Fallback SPA: qualquer rota não-API serve o index.html
app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor rodando em http://0.0.0.0:${PORT}`);
});