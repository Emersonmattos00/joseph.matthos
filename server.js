const express = require('express');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// Middlewares
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Cliente Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

// Rota de login do painel admin via Supabase
app.post('/api/admin', async (req, res) => {
  console.log('Body recebido:', req.body);

  const { email, senha } = req.body;

  if (!email || !senha) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios' });
  }

  // Autentica no Supabase
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email,
    password: senha
  });

  if (error) {
    console.log('Erro Supabase:', error.message);
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  console.log('Usuário autenticado:', data.user.email);
  return res.json({ ok: true, user: { email: data.user.email, id: data.user.id } });
});

// Arquivos estáticos
app.use(express.static(staticDir));

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${port}`);
});
