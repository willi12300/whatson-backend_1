// src/routes/sync.js
const express = require('express')
const { config, CITIES } = require('../config')
const { syncCity } = require('../services/sync')
const { query } = require('../db/pool')
const logger = require('../utils/logger')

const router = express.Router()

// Simple secret check so randoms can't trigger expensive syncs
function checkSecret(req, res, next) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  if (provided !== config.syncSecret) {
    return res.status(401).json({ error: 'Unauthorized — missing or wrong sync secret' })
  }
  next()
}

// POST /sync/liverpool
router.post('/liverpool', checkSecret, async (req, res) => {
  // Run async so the HTTP request doesn't time out on long syncs
  res.json({ message: 'Liverpool sync started. Check /sync/status for progress.' })
  syncCity(CITIES.liverpool).catch((err) => logger.error('Liverpool sync error:', err.message))
})

// POST /sync/city/:city
router.post('/city/:city', checkSecret, async (req, res) => {
  const key = req.params.city.toLowerCase()
  const preset = CITIES[key]
  if (!preset) {
    return res.status(404).json({
      error: `Unknown city "${key}". Available: ${Object.keys(CITIES).join(', ')}`,
    })
  }
  res.json({ message: `${preset.name} sync started. Check /sync/status for progress.` })
  syncCity(preset).catch((err) => logger.error(`${preset.name} sync error:`, err.message))
})

// GET /sync/status  — see recent sync runs
router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10`
    )
    res.json({ runs: rows })
  } catch (err) {
    next(err)
  }
})

module.exports = router
