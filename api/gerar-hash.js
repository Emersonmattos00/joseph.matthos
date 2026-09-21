// api/gerar-hash.js — TEMPORÁRIO. DELETAR APÓS USAR.
'use strict';

const crypto = require('crypto');

module.exports = (req, res) => {
  const TOKEN = 'jm-troque-por-algo-unico-2026';

  if (req.query.token !== TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const password = String(req.query.password || '');
  if (!password || password.length < 12) {
    return res.status(400).json({ error: 'senha deve ter no minimo 12 caracteres' });
  }

  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);

  res.json({
    hash: 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex')
  });
};  temp: api gerar-hash
