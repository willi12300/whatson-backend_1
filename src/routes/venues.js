const express = require('express')
const { query } = require('../db/pool')
const { distanceMeters } = require('../utils/helpers')
const { nearbySearch } = require('../services/nearbySearch')
const { fetchVenues } = require('../clients/google')
const logger = require('../utils/logger')
const { getVenueProfile, syncTripAdvisorForVenue, syncTripAdvisorBatch } = require('../services/venueProfile')
const router = express.Router()

// GET /venues/test-google — quick health check for the Places API (New).
// Hit this in a browser after enabling Places API (New) to confirm it works.
router.get('/test-google', async (req, res) => {
  logger.info('[test-google] hit')
  try {
    const lat = parseFloat(req.query.lat) || 53.4084
    const lng = parseFloat(req.query.lng) || -2.9916
    const keyPresent = !!process.env.GOOGLE_PLACES_API_KEY
    logger.info('[test-google] keyPresent=' + keyPresent + ' calling fetchVenues')
    let venues = []
    try {
      venues = await fetchVenues(lat, lng, 2000)
    } catch (inner) {
      logger.error('[test-google] fetchVenues threw: ' + inner.message)
      return res.json({ google: 'ERROR', stage: 'fetchVenues', error: inner.message, keyPresent })
    }
    logger.info('[test-google] fetchVenues returned ' + (venues ? venues.length : 'null'))
    if (venues && venues.length) {
      return res.json({ google: 'WORKING', count: venues.length, sample: venues.slice(0, 3).map(v => v.name), keyPresent })
    }
    return res.json({ google: 'NOT_WORKING', count: 0, keyPresent, hint: 'Enable "Places API (New)" in Google Cloud and allow it on the key. Check logs for "API keys are not supported".' })
  } catch (e) {
    logger.error('[test-google] outer error: ' + (e && e.message))
    return res.json({ google: 'ERROR', stage: 'handler', error: e && e.message, keyPresent: !!process.env.GOOGLE_PLACES_API_KEY })
  }
})


// GET /venues/nearby?lat=&lng=&categories=restaurant,cafe&radius=&openNow=&limit=
// Proximity-first nearby search (distance 45% · relevance 25% · rating 20% · open 10%).
router.get('/nearby', async (req, res, next) => {
  try {
    const { lat, lng, categories, radius, openNow, limit, city } = req.query
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat/lng required' })
    const cats = categories ? String(categories).split(',').map(s => s.trim()).filter(Boolean) : []
    const out = await nearbySearch({
      lat: parseFloat(lat), lng: parseFloat(lng),
      categories: cats,
      radius: radius ? parseInt(radius) : 3000,
      openNowOnly: openNow === 'true' || openNow === '1',
      limit: limit ? parseInt(limit) : 12,
      city: city || null,
    })
    if (out.error) return res.status(400).json(out)
    res.json({ count: out.results.length, results: out.results })
  } catch (err) { next(err) }
})


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



// POST /venues/admin/sync-tripadvisor?city=Liverpool&limit=25&force=true
// Bulk sync TripAdvisor IDs/ratings/reviews into the venue database.
router.post('/admin/sync-tripadvisor', async (req, res, next) => {
  try {
    const out = await syncTripAdvisorBatch({
      city: req.query.city || req.body?.city || null,
      limit: parseInt(req.query.limit || req.body?.limit || 25),
      force: String(req.query.force || req.body?.force || '').toLowerCase() === 'true',
    })
    res.json({ tripadvisor: 'SYNC_COMPLETE', ...out })
  } catch (err) { next(err) }
})

// POST /venues/:id/sync-tripadvisor — force TripAdvisor enrichment for one venue.
router.post('/:id/sync-tripadvisor', async (req, res, next) => {
  try {
    const result = await syncTripAdvisorForVenue(req.params.id, { force: true })
    if (!result) return res.status(404).json({ error: 'Venue not found' })
    res.json({ tripadvisor: result.matched ? 'MATCHED' : 'NO_MATCH', result })
  } catch (err) { next(err) }
})

// GET /venues/test-tripadvisor?name=Moose%20Coffee&lat=&lng=&category=cafe
router.get('/test-tripadvisor', async (req, res) => {
  try {
    const { hasTripAdvisor, enrichTripAdvisorForVenue } = require('../clients/tripadvisor')
    const keyPresent = hasTripAdvisor()
    if (!keyPresent) return res.json({ tripadvisor: 'MISSING_KEY', keyPresent })
    const venue = {
      id: 0,
      name: req.query.name || 'Moose Coffee',
      lat: req.query.lat ? parseFloat(req.query.lat) : 53.4084,
      lng: req.query.lng ? parseFloat(req.query.lng) : -2.9916,
      address: req.query.address || 'Liverpool',
      category_slug: req.query.category || 'cafe',
    }
    const ta = await enrichTripAdvisorForVenue(venue)
    res.json({ tripadvisor: ta ? 'WORKING' : 'NO_MATCH', keyPresent, sample: ta })
  } catch (e) {
    res.json({ tripadvisor: 'ERROR', error: e.message, keyPresent: !!process.env.TRIPADVISOR_API_KEY || !!process.env.TRIPADVISOR_CONTENT_API_KEY })
  }
})

// GET /venues/:id/profile?lat=&lng= — enriched profile for the SAPPO venue profile UX.
router.get('/:id/profile', async (req, res, next) => {
  try {
    const profile = await getVenueProfile(req.params.id, { lat: req.query.lat, lng: req.query.lng })
    if (!profile) return res.status(404).json({ error: 'Venue not found' })
    res.json(profile)
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const profile = await getVenueProfile(req.params.id, { lat: req.query.lat, lng: req.query.lng })
    if (!profile) return res.status(404).json({ error: 'Venue not found' })
    res.json(profile)
  } catch (err) { next(err) }
})

module.exports = router
