/**
 * api/_db.js — Conexão com o banco de dados (Neon PostgreSQL + Drizzle ORM)
 * 
 * CORREÇÕES APLICADAS:
 * - Validação explícita da DATABASE_URL (evita erros obscuros)
 * - Validação do protocolo da URL (postgres:// ou postgresql://)
 * - Exporta o schema e os helpers do Drizzle para uso nos módulos
 */

'use strict';

const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');
const { eq, and, or, asc, desc, sql, inArray, gt, lt } = require('drizzle-orm');
const schema = require('../src/schema.js');

// ─────────────────────────────────────────────────────────────
// Validação da configuração
// ─────────────────────────────────────────────────────────────
const databaseUrl = String(process.env.DATABASE_URL || '').trim();

if (!databaseUrl) {
  throw new Error(
    '[db] DATABASE_URL não configurada. Defina a variável de ambiente no Render.'
  );
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  throw new Error(
    '[db] DATABASE_URL possui formato inválido. Verifique se a string está completa.'
  );
}

if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
  throw new Error(
    '[db] DATABASE_URL deve apontar para um banco PostgreSQL (postgres:// ou postgresql://).'
  );
}

// ─────────────────────────────────────────────────────────────
// Conexão
// ─────────────────────────────────────────────────────────────
const sqlNeon = neon(databaseUrl);
const db = drizzle(sqlNeon, { schema });

module.exports = {
  db,
  sql: sqlNeon,
  schema,
  eq,
  and,
  or,
  asc,
  desc,
  sql,
  inArray,
  gt,
  lt,
};