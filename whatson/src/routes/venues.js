const express = require('express')
const { query } = require('../db/pool')
const { distanceMeters } = require('../utils/helpers')
const router = express.Router()

router.get('/', async (req, res, next) => {
  try {
    const { lat, lng, radius = 3000, category, city, search, limit = 100 } = req.query
    const params = [], where = ['1=1']
    if (city) { params.push(city); where.push(`city = $${params.length}`) }
    if (category) { params.push(category); where.push(`category_slug = $${params.length}`) }
    if (search) { params.push(`%${search}%`); where.push(`name ILIKE $${params.length}`) }
    if (lat && lng) {
      const dLat = radius / 111320
      const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180))
      params.push(parseFloat(lat) - dLat); where.push(`lat >= $${params.length}`)
      params.push(parseFloat(lat) + dLat); where.push(`lat <= $${params.length}`)
      params.push(parseFloat(lng) - dLng); where.push(`lng >= $${params.length}`)
      params.push(parseFloat(lng) + dLng); where.push(`lng <= $${params.length}`)
    }
    params.push(parseInt(limit))
    const { rows } = await query(`SELECT id,name,category_slug,lat,lng,address,city,phone,website,rating,rating_count,price_level,opening_hours,business_status,photos,cover_photo,claimed FROM venues WHERE ${where.join(' AND ')} LIMIT $${params.length}`, params)
    let result = rows
    if (lat && lng) {
      result = rows.map(v => ({ ...v, distance_m: Math.round(distanceMeters(parseFloat(lat), parseFloat(lng), v.lat, v.lng)) }))
        .filter(v => v.distance_m <= radius)
        .sort((a, b) => a.distance_m - b.distance_m)
    }
    res.json({ count: result.length, venues: result })
  } catch (err) { next(err) }
})

// GET /venues/list/trending?city=Liverpool — top venues (must be before /:id)
router.get('/list/trending', async (req, res, next) => {
  try {
    const { city, limit = 15 } = req.query
    const params = []
    let where = ['1=1']
    if (city) { params.push(city); where.push(`v.city = $${params.length}`) }
    params.push(parseInt(limit))
    const { rows } = await query(`
      SELECT v.id, v.name, v.category_slug, v.lat, v.lng, v.address, v.city,
             v.rating, v.rating_count, v.cover_photo, v.photos,
             COUNT(e.id) FILTER (WHERE e.status='active' AND e.starts_at >= now()) AS upcoming_events
      FROM venues v
      LEFT JOIN events e ON e.venue_id = v.id
      WHERE ${where.join(' AND ')}
      GROUP BY v.id
      ORDER BY (COALESCE(v.rating,0) * COALESCE(v.rating_count,0)) DESC, upcoming_events DESC
      LIMIT $${params.length}
    `, params)
    res.json({ venues: rows })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM venues WHERE id = $1`, [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Venue not found' })
    const events = await query(`SELECT id,name,description,image_url,category,genre,starts_at,ends_at,is_free,min_price,ticket_url FROM events WHERE venue_id=$1 AND status='active' AND starts_at>=now() ORDER BY starts_at ASC LIMIT 20`, [req.params.id])
    const sources = await query(`SELECT provider,provider_id FROM venue_sources WHERE venue_id=$1`, [req.params.id])
    const offers = await query(`SELECT id,title,description,discount_type,estimated_value,ends_at,redeem_url FROM offers WHERE venue_id=$1 AND active=TRUE AND (ends_at IS NULL OR ends_at>=now()) ORDER BY created_at DESC`, [req.params.id])

    // Busy estimate (legal heuristic)
    let busy = null
    try {
      const { estimateBusy } = require('../services/busyEstimate')
      busy = estimateBusy(rows[0], { when: new Date(), events: events.rows.map(e => ({ ...e, venue_id: parseInt(req.params.id) })) })
    } catch (e) { /* non-fatal */ }

    res.json({ ...rows[0], events: events.rows, sources: sources.rows, offers: offers.rows, busy })
  } catch (err) { next(err) }
})

module.exports = router
