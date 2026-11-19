'use strict';

/* ============================================================
   api/_db.js — Conexão Neon PostgreSQL + Drizzle ORM (v4)
   ------------------------------------------------------------
   - Driver: neon-serverless (WebSocket) para transações reais
   - checkDatabase testa o pool (não o HTTP) com timeout externo
   - Listener de erro no pool
   - closeDatabase idempotente (NÃO registra sinais aqui;
     o ponto de entrada da aplicação deve chamar closeDatabase
     em SIGTERM/SIGINT se rodar em processo persistente)
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

// Contrato operacional: POOL_MAX × nº de instâncias simultâneas ≤ limite do plano Neon.
// Documentar e monitorar. Default conservador (5) para serverless.
const POOL_MAX = positiveIntegerFromEnv('DATABASE_POOL_MAX', 5, 20);
const POOL_CONNECTION_TIMEOUT_MS = positiveIntegerFromEnv(
  'DATABASE_CONNECTION_TIMEOUT_MS',
  10_000,
  120_000
);
const POOL_IDLE_TIMEOUT_MS = positiveIntegerFromEnv(
  'DATABASE_IDLE_TIMEOUT_MS',
  30_000,
  600_000
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
// O timeout externo libera a função. O query_timeout tenta encerrar a
// consulta no driver; em @neondatabase/serverless ele pode não ser honrado
// pela versão instalada — o timeout externo continua garantindo o retorno.
const CHECK_DB_TIMEOUT_MS = positiveIntegerFromEnv(
  'DATABASE_CHECK_TIMEOUT_MS',
  5_000,
  60_000
);

async function checkDatabase() {
  let timer = null;
  try {
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
// NÃO registramos process.on aqui: quem importa este módulo decide quando
// encerrar. Em ambiente serverless, não dependa de sinal. Em processo
// persistente, o ponto de entrada deve chamar closeDatabase() em
// SIGTERM/SIGINT com timeout de segurança.
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
