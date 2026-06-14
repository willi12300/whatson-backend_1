const express = require('express')
const { CITIES } = require('../config')
const { planNight } = require('../services/planNight')
const logger = require('../utils/logger')
const router = express.Router()

// POST /plan-night  { city, vibe?, mode?, text?, stops? }
router.post('/', async (req, res, next) => {
  try {
    const { city, vibe, mode, text, stops } = req.body || {}
    if (!city) return res.status(400).json({ error: 'city is required' })
    const plan = await planNight({
      city,
      vibe: vibe || null,
      mode: mode || null,
      text: text || null,
      stops: Math.min(Math.max(parseInt(stops) || 3, 2), 5),
    })
    if (plan.error === 'no_venues') return res.status(404).json({ error: 'No venues for that city yet — run a sync first.' })
    res.json(plan)
  } catch (err) {
    logger.error('plan-night error:', err.message)
    next(err)
  }
})

module.exports = router
