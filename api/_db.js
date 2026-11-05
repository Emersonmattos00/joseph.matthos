/**
 * api/_db.js — Conexão com o banco de dados (Neon PostgreSQL + Drizzle ORM)
 *
 * Exporta:
 *   - db       → cliente Drizzle (query builder)
 *   - neonSql  → tagged template que EXECUTA queries SQL diretas
 *   - sql      → construtor de expressões do Drizzle (NÃO executa)
 *   - schema   → schema do banco
 *   - operadores Drizzle (eq, and, or, asc, desc, inArray, gt, lt)
 *
 * IMPORTANTE:
 *   await neonSql`SELECT ...`  → executa
 *   await sql`SELECT ...`      → NÃO executa (retorna expressão)
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
    '[db] DATABASE_URL não configurada. Defina a variável de ambiente.'
  );
}

let parsedUrl;
try {
  parsedUrl = new URL(databaseUrl);
} catch {
  throw new Error('[db] DATABASE_URL possui formato inválido.');
}

if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol)) {
  throw new Error(
    '[db] DATABASE_URL deve ser postgres:// ou postgresql://.'
  );
}

// ─────────────────────────────────────────────────────────────
// Conexões
// ─────────────────────────────────────────────────────────────
const neonSql = neon(databaseUrl);
const db = drizzle(neonSql, { schema });

module.exports = Object.freeze({
  db,
  neonSql,
  schema,
  eq, and, or, asc, desc,
  sql,
  inArray, gt, lt,
});