'use strict';

/* ============================================================
   api/_db.js — Conexão Neon PostgreSQL + Drizzle ORM
   ------------------------------------------------------------
   - Validação da DATABASE_URL
   - Neon Serverless HTTP
   - Drizzle ORM com schema centralizado
   - Compatibilidade com consultas SQL diretas
   - Exportações explícitas dos operadores Drizzle
   ============================================================ */

const { neon } = require('@neondatabase/serverless');

const {
  drizzle
} = require('drizzle-orm/neon-http');

const {
  eq,
  and,
  or,
  asc,
  desc,
  sql: drizzleSql,
  inArray,
  gt,
  gte,
  lt,
  lte,
  ne,
  isNull,
  isNotNull
} = require('drizzle-orm');

const schema = require('../src/schema.js');

/* ============================================================
   Validação da conexão
   ============================================================ */

const databaseUrl = String(
  process.env.DATABASE_URL || ''
).trim();

if (!databaseUrl) {
  throw new Error(
    '[database] DATABASE_URL não foi configurada.'
  );
}

let parsedDatabaseUrl;

try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error(
    '[database] DATABASE_URL possui formato inválido.'
  );
}

if (
  !['postgres:', 'postgresql:'].includes(
    parsedDatabaseUrl.protocol
  ) ||
  !parsedDatabaseUrl.hostname
) {
  throw new Error(
    '[database] DATABASE_URL deve apontar para um PostgreSQL válido.'
  );
}

/* ============================================================
   Inicialização Neon
   ============================================================ */

const sqlNeon = neon(databaseUrl);

/* ============================================================
   Inicialização Drizzle
   ============================================================ */

const db = drizzle(sqlNeon, {
  schema
});

/* ============================================================
   Exportações
   ============================================================ */

module.exports = {
  db,

  // Compatibilidade com consultas diretas do Neon (auth.js, admin.js, etc.).
  sql: sqlNeon,

  // Expressões SQL do Drizzle (para casos que precisem de `sql\`...\``).
  drizzleSql,

  // Schema centralizado (essencial para admin.js).
  schema,

  // Operadores Drizzle.
  eq,
  and,
  or,
  asc,
  desc,
  inArray,
  gt,
  gte,
  lt,
  lte,
  ne,
  isNull,
  isNotNull
};