const express = require('express')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// GET /weather?lat=&lng=
router.get('/', async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat)
    const lng = parseFloat(req.query.lng)
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng required' })
    }
    const weather = await getWeather(lat, lng)
    res.json(weather)
  } catch (err) {
    logger.error('weather:', err.message)
    res.status(502).json({ error: 'weather_unavailable' })
  }
})

module.exports = router
