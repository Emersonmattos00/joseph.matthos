/**
 * drizzle.config.mjs
 * ------------------------------------------------------------
 * Configuração do Drizzle Kit
 * Banco: PostgreSQL / Neon
 *
 * Este arquivo usa extensão .mjs porque o projeto é CommonJS.
 * O Drizzle Kit reconhece .mjs como ES Module independente
 * do "type" do package.json.
 */

import 'dotenv/config';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || !databaseUrl.trim()) {
  throw new Error(
    '[Drizzle Kit] DATABASE_URL não foi configurada. ' +
    'Defina a variável de ambiente antes de executar as migrations.'
  );
}

if (
  !databaseUrl.startsWith('postgres://') &&
  !databaseUrl.startsWith('postgresql://')
) {
  throw new Error(
    '[Drizzle Kit] DATABASE_URL deve utilizar PostgreSQL.'
  );
}

/** @type { import("drizzle-kit").Config } */
export default {
  schema: './src/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
};