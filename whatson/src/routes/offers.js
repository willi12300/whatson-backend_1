const express = require('express')
const { query } = require('../db/pool')
const { config } = require('../config')
const { enrichVenueIntelligence } = require('../services/venueIntelligence')
const logger = require('../utils/logger')
const router = express.Router()

function checkSecret(req) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  return provided === config.syncSecret
}

// GET /offers?venueId=  OR  /offers?city=   — active offers
router.get('/', async (req, res, next) => {
  try {
    const { venueId, city } = req.query
    const params = [], where = ['o.active = TRUE', '(o.ends_at IS NULL OR o.ends_at >= now())']
    if (venueId) { params.push(venueId); where.push(`o.venue_id = $${params.length}`) }
    if (city) { params.push(city); where.push(`v.city = $${params.length}`) }
    const { rows } = await query(
      `SELECT o.*, v.name AS venue_name FROM offers o JOIN venues v ON v.id = o.venue_id
       WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC LIMIT 100`, params
    )
    res.json({ offers: rows })
  } catch (err) { next(err) }
})

// POST /offers/admin?secret=  — create an offer (manual/admin for MVP)
router.post('/admin', async (req, res, next) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'unauthorized' })
    const { venueId, title, description, discount_type, estimated_value, starts_at, ends_at, terms, redeem_url } = req.body || {}
    if (!venueId || !title) return res.status(400).json({ error: 'venueId and title required' })
    const { rows } = await query(
      `INSERT INTO offers (venue_id, title, description, discount_type, estimated_value, starts_at, ends_at, terms, redeem_url, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual') RETURNING *`,
      [venueId, title, description || null, discount_type || null, estimated_value || null,
       starts_at || null, ends_at || null, terms || null, redeem_url || null]
    )
    res.json({ ok: true, offer: rows[0] })
  } catch (err) { next(err) }
})

// POST /offers/admin/enrich?secret=  — derive pricing + menu links for venues
router.post('/admin/enrich', async (req, res, next) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'unauthorized' })
    const result = await enrichVenueIntelligence(req.body?.city || null)
    res.json({ ok: true, ...result })
  } catch (err) { next(err) }
})

module.exports = router
