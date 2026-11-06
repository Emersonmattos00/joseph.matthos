const { neon } = require('@neondatabase/serverless');
const { drizzle } = require('drizzle-orm/neon-http');
const { eq, and, or, asc, desc, sql, inArray, gt, lt } = require('drizzle-orm');
const schema = require('../src/schema.js');

const sqlNeon = neon(process.env.DATABASE_URL);
const db = drizzle(sqlNeon, { schema });

module.exports = { 
  db, 
  sql: sqlNeon,
  schema, // <-- ADICIONADO AQUI (Era isso que quebrava o admin!)
  eq, and, or, asc, desc, sql, inArray, gt, lt 
};