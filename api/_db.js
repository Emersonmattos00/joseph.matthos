'use strict';

/* ============================================================
   api/_db.js — Conexão Neon PostgreSQL + Drizzle ORM
   ------------------------------------------------------------
   - Driver: neon-serverless (WebSocket) para transações reais
   - checkDatabase testa o pool (não o HTTP)
   - Listener de erro no pool
   - closeDatabase idempotente (SIGTERM + SIGINT)
   ============================================================ */

const { Pool, neonConfig, neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-serverless');
const ws = require('ws');

const {
  eq, and, or, asc, desc,
  sql: drizzleSql, inArray,
  gt, gte, lt, lte, ne,
  isNull, isNotNull, count
} = require('drizzle-orm');

const schema = require('../src/schema.js');

// WebSocket para Node.js
neonConfig.webSocketConstructor = ws;

// ─── Validação da configuração ───────────────────────────────
function getDatabaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value || typeof value !== 'string') {
    throw new Error('[DATABASE] DATABASE_URL não foi configurada.');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('[DATABASE] DATABASE_URL possui formato inválido.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('[DATABASE] Protocolo de conexão PostgreSQL inválido.');
  }
  if (!parsed.hostname) {
    throw new Error('[DATABASE] Host do PostgreSQL não informado.');
  }

  return value;
}

// ─── Inicialização ───────────────────────────────────────────
const databaseUrl = getDatabaseUrl();

const sqlNeon = neon(databaseUrl);
const pool = new Pool({ connectionString: databaseUrl });

pool.on('error', (error) => {
  console.error('[DATABASE] Erro no pool:', error.code || 'POOL_ERROR');
});

const db = drizzle({ client: pool, schema });

// ─── Diagnóstico ─────────────────────────────────────────────
async function checkDatabase() {
  try {
    const result = await pool.query('SELECT 1 AS connected');
    const connected = Number(result?.rows?.[0]?.connected) === 1;
    return { available: connected, connected };
  } catch (error) {
    console.error('[DATABASE] Falha na verificação:', error.code || 'DATABASE_ERROR');
    return { available: false, connected: false };
  }
}

// ─── Encerramento controlado (idempotente) ─────────────────
let closePromise = null;

function closeDatabase() {
  if (!closePromise) {
    closePromise = pool.end().catch((error) => {
      console.error('[DATABASE] Erro ao encerrar pool:', error.code || 'POOL_CLOSE_ERROR');
      throw error;
    });
  }
  return closePromise;
}

// ─── Exportações ─────────────────────────────────────────────
module.exports = {
  db,
  sql: sqlNeon,
  drizzleSql,
  schema,
  eq, and, or, asc, desc, inArray,
  gt, gte, lt, lte, ne,
  isNull, isNotNull, count,
  checkDatabase,
  closeDatabase
};