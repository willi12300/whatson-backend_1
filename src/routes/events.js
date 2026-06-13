const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()

router.get('/', async (req, res, next) => {
  try {
    const { city = 'Liverpool', category, from, to, limit = 100 } = req.query
    const params = [], where = [`e.status='active'`]
    params.push(city); where.push(`v.city=$${params.length}`)
    if (category) { params.push(category); where.push(`e.category=$${params.length}`) }
    if (from) { params.push(from); where.push(`e.starts_at>=$${params.length}`) } else where.push(`e.starts_at>=now()`)
    if (to) { params.push(to); where.push(`e.starts_at<=$${params.length}`) }
    params.push(parseInt(limit))
    const { rows } = await query(`SELECT e.id,e.name,e.description,e.image_url,e.category,e.genre,e.starts_at,e.ends_at,e.is_free,e.min_price,e.ticket_url,v.id AS venue_id,v.name AS venue_name,v.lat,v.lng,v.address AS venue_address,v.cover_photo AS venue_photo FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE ${where.join(' AND ')} ORDER BY e.starts_at ASC LIMIT $${params.length}`, params)
    res.json({ count: rows.length, events: rows })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT e.*,v.name AS venue_name,v.lat,v.lng,v.address AS venue_address,v.cover_photo AS venue_photo FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE e.id=$1`, [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Event not found' })
    const sources = await query(`SELECT provider,provider_id FROM event_sources WHERE event_id=$1`, [req.params.id])
    res.json({ ...rows[0], sources: sources.rows })
  } catch (err) { next(err) }
})

module.exports = router
