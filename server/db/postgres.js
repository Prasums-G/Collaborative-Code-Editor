// db/postgres.js
const { Pool } = require('pg');
const logger   = require('../logger');

const pgPool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pgPool.on('error', (err) => logger.error('PostgreSQL pool error', err));

module.exports = { pgPool };
