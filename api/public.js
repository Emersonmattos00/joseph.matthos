'use strict';

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const query = req.query || {};
  const action = String(query.action || '').trim();

  // 🔍 TEMPORÁRIO — gera hash pelo servidor
  if (action === '__gen_hash__') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const password = String(body.password || '');
    if (!password) {
      res.status(400);
      return res.end(JSON.stringify({ ok: false, error: 'password obrigatório' }));
    }
    const salt = crypto.randomBytes(16);
    return new Promise(function(resolve) {
      crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, function(err, derived) {
        if (err) {
          res.status(500);
          return resolve(res.end(JSON.stringify({ ok: false, error: err.message })));
        }
        res.status(200);
        resolve(res.end(JSON.stringify({
          ok: true,
          hash: 'scrypt$' + salt.toString('hex') + '$' + derived.toString('hex'),
          password: password
        })));
      });
    });
  }

  // 🔍 TEMPORÁRIO — testa se um hash confere
  if (action === '__verify_hash__') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const password = String(body.password || '');
    const hash = String(body.hash || '');
    if (!password || !hash) {
      res.status(400);
      return res.end(JSON.stringify({ ok: false, error: 'password e hash obrigatórios' }));
    }
    const parts = hash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      res.status(400);
      return res.end(JSON.stringify({ ok: false, error: 'hash malformado', parts: parts.length }));
    }
    return new Promise(function(resolve) {
      const salt = Buffer.from(parts[1], 'hex');
      const expected = Buffer.from(parts[2], 'hex');
      crypto.scrypt(password, salt, expected.length, { N: 16384, r: 8, p: 1 }, function(err, derived) {
        if (err) {
          res.status(500);
          return resolve(res.end(JSON.stringify({ ok: false, error: err.message })));
        }
        const match = derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
        res.status(200);
        resolve(res.end(JSON.stringify({
          ok: true,
          matches: match,
          passwordLength: password.length,
          hashLength: hash.length,
          saltHexLength: parts[1].length,
          derivedHexLength: parts[2].length
        })));
      });
    });
  }

  // Comportamento normal (resumido)
  res.status(200);
  return res.end(JSON.stringify({ ok: true, message: 'public endpoint' }));
};
