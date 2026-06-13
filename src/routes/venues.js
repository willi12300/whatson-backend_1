// src/routes/venues.js
const express = require('express')
const { query } = require('../db/pool')
const { distanceMeters } = require('../utils/helpers')

const router = express.Router()

// GET /venues?lat=&lng=&radius=&category=&city=&search=&limit=
router.get('/', async (req, res, next) => {
  try {
    const {
      lat, lng, radius = 3000, category, city = 'Liverpool', search, limit = 100,
    } = req.query

    const params = []
    let where = ['1=1']

    if (city) { params.push(city); where.push(`city = $${params.length}`) }
    if (category) { params.push(category); where.push(`category_slug = $${params.length}`) }
    if (search) { params.push(`%${search}%`); where.push(`name ILIKE $${params.length}`) }

    // bounding-box pre-filter for performance when lat/lng given
    if (lat && lng) {
      const dLat = radius / 111320
      const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180))
      params.push(parseFloat(lat) - dLat); where.push(`lat >= $${params.length}`)
      params.push(parseFloat(lat) + dLat); where.push(`lat <= $${params.length}`)
      params.push(parseFloat(lng) - dLng); where.push(`lng >= $${params.length}`)
      params.push(parseFloat(lng) + dLng); where.push(`lng <= $${params.length}`)
    }

    params.push(parseInt(limit))
    const sql = `
      SELECT id, name, category_slug, lat, lng, address, postcode, city,
             phone, website, rating, rating_count, price_level,
             opening_hours, business_status, photos, cover_photo, claimed
      FROM venues
      WHERE ${where.join(' AND ')}
      LIMIT $${params.length}
    `
    const { rows } = await query(sql, params)

    // exact distance filter + sort if coords given
    let result = rows
    if (lat && lng) {
      result = rows
        .map((v) => ({
          ...v,
          distance_m: Math.round(distanceMeters(parseFloat(lat), parseFloat(lng), v.lat, v.lng)),
        }))
        .filter((v) => v.distance_m <= radius)
        .sort((a, b) => a.distance_m - b.distance_m)
    }

    res.json({ count: result.length, venues: result })
  } catch (err) {
    next(err)
  }
})

// GET /venues/:id  — full profile with events
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params
    const venueRes = await query(`SELECT * FROM venues WHERE id = $1`, [id])
    if (!venueRes.rows.length) return res.status(404).json({ error: 'Venue not found' })

    const venue = venueRes.rows[0]

    const events = await query(
      `SELECT id, name, description, image_url, category, genre,
              starts_at, ends_at, is_free, min_price, ticket_url
       FROM events
       WHERE venue_id = $1 AND status = 'active' AND starts_at >= now()
       ORDER BY starts_at ASC LIMIT 20`,
      [id]
    )

    const sources = await query(
      `SELECT provider, provider_id FROM venue_sources WHERE venue_id = $1`,
      [id]
    )

    res.json({ ...venue, events: events.rows, sources: sources.rows })
  } catch (err) {
    next(err)
  }
})

module.exports = router
