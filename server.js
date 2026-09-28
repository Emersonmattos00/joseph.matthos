const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Detecta automaticamente onde está o index.html
const possibleDirs = [__dirname, 'public', 'dist', 'src', 'www', 'site', 'build'];
let staticDir = __dirname;

for (const dir of possibleDirs) {
  const fullPath = path.join(__dirname, dir);
  if (fs.existsSync(path.join(fullPath, 'index.html'))) {
    staticDir = fullPath;
    console.log(`Servindo arquivos de: ${staticDir}`);
    break;
  }
}

app.use(express.static(staticDir));

// Fallback para SPA (redireciona qualquer rota não encontrada para o index.html)
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});
