'use strict';

/* ============================================================
   api/_db.js — Conexão Neon PostgreSQL + Drizzle ORM (v3 — final)
   ------------------------------------------------------------
   - Driver: neon-serverless (WebSocket) para transações reais
   - checkDatabase testa o pool (não o HTTP) com timeout externo
   - Listener de erro no pool
   - closeDatabase idempotente (SIGTERM + SIGINT)
   - REGRA ARQUITETURAL:
       db    → CRUD, Drizzle, transações, pg_advisory_xact_lock
       sql   → consultas independentes (neon HTTP); NUNCA dentro
               de db.transaction()
       pool  → diagnóstico e operações específicas do driver
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

// ─── Helpers de configuração ────────────────────────────────
// [FIX P1] valida inteiro positivo dentro de faixa; falha explícita em vez de
// aceitar decimais, negativos ou strings inválidas silenciosamente.
function positiveIntegerFromEnv(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`[DATABASE] ${name} deve ser um inteiro entre 1 e ${max}.`);
  }
  return value;
}

// ─── Validação da configuração ───────────────────────────────
function getDatabaseUrl() {
  // [FIX P2] normaliza espaços acidentais
  const value = process.env.DATABASE_URL?.trim();
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

// [FIX P1] limites validados por positiveIntegerFromEnv
// [FIX P2] contrato documentado: DATABASE_POOL_MAX × nº_instâncias ≤ limite Neon
const POOL_MAX = positiveIntegerFromEnv('DATABASE_POOL_MAX', 5, 20);
const POOL_CONNECTION_TIMEOUT_MS = positiveIntegerFromEnv(
  'DATABASE_CONNECTION_TIMEOUT_MS',
  10_000
);
const POOL_IDLE_TIMEOUT_MS = positiveIntegerFromEnv(
  'DATABASE_IDLE_TIMEOUT_MS',
  30_000
);

const pool = new Pool({
  connectionString: databaseUrl,
  max: POOL_MAX,
  connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
  idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
});

pool.on('error', (error) => {
  console.error('[DATABASE] Erro no pool:', error.code || 'POOL_ERROR');
});

const db = drizzle({ client: pool, schema });

// ─── Diagnóstico ─────────────────────────────────────────────
// [FIX P1] timeout externo + timeout de consulta no driver.
// O timeout externo libera a função; o timeout do driver tenta encerrar a
// consulta para não ocupar conexão. O pool compartilhado NÃO é destruído.
const CHECK_DB_TIMEOUT_MS = positiveIntegerFromEnv(
  'DATABASE_CHECK_TIMEOUT_MS',
  5_000
);

async function checkDatabase() {
  let timer = null;
  try {
    // query_timeout é suportado por drivers node-postgres (inclui o pool
    // do neon-serverless). Se a versão instalada não honrar, o timeout
    // externo continua garantindo o retorno da função.
    const queryPromise = pool.query({
      text: 'SELECT 1 AS connected',
      query_timeout: CHECK_DB_TIMEOUT_MS,
    });

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error('DB_CHECK_TIMEOUT'), { code: 'DB_CHECK_TIMEOUT' })
          ),
        CHECK_DB_TIMEOUT_MS
      );
    });

    const result = await Promise.race([queryPromise, timeoutPromise]);
    const connected = Number(result?.rows?.[0]?.connected) === 1;
    return { available: connected, connected };
  } catch (error) {
    console.error('[DATABASE] Falha na verificação:', error.code || 'DATABASE_ERROR');
    return { available: false, connected: false };
  } finally {
    if (timer) clearTimeout(timer);
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
  sql: sqlNeon,          // ⚠️ HTTP: NÃO participa de db.transaction()
  sqlNeon,               // alias mantido (compat com chamadas antigas)
  drizzleSql,
  schema,
  eq, and, or, asc, desc, inArray,
  gt, gte, lt, lte, ne,
  isNull, isNotNull, count,
  checkDatabase,
  closeDatabase,
};