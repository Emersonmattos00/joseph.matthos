'use strict';
require('dotenv').config();
const crypto = require('crypto');

const secret = process.env.ADMIN_SESSION_SECRET;
const user   = process.env.ADMIN_USER;
const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';

if (!secret || !user) {
  console.error('Faltam ADMIN_SESSION_SECRET ou ADMIN_USER no .env');
  console.error('  ADMIN_USER:', user || '(vazio)');
  console.error('  ADMIN_SESSION_SECRET:', secret ? '(ok)' : '(vazio)');
  process.exit(1);
}

// Mesmo nome de cookie que api/admin.js usa:
const COOKIE_NAME = isProd ? '__Host-jm_admin' : 'jm_admin';

const payload = { user, iat: Date.now() };
const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
const sig  = crypto.createHmac('sha256', secret).update(body).digest('base64url');
const token = `${body}.${sig}`;

const attrs = [
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${60 * 60 * 4}`,
  isProd ? 'Secure' : null
].filter(Boolean).join('; ');

console.log('');
console.log(`Cookie (${isProd ? 'prod' : 'dev'}):`);
console.log(`${COOKIE_NAME}=${token}; ${attrs}`);
console.log('');
console.log('Para colar no DevTools > Application > Cookies:');
console.log(`   Name:  ${COOKIE_NAME}`);
console.log(`   Value: ${token}`);
console.log('');
console.log('Teste via curl:');
console.log(`   curl -b "${COOKIE_NAME}=${token}" "http://localhost:3000/api/admin?action=session"`);
