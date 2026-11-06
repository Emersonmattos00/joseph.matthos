'use strict';

// Carrega .env.local APENAS se não estivermos em produção.
// Na Vercel/Render, as variáveis são injetadas automaticamente.
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: '.env.local' });
}

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
        console.error(`Erro fatal em /api/${name}:`, err);
        if (!res.headersSent) {
          // Não expõe err.message para o cliente em produção
          res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
        }
      }
    });
    console.log(`✅ Rota /api/${name} carregada`);
  } catch (err) {
    console.error(`❌ FALHA CRÍTICA ao carregar /api/${name}:`, err.message);
    // Em produção, impede o servidor de iniciar "capenga"
    if (process.env.NODE_ENV === 'production') {
      process.exit(1);
    } else {
      console.warn(`⚠️  Aviso: /api/${name} falhou em ambiente de desenvolvimento.`);
    }
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