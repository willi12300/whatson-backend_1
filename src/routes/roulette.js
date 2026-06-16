// src/routes/roulette.js
// Sappo Roulette — picks ONE great place at random from the top matches.
// Random feel, but never bad/irrelevant: real venues only, filtered + scored.

const express = require('express')
const { query } = require('../db/pool')
const { getWeather } = require('../clients/weather')
const { getProfile, plannerBoosts, applySignal } = require('../services/travelProfile')
const { CITIES } = require('../config')
const { reverseGeocode } = require('../clients/google')
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

// Nearest known city to coordinates (for GPS → city, overriding stale selectedCity).
function nearestCity(lat, lng) {
  if (lat == null || lng == null) return null
  let best = null
  for (const [key, c] of Object.entries(CITIES)) {
    const distKm = haversineKm(lat, lng, c.lat, c.lng)
    if (distKm != null && (!best || distKm < best.distKm)) best = { key, name: c.name, distKm }
  }
  return best
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

    // Resolve location: real GPS → reverse-geocode to the actual city (global); else city centre.
    let cityName
    if (lat != null && lng != null) {
      const geo = await reverseGeocode(lat, lng)
      if (geo?.city) cityName = geo.city
      else { const near = nearestCity(lat, lng); cityName = (near && near.distKm <= 60) ? near.name : (selectedCity || 'Liverpool') }
    } else {
      cityName = selectedCity || 'Liverpool'
      const preset = CITIES[(cityName || '').toLowerCase().replace(/\s+/g, '')]
      if (preset) { lat = preset.lat; lng = preset.lng }
    }

    const cats = MODE_CATEGORIES[mode] || MODE_CATEGORIES.anything
    const radiusM = DISTANCE_M[distance] || 1600
    const when = new Date()
    const debug = { hotelsRejected: 0, venueCandidates: 0, eventsSkiddle: 0, eventsEventbrite: 0, eventsTicketmaster: 0, eventsOther: 0 }

    // weather (for rainy_day / outdoor handling)
    let weather = null
    try { weather = await getWeather(lat, lng) } catch {}

    // profile (gentle personalisation of the spin)
    let boosts = null
    const pkey = req.userId ? { userId: req.userId } : (deviceId ? { deviceId } : null)
    if (pkey) { try { boosts = plannerBoosts(await getProfile(pkey)) } catch {} }

    // ── HARD BLACKLIST: never let accommodation through (unless mode is explicitly lodging) ──
    const BLACKLIST_NAME = ['hotel', 'hostel', 'travelodge', 'premier inn', 'aparthotel', 'guest house', 'motel', 'serviced apartment', 'b&b']
    const BLACKLIST_CAT = ['lodging', 'hotel', 'accommodation', 'apartment', 'real_estate', 'rental']
    const isBlacklisted = (name, cat) => {
      if (BLACKLIST_CAT.includes(cat)) return true
      const n = (name || '').toLowerCase()
      return BLACKLIST_NAME.some(w => n.includes(w))
    }

    // ── 1. VENUE CANDIDATES (food/drink/attractions) ──
    const { rows: rawVenues } = await query(
      `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng, opening_hours, website
       FROM venues
       WHERE city = $1 AND name IS NOT NULL
         AND category_slug = ANY($2)
       LIMIT 400`,
      [cityName, cats]
    )
    const venues = rawVenues.filter(v => {
      if (isBlacklisted(v.name, v.category_slug)) { debug.hotelsRejected++; return false }
      return true
    })
    debug.venueCandidates = venues.length

    // ── 2. EVENT CANDIDATES (Skiddle/Eventbrite/Ticketmaster) happening soon ──
    let events = []
    try {
      const { rows } = await query(
        `SELECT e.id, e.name, e.category, e.genre, e.starts_at, e.is_free, e.min_price, e.ticket_url,
                e.image_url, v.lat, v.lng, v.name AS venue_name, v.address,
                (SELECT provider FROM event_sources es WHERE es.event_id = e.id LIMIT 1) AS provider
         FROM events e LEFT JOIN venues v ON v.id = e.venue_id
         WHERE v.city = $1 AND e.starts_at >= now() AND e.starts_at <= now() + interval '14 days'
           AND e.status = 'active'
         ORDER BY e.starts_at ASC LIMIT 60`,
        [cityName]
      )
      events = rows
      for (const e of rows) {
        const p = (e.provider || '').toLowerCase()
        if (p.includes('skiddle')) debug.eventsSkiddle++
        else if (p.includes('eventbrite')) debug.eventsEventbrite++
        else if (p.includes('ticketmaster')) debug.eventsTicketmaster++
        else debug.eventsOther++
      }
    } catch (e) { logger.error('[roulette] events fetch failed:', e.message) }

    // ── Score VENUES ──
    const wantHidden = mode === 'hidden_gem'
    const wantIndoor = mode === 'rainy_day' || weather?.planningHint?.mode === 'indoor'
    const scoredVenues = venues.map(v => {
      let score = 0, reasons = [], reject = false
      const km = haversineKm(lat, lng, v.lat, v.lng)
      if (km != null) {
        if (km * 1000 > radiusM * 1.25) reject = true
        else { score += Math.max(0, 25 - km * 8); if (km * 1000 <= radiusM) reasons.push('nearby') }   // distance up to 25
      }
      const open = isOpenNow(v.opening_hours, when)
      if (open === false) reject = true
      else if (open === true) { score += 10; reasons.push('open now') }
      if (v.rating) { score += Math.min(v.rating * 3, 15); if (v.rating >= 4.4) reasons.push('highly rated') }   // rating up to 15
      score += Math.min((v.rating_count || 0) / 400, 5)
      // relevance to mode
      if ((MODE_CATEGORIES[mode] || []).includes(v.category_slug)) { score += 25; reasons.push('matches your vibe') }
      if (budget === 'cheap') { if (v.price_level && v.price_level <= 2) { score += 8; reasons.push('good value') } else if (v.price_level >= 3) score -= 12 }
      if (budget === 'treat') { if (v.price_level >= 3) { score += 8; reasons.push('a proper treat') } }
      if (wantHidden) {
        if ((v.rating_count || 0) > 2500) score -= 12
        else if ((v.rating_count || 0) < 600 && v.rating >= 4.3) { score += 14; reasons.push('a real local gem') }
      }
      if (wantIndoor && ['park'].includes(v.category_slug)) score -= 8
      if (boosts?.categoryBoost?.[v.category_slug]) score += Math.min(boosts.categoryBoost[v.category_slug], 10)
      const isGem = (v.rating_count || 0) < 600 && (v.rating || 0) >= 4.3
      return { kind: 'venue', v, score, reasons, reject, km, open, isGem }
    }).filter(s => !s.reject && s.score > 0)

    // ── Score EVENTS ──
    const scoredEvents = events.map(e => {
      let score = 0, reasons = [], reject = false
      const km = (e.lat != null) ? haversineKm(lat, lng, e.lat, e.lng) : null
      if (km != null) {
        if (km * 1000 > radiusM * 2) reject = true                    // events allow a bit more travel
        else score += Math.max(0, 25 - km * 6)
      }
      // happening soon (today/tonight/this week) — big boost
      const hrs = (new Date(e.starts_at) - when) / 3600000
      if (hrs >= 0 && hrs <= 12) { score += 30; reasons.push('on today') }
      else if (hrs <= 48) { score += 22; reasons.push('on soon') }
      else if (hrs <= 24 * 7) { score += 12; reasons.push('this week') }
      // event source trust
      const p = (e.provider || '').toLowerCase()
      if (p.includes('skiddle') || p.includes('eventbrite') || p.includes('ticketmaster')) { score += 18; reasons.push('live event') }
      else score += 8
      // relevance to mode
      const cg = `${e.category || ''} ${e.genre || ''}`.toLowerCase()
      if (mode === 'drinks' && /club|dj|party|bar/.test(cg)) { score += 25; reasons.push('matches your vibe') }
      if (mode === 'date_night' && /music|comedy|theatre|live/.test(cg)) { score += 20; reasons.push('great for a date') }
      if (mode === 'anything') score += 10
      if (budget === 'cheap' && e.is_free) { score += 10; reasons.push('free') }
      return { kind: 'event', e, score, reasons, reject, km }
    }).filter(s => !s.reject && s.score > 0)

    // ── BALANCED POOL: 40% events · 40% quality venues · 20% hidden gems ──
    scoredEvents.sort((a, b) => b.score - a.score)
    const gems = scoredVenues.filter(s => s.isGem).sort((a, b) => b.score - a.score)
    const regular = scoredVenues.filter(s => !s.isGem).sort((a, b) => b.score - a.score)

    const POOL = 10
    const pool = [
      ...scoredEvents.slice(0, Math.round(POOL * 0.4)),
      ...regular.slice(0, Math.round(POOL * 0.4)),
      ...gems.slice(0, Math.round(POOL * 0.2)),
    ]
    // backfill to POOL size from whatever's best if a bucket was thin
    if (pool.length < POOL) {
      const rest = [...scoredEvents, ...regular, ...gems]
        .filter(x => !pool.includes(x))
        .sort((a, b) => b.score - a.score)
      pool.push(...rest.slice(0, POOL - pool.length))
    }
    debug.finalPool = pool.length

    logger.info('[roulette] ' + JSON.stringify({ city: cityName, mode, ...debug }))

    if (!pool.length) return res.json({ error: 'no_matches', message: "Nothing good open and nearby right now — try a wider distance or different mode.", debug })

    // RANDOM pick from the balanced top pool.
    const pick = pool[Math.floor(Math.random() * pool.length)]

    // ── Build the response (venue OR event) ──
    if (pick.kind === 'event') {
      const e = pick.e
      const walkMin = pick.km != null ? Math.max(1, Math.round((pick.km / 5) * 60)) : null
      const whyBits = [...new Set(pick.reasons)]
      return res.json({
        title: e.name,
        type: 'Live event' + (e.venue_name ? ` · ${e.venue_name}` : ''),
        distance: walkMin != null ? `${walkMin} min walk` : null,
        estimated_cost: e.is_free ? 'Free' : (e.min_price ? `from £${e.min_price}` : '££'),
        why: `Chosen because it's ${whyBits.join(', ')} — something exciting happening near you.`,
        when: e.starts_at,
        source: cap(pick.e.provider) || 'Event',
        lat: e.lat, lng: e.lng, address: e.address || null,
        google_maps_url: e.ticket_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${e.venue_name || e.name}, ${cityName}`)}`,
        is_event: true,
        actions: ['Let\u2019s Go', 'Spin Again', 'Add to Plan'],
        debug,
      })
    }

    const v = pick.v
    const walkMin = pick.km != null ? Math.max(1, Math.round((pick.km / 5) * 60)) : null
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name}, ${v.address || cityName}`)}`
    const whyBits = [...new Set(pick.reasons)]
    return res.json({
      title: v.name,
      type: prettyType(v.category_slug),
      distance: walkMin != null ? `${walkMin} min walk` : null,
      estimated_cost: v.price_level ? PRICE_LABEL[v.price_level] : '££',
      why: `Chosen because it ${whyBits.length ? whyBits.join(', ') : 'fits what you fancied'} — a great shout for ${mode.replace('_', ' ')}.`,
      rating: v.rating || null,
      lat: v.lat, lng: v.lng,
      address: v.address || null,
      source: 'Sappo',
      google_maps_url: mapUrl,
      venueId: v.id,
      actions: ['Let\u2019s Go', 'Spin Again', 'Add to Plan'],
      debug,
    })
  } catch (err) { logger.error('[roulette] error:', err.message); next(err) }
})

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s }

function prettyType(slug) {
  return ({
    restaurant: 'Restaurant', cafe: 'Café', bar: 'Bar', pub: 'Pub', nightclub: 'Club',
    music_venue: 'Live music', museum: 'Museum', gallery: 'Art gallery',
    landmark: 'Landmark', park: 'Park', attraction: 'Attraction',
  })[slug] || 'Spot'
}

module.exports = router
