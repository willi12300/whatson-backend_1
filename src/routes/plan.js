const express = require('express')
const { CITIES } = require('../config')
const { buildTemplateExperience } = require('../services/experienceTemplateEngine')
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

    const plan = await buildTemplateExperience({
      city,
      vibe: vibe || null,
      text: text || null,
      weather,
      budget: budget || null,
      audience: req.body?.audience || req.body?.who || null,
      availableMinutes: req.body?.availableMinutes || req.body?.durationMinutes || null,
      energy: req.body?.energy || null,
      walkingPreference: req.body?.walkingPreference || null,
      now: new Date(),
      lat: lat != null ? Number(lat) : null,
      lng: lng != null ? Number(lng) : null,
    })
    if (plan.error === 'no_venues') return res.status(404).json({ error: 'No venues for that city yet — run a sync first.' })
    if (plan.error) return res.status(200).json({ error: plan.error, message: plan.message, stops: [] })
    res.json(plan)
  } catch (err) {
    logger.error('plan-night error:', err.message)
    next(err)
  }
})

module.exports = router
