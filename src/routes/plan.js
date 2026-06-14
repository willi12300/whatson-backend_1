const express = require('express')
const { CITIES } = require('../config')
const { planNight } = require('../services/planNight')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// POST /plan-night  { city, vibe?, mode?, text?, stops?, lat?, lng? }
router.post('/', async (req, res, next) => {
  try {
    const { city, vibe, mode, text, stops, lat, lng, home, budget, busyPref } = req.body || {}
    if (!city) return res.status(400).json({ error: 'city is required' })

    // Fetch weather silently if we have coordinates (or fall back to city centre).
    let weather = null
    let wlat = lat, wlng = lng
    if (wlat == null || wlng == null) {
      const preset = CITIES?.[String(city).toLowerCase()]
      if (preset) { wlat = preset.lat; wlng = preset.lng }
    }
    if (wlat != null && wlng != null) {
      try { weather = await getWeather(wlat, wlng) } catch (e) { logger.error('plan weather skipped:', e.message) }
    }

    const plan = await planNight({
      city,
      vibe: vibe || null,
      mode: mode || null,
      text: text || null,
      stops: Math.min(Math.max(parseInt(stops) || 3, 2), 5),
      weather,
      home: home || null,
      budget: budget || null,
      busyPref: busyPref || null,
    })
    if (plan.error === 'no_venues') return res.status(404).json({ error: 'No venues for that city yet — run a sync first.' })
    res.json(plan)
  } catch (err) {
    logger.error('plan-night error:', err.message)
    next(err)
  }
})

module.exports = router
