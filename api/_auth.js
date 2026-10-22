'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { users } = require('../src/schema.js');
const { eq } = require('drizzle-orm');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const JWT_EXPIRES = '7d';

// ─────────────────────────────────────────────────────────────
// Hash de senha com scrypt (nativo do Node)
// ─────────────────────────────────────────────────────────────
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16).toString('hex');
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

function verifyPassword(password, storedHash) {
  return new Promise((resolve) => {
    try {
      const [algo, salt, hash] = String(storedHash).split('$');
      if (algo !== 'scrypt') return resolve(false);
      const expected = Buffer.from(hash, 'hex');
      crypto.scrypt(password, salt, expected.length, (err, derived) => {
        if (err) return resolve(false);
        resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
      });
    } catch {
      resolve(false);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// JWT
// ─────────────────────────────────────────────────────────────
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES,
  });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Helpers de usuário
// ─────────────────────────────────────────────────────────────
async function getUserByEmail(email) {
  const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return user || null;
}

async function createUser({ name, email, password }) {
  const hashed = await hashPassword(password);
  const [user] = await db.insert(users).values({
    name,
    email: email.toLowerCase(),
    passwordHash: hashed,
    role: 'CUSTOMER',
  }).returning();
  return user;
}

module.exports = {
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  getUserByEmail,
  createUser,
};