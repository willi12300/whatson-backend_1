// src/routes/geocode.js
// Lightweight address search for the home-location picker.
// GET /api/geocode/search?q=   — returns up to 5 place candidates
// GET /api/geocode/reverse?lat=&lng= — returns human address for coordinates
const router = require('express').Router()
const { findPlace, reverseGeocode } = require('../clients/google')
const logger = require('../utils/logger')

// Search an address / place name → [{name, address, lat, lng}]
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    if (!q || q.length < 3) return res.json({ results: [] })
    const result = await findPlace(q)
    if (!result) return res.json({ results: [] })
    res.json({ results: [{ name: result.name || result.address, address: result.address, lat: result.lat, lng: result.lng }] })
  } catch (err) { logger.error('[geocode] search error:', err.message); next(err) }
})

// Reverse-geocode lat/lng → { city, address }
router.get('/reverse', async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng)
    if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'Invalid coords' })
    const result = await reverseGeocode(lat, lng)
    res.json(result || { city: null, address: null })
  } catch (err) { logger.error('[geocode] reverse error:', err.message); next(err) }
})

module.exports = router
