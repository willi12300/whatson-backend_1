const express = require('express')
const { config, CITIES } = require('../config')
const { enrichCity } = require('../services/enrichSocials')
const logger = require('../utils/logger')
const router = express.Router()

function checkSecret(req, res, next) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  if (provided !== config.syncSecret) return res.status(401).json({ error: 'Unauthorized — add ?secret=YOUR_SYNC_SECRET' })
  next()
}

// GET /enrich/:city?secret=...  — crawl venue websites for social links
router.get('/:city', checkSecret, (req, res) => {
  const key = req.params.city.toLowerCase()
  const preset = CITIES[key]
  const cityName = preset ? preset.name : req.params.city
  res.json({ message: `Enriching socials for ${cityName}. Runs in background — check venues in a few minutes.` })
  enrichCity(cityName).catch(err => logger.error('Enrich error:', err.message))
})

module.exports = router
