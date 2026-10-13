const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()
const {DESTINATIONS}=require('../services/destinations')

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
    const cities=DESTINATIONS.map(destination=>{const r=rows.find(x=>x.name===destination.name);return {...destination,venueCount:Number(r?.venue_count)||0,eventCount:Number(r?.event_count)||0}})
    res.json({ cities })
  } catch (err) { next(err) }
})

module.exports = router
