// drizzle.config.js
require('dotenv').config({ path: '.env.local' }); // 👈 aponta para .env.local

/** @type {import("drizzle-kit").Config} */
module.exports = {
  schema: './src/schema.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  verbose: true,
  strict: true,
};