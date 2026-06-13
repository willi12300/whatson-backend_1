// src/scripts/syncLiverpool.js
// Run a one-off Liverpool sync from the command line: `npm run sync:liverpool`

const { CITIES } = require('../config')
const { syncCity } = require('../services/sync')
const { pool } = require('../db/pool')
const logger = require('../utils/logger')

syncCity(CITIES.liverpool)
  .then(async (stats) => {
    logger.info('Sync finished:', stats)
    await pool.end()
    process.exit(0)
  })
  .catch(async (err) => {
    logger.error('Sync failed:', err.message)
    await pool.end()
    process.exit(1)
  })
