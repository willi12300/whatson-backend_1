const express = require('express')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// GET /weather?lat=&lng=
router.get('/', async (req, res) => {
  const lat = parseFloat(req.query.lat)
  const lng = parseFloat(req.query.lng)
  if (Number.isNaN(lat) || Number.isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng required' })
  }

  try {
    const weather = await getWeather(lat, lng)
    res.json(weather)
  } catch (err) {
    // getWeather should normally return cache/fallback instead of throwing.
    logger.warn('[weather-route] fallback after unexpected error:', err.message)
    res.json({
      current: { temp: 15, condition: 'Weather updating', icon: '🌡️', windSpeed: null, precipitation: null },
      hourly: [],
      insight: 'Weather is updating — recommendations still use your location.',
      planningHint: { mode: 'neutral', note: 'weather unavailable, so recommendations stay balanced', temp: 15, condition: 'Weather updating' },
      meta: { source: 'fallback', reason: err.message },
    })
  }
})

module.exports = router
