const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()

// GET /cities  — distinct cities that actually have data, with counts
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT v.city AS name,
             COUNT(DISTINCT v.id) AS venue_count,
             COUNT(DISTINCT e.id) FILTER (WHERE e.status='active' AND e.starts_at >= now()) AS event_count,
             AVG(v.lat) AS lat, AVG(v.lng) AS lng
      FROM venues v
      LEFT JOIN events e ON e.venue_id = v.id
      GROUP BY v.city
      HAVING COUNT(DISTINCT v.id) > 0
      ORDER BY venue_count DESC
    `)
    const cities = rows.map(r => ({
      id: r.name.toLowerCase().replace(/\s+/g, '-'),
      name: r.name,
      venueCount: parseInt(r.venue_count),
      eventCount: parseInt(r.event_count),
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lng),
    }))
    res.json({ cities })
  } catch (err) { next(err) }
})

module.exports = router
