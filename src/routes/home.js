const express = require('express')
const { buildLivingHome } = require('../services/livingHomeService')

const router = express.Router()

// GET /home/living?city=Liverpool&lat=53.4&lng=-2.99
// A deliberate, time-aware collection for the SAPPO home—not a generic venue feed.
router.get('/living', async (req, res, next) => {
  try {
    const city = String(req.query.city || '').trim()
    if (!city) return res.status(400).json({ error: 'city is required' })
    const lat = req.query.lat == null ? null : Number(req.query.lat)
    const lng = req.query.lng == null ? null : Number(req.query.lng)
    const home = await buildLivingHome({
      city,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    })
    if (home.error) return res.status(400).json(home)
    res.json(home)
  } catch (error) {
    next(error)
  }
})

module.exports = router
