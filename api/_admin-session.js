const crypto = require('crypto');

const COOKIE_NAME = '__Host-jm_admin_session';
const MAX_AGE = 8 * 60 * 60;
const MIN_SECRET_LENGTH = 32;

function getSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error('ADMIN_SESSION_SECRET ausente ou muito curto');
  }
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function createToken() {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + MAX_AGE,
    nonce: crypto.randomBytes(16).toString('hex')
  })).toString('base64url');
  return payload + '.' + sign(payload);
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, item) => {
    const separator = item.indexOf('=');
    if (separator < 0) return cookies;
    const key = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (key) {
      try { cookies[key] = decodeURIComponent(value); } catch (error) { cookies[key] = ''; }
    }
    return cookies;
  }, {});
}

function isValidToken(token) {
  let secret;
  try { secret = getSecret(); } catch { return false; }
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const expected = sign(parts[0]);
  const provided = parts[1];
  if (!expected || !provided) return false;
  if (expected.length !== provided.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch (error) {
    return false;
  }
}

function hasValidSession(req) {
  const cookies = parseCookies(req.headers && (req.headers.cookie || req.headers.Cookie));
  return isValidToken(cookies[COOKIE_NAME]);
}

function sessionCookie(token, maxAge) {
  return COOKIE_NAME + '=' + encodeURIComponent(token || '') + '; Max-Age=' + maxAge + '; Path=/; HttpOnly; Secure; SameSite=Strict';
}

function setSessionCookie(res) {
  res.setHeader('Set-Cookie', sessionCookie(createToken(), MAX_AGE));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', sessionCookie('', 0));
}

module.exports = {
  hasValidSession,
  setSessionCookie,
  clearSessionCookie
};
