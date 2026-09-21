'use strict';

module.exports = (req, res) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end('{"ok":true,"msg":"vivo"}');
};
