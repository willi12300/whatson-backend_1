const express = require('express')
const { config, CITIES } = require('../config')
const { syncCity } = require('../services/sync')
const { query } = require('../db/pool')
const logger = require('../utils/logger')
const router = express.Router()

function checkSecret(req, res, next) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  if (provided !== config.syncSecret) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

router.post('/liverpool', checkSecret, (req, res) => {
  res.json({ message: 'Liverpool sync started. Check /sync/status for progress.' })
  syncCity(CITIES.liverpool).catch(err => logger.error('Liverpool sync error:', err.message))
})

router.post('/city/:city', checkSecret, (req, res) => {
  const preset = CITIES[req.params.city.toLowerCase()]
  if (!preset) return res.status(404).json({ error: `Unknown city. Available: ${Object.keys(CITIES).join(', ')}` })
  res.json({ message: `${preset.name} sync started.` })
  syncCity(preset).catch(err => logger.error('Sync error:', err.message))
})

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10`)
    res.json({ runs: rows })
  } catch (err) { next(err) }
})

module.exports = router
