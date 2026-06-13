// src/db/migrate.js
// Runs all .sql files in /migrations in alphabetical order.
// Safe to run repeatedly — every statement uses IF NOT EXISTS / ON CONFLICT.

const fs = require('fs')
const path = require('path')
const { pool } = require('./pool')
const logger = require('../utils/logger')

async function migrate() {
  const dir = path.join(__dirname, '..', '..', 'migrations')
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  logger.info(`Running ${files.length} migration(s)...`)

  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    logger.info(`  → ${file}`)
    try {
      await pool.query(sql)
      logger.info(`  ✓ ${file} applied`)
    } catch (err) {
      logger.error(`  ✗ ${file} failed:`, err.message)
      throw err
    }
  }

  logger.info('All migrations complete.')
}

// Allow running directly: `npm run migrate`
if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('Migration failed:', err.message)
      process.exit(1)
    })
}

module.exports = { migrate }
