/**
 * drizzle.config.js (ou drizzle.config.mjs)
 * ------------------------------------------------------------
 * Configuração do Drizzle Kit
 * Banco: PostgreSQL / Neon
 *
 * Compatibilidade:
 *   - Se package.json "type": "module"  → este arquivo como .js funciona
 *   - Se package.json "type": "commonjs" (padrão) → renomear para .mjs
 */

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl || !databaseUrl.trim()) {
  throw new Error(
    '[Drizzle Kit] DATABASE_URL não foi configurada. ' +
    'Defina a variável de ambiente antes de executar as migrations.'
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
  verbose: true,
  strict: true,
};