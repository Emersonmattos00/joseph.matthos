const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Necessário para ler dados de formulários (POST)
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

// Rota de login do painel admin
app.post('/api/admin', (req, res) => {
  const { usuario, senha } = req.body;

  // ⚠️ SUBSTITUA por validação segura (bcrypt + variáveis de ambiente)
  if (usuario === 'admin' && senha === 'MinhaSenhaJoseph2026') {
    // Se o admin.html existir, redireciona para ele
    const adminPath = path.join(staticDir, 'admin.html');
    if (fs.existsSync(adminPath)) {
      return res.redirect('/admin.html');
    }
    return res.send('Login OK, mas admin.html não foi encontrado.');
  }

  res.status(401).send('Credenciais inválidas');
});

// Arquivos estáticos (CSS, JS, imagens, etc.)
app.use(express.static(staticDir));

// Fallback para SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});
