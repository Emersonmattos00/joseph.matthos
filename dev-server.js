require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(req.method + ' ' + req.url);
  next();
});

app.use(express.static(path.join(__dirname), {
  extensions: ['html'],
  index: 'index.html',
}));

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

app.get('*', (req, res, next) => {
  if (req.url.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log('\n🚀 Dev server rodando em http://localhost:' + PORT + '\n');
});
