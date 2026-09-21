// api/gerar-hash.js — TEMPORÁRIO. DELETAR APÓS USAR.
'use strict';

const crypto = require('crypto');

module.exports = (req, res) => {
  try {
    // ── Parse query string (sem depender de req.query)
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `https://${host}`);
    const token = url.searchParams.get('token') || '';
    const password = url.searchParams.get('password') || '';

    const TOKEN = 'jm-troque-por-algo-unico-2026';

    // ── Headers comuns
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');

    // ── Validações
    if (token !== TOKEN) {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'forbidden' }));
    }

    if (!password || password.length < 12) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({ error: 'senha deve ter no minimo 12 caracteres' })
      );
    }

    // ── Gera o hash
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        hash: 'scrypt$' + salt.toString('hex') + '$' + hash.toString('hex')
      })
    );
  } catch (err) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: 'internal_error',
        message: String(err && err.message || err)
      })
    );
  }
};fix: gerar-hash compatível com Vercel runtime
