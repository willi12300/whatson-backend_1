// src/routes/attractions.js
const express = require('express')
const { nearbySearch, ATTRACTION_CATS } = require('../services/nearbySearch')
const router = express.Router()

// GET /attractions/nearby?lat=&lng=&radius=&limit=
// Nearby tourist attractions, museums, galleries, landmarks, parks — proximity-first.
router.get('/nearby', async (req, res, next) => {
  try {
    const { lat, lng, radius, limit, city } = req.query
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat/lng required' })
    const out = await nearbySearch({
      lat: parseFloat(lat), lng: parseFloat(lng),
      categories: ATTRACTION_CATS,
      radius: radius ? parseInt(radius) : 5000,
      limit: limit ? parseInt(limit) : 12,
      city: city || null,
    })
    if (out.error) return res.status(400).json(out)
    res.json({ count: out.results.length, results: out.results })
  } catch (err) { next(err) }
})

module.exports = router
