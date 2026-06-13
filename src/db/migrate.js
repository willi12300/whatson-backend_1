const fs = require('fs')
const path = require('path')
const { pool } = require('./pool')
const logger = require('../utils/logger')

async function migrate() {
  const dir = path.join(__dirname, '..', '..', 'migrations')
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  logger.info(`Running ${files.length} migration(s)...`)
  for (const file of files) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
    logger.info(`  → ${file}`)
    await pool.query(sql)
    logger.info(`  ✓ ${file} done`)
  }
  logger.info('All migrations complete.')
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch(err => { console.error(err.message); process.exit(1) })
}

module.exports = { migrate }
