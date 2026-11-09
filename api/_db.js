'use strict';

/* ============================================================
   api/_db.js — Conexão Neon PostgreSQL + Drizzle ORM
   ------------------------------------------------------------
   - Validação da DATABASE_URL
   - Exporta `sql` (Neon) e `drizzleSql` (Drizzle)
   - Compatível com auth.js e admin.js
   ============================================================ */

const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');

const {
  eq, and, or, asc, desc,
  sql: drizzleSql, inArray,
  gt, gte, lt, lte, ne,
  isNull, isNotNull, count
} = require('drizzle-orm');

const schema = require('../src/schema.js');

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
const db = drizzle(sqlNeon, { schema });

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
  db,
  
  // O Cliente Neon (usado em auth.js para `sql\`...\``)
  sql: sqlNeon,
  
  // O Construtor do Drizzle (usado em admin.js para `db.execute(drizzleSql\`...\`)`)
  drizzleSql,
  
  schema,
  
  // Operadores
  eq, and, or, asc, desc, inArray,
  gt, gte, lt, lte, ne,
  isNull, isNotNull, count,
  
  checkDatabase
};