// src/db/pool.js
// Single shared PostgreSQL connection pool.

const { Pool } = require('pg')
const { config } = require('../config')
const logger = require('../utils/logger')

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Railway Postgres requires SSL in production
  ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
})

pool.on('error', (err) => {
  logger.error('Unexpected Postgres pool error:', err.message)
})

// Helper: run a query and return rows
async function query(text, params) {
  const start = Date.now()
  const res = await pool.query(text, params)
  logger.debug(`query ${Date.now() - start}ms rows=${res.rowCount}`)
  return res
}

module.exports = { pool, query }
