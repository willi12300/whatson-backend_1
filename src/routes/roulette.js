// src/routes/roulette.js
// Sappo Roulette — picks ONE great place at random from the top matches.
// Random feel, but never bad/irrelevant: real venues only, filtered + scored.

const express = require('express')
const { query } = require('../db/pool')
const { getWeather } = require('../clients/weather')
const { getProfile, plannerBoosts, applySignal } = require('../services/travelProfile')
const { CITIES } = require('../config')
const logger = require('../utils/logger')
const router = express.Router()

// mode → categories it should pull from
const MODE_CATEGORIES = {
  food:        ['restaurant', 'cafe'],
  drinks:      ['bar', 'pub'],
  hidden_gem:  ['bar', 'restaurant', 'cafe', 'attraction', 'gallery'],
  tourist_spot:['attraction', 'landmark', 'museum'],
  date_night:  ['restaurant', 'bar'],
  rainy_day:   ['museum', 'gallery', 'cafe', 'restaurant'],
  anything:    ['restaurant', 'bar', 'pub', 'cafe', 'attraction', 'museum', 'landmark', 'gallery', 'park', 'music_venue'],
}
// distance presets → metres
const DISTANCE_M = { '10min': 800, '20min': 1600, '5miles': 8000 }
const PRICE_LABEL = ['', '£', '££', '£££', '££££']

function haversineKm(a, b, c, d) {
  if ([a, b, c, d].some(x => x == null)) return null
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function isOpenNow(openingHours, when = new Date()) {
  try {
    const oh = typeof openingHours === 'string' ? JSON.parse(openingHours) : openingHours
    const periods = oh?.periods
    if (!Array.isArray(periods) || !periods.length) return null    // unknown
    const day = when.getDay(), hm = when.getHours() * 100 + when.getMinutes()
    for (const p of periods) {
      if (p.open?.day === day) {
        const o = p.open.hour * 100 + (p.open.minute || 0)
        const c = p.close ? p.close.hour * 100 + (p.close.minute || 0) : 2400
        if (hm >= o && hm <= c) return true
      }
    }
    return false
  } catch { return null }
}

// POST /roulette { mode, distance, budget, lat, lng, selectedCity, deviceId }
router.post('/', async (req, res, next) => {
  try {
    const { mode = 'anything', distance = '20min', budget, selectedCity, deviceId } = req.body || {}
    let { lat, lng } = req.body || {}

    // Resolve location: GPS preferred, else selected city centre.
    let cityName = selectedCity || 'Liverpool'
    if (lat == null || lng == null) {
      const preset = CITIES[(cityName || '').toLowerCase()]
      if (preset) { lat = preset.lat; lng = preset.lng }
    }

    const cats = MODE_CATEGORIES[mode] || MODE_CATEGORIES.anything
    const radiusM = DISTANCE_M[distance] || 1600
    const when = new Date()

    // weather (for rainy_day / outdoor handling)
    let weather = null
    try { weather = await getWeather(lat, lng) } catch {}

    // profile (gentle personalisation of the spin)
    let boosts = null
    const pkey = req.userId ? { userId: req.userId } : (deviceId ? { deviceId } : null)
    if (pkey) { try { boosts = plannerBoosts(await getProfile(pkey)) } catch {} }

    // Pull candidate venues in the right categories & city.
    const { rows: venues } = await query(
      `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng, opening_hours, website
       FROM venues
       WHERE city = $1 AND name IS NOT NULL
         AND category_slug = ANY($2)
         AND category_slug NOT IN ('lodging','hotel')
       LIMIT 300`,
      [cityName, cats]
    )
    if (!venues.length) return res.json({ error: 'no_venues', message: `No spots for ${cityName} yet — try Liverpool or Manchester.` })

    // Score + filter.
    const wantHidden = mode === 'hidden_gem'
    const wantIndoor = mode === 'rainy_day' || weather?.planningHint?.mode === 'indoor'
    const scored = venues.map(v => {
      let score = 0, reasons = [], reject = false
      // distance
      const km = haversineKm(lat, lng, v.lat, v.lng)
      if (km != null) {
        if (km * 1000 > radiusM * 1.25) { reject = true }       // outside range
        else { score += Math.max(0, 12 - km * 4); if (km * 1000 <= radiusM) reasons.push('nearby') }
      }
      // open now (never show closed)
      const open = isOpenNow(v.opening_hours, when)
      if (open === false) { reject = true }
      else if (open === true) { score += 10; reasons.push('open now') }
      // rating
      if (v.rating) { score += Math.min(v.rating * 3, 15); if (v.rating >= 4.4) reasons.push('highly rated') }
      score += Math.min((v.rating_count || 0) / 300, 5)
      // budget
      if (budget === 'cheap') { if (v.price_level && v.price_level <= 2) { score += 8; reasons.push('good value') } else if (v.price_level >= 3) { score -= 12 } }
      if (budget === 'treat') { if (v.price_level >= 3) { score += 8; reasons.push('a proper treat') } }
      // hidden gem: favour lesser-known quality, penalise tourist traps
      if (wantHidden) {
        if ((v.rating_count || 0) > 2500) { score -= 12 }
        else if ((v.rating_count || 0) < 500 && v.rating >= 4.3) { score += 12; reasons.push('a real local gem') }
      }
      // rainy day / indoor
      if (wantIndoor && ['park', 'attraction'].includes(v.category_slug)) score -= 8
      // profile boost
      if (boosts?.categoryBoost?.[v.category_slug]) score += Math.min(boosts.categoryBoost[v.category_slug], 10)
      return { v, score, reasons, reject, km, open }
    }).filter(s => !s.reject && s.score > 0).sort((a, b) => b.score - a.score)

    if (!scored.length) return res.json({ error: 'no_matches', message: "Nothing open and nearby matched — try a wider distance or different mode." })

    // Take top 10 good matches, then RANDOMLY pick one (the roulette feel).
    const top = scored.slice(0, 10)
    const pick = top[Math.floor(Math.random() * top.length)]
    const v = pick.v

    const walkMin = pick.km != null ? Math.max(1, Math.round((pick.km / 5) * 60)) : null
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name}, ${v.address || cityName}`)}`
    const whyBits = [...new Set(pick.reasons)]
    const why = `Chosen because it ${whyBits.length ? whyBits.join(', ') : 'fits what you fancied'} — a great shout for ${mode.replace('_', ' ')}.`

    return res.json({
      title: v.name,
      type: prettyType(v.category_slug),
      distance: walkMin != null ? `${walkMin} min walk` : null,
      estimated_cost: v.price_level ? PRICE_LABEL[v.price_level] : '££',
      why,
      rating: v.rating || null,
      lat: v.lat, lng: v.lng,
      address: v.address || null,
      google_maps_url: mapUrl,
      venueId: v.id,
      actions: ['Let\u2019s Go', 'Spin Again', 'Add to Plan'],
    })
  } catch (err) { logger.error('[roulette] error:', err.message); next(err) }
})

function prettyType(slug) {
  return ({
    restaurant: 'Restaurant', cafe: 'Café', bar: 'Bar', pub: 'Pub', nightclub: 'Club',
    music_venue: 'Live music', museum: 'Museum', gallery: 'Art gallery',
    landmark: 'Landmark', park: 'Park', attraction: 'Attraction',
  })[slug] || 'Spot'
}

module.exports = router
