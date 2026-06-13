const { Pool } = require('pg')
const logger = require('../utils/logger')

// Check all possible Railway database URL variable names
const connectionString = 
  process.env.DATABASE_URL ||
  process.env.DATABASE_PRIVATE_URL ||
  process.env.DATABASE_PUBLIC_URL

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
})

pool.on('error', err => logger.error('Postgres pool error:', err.message))

async function query(text, params) {
  const res = await pool.query(text, params)
  return res
}

module.exports = { pool, query }
