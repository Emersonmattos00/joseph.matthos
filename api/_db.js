'use strict';

/* ============================================================
   api/_db.js — Conexão Neon PostgreSQL + Drizzle ORM
   ------------------------------------------------------------
   - Driver: neon-serverless (WebSocket) para transações reais
   - Pool + WebSocket configurado para Node.js
   - Exporta `sql` (Neon HTTP) e `drizzleSql` (Drizzle)
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

// ─── WebSocket para Node.js ─────────────────────────────────
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

// Cliente HTTP para consultas simples (signup usa sql`...`)
const sqlNeon = neon(databaseUrl);

// Pool WebSocket para transações reais
const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle({ client: pool, schema });

// ─── Diagnóstico ─────────────────────────────────────────────
async function checkDatabase() {
  try {
    const result = await sqlNeon`SELECT 1 AS connected`;
    return {
      available: true,
      connected: result?.[0]?.connected === 1 || result?.[0]?.connected === '1'
    };
  } catch (error) {
    console.error('[DATABASE] Falha na verificação:', error.code || error.message);
    return { available: false, connected: false };
  }
}

// ─── Exportações ─────────────────────────────────────────────
module.exports = {
  db,        // ← AGORA com transações reais
  sql: sqlNeon, // ← HTTP para queries simples
  drizzleSql,
  schema,
  eq, and, or, asc, desc, inArray,
  gt, gte, lt, lte, ne,
  isNull, isNotNull, count,
  checkDatabase
};