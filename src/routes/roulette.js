// src/routes/roulette.js
// Sappo Roulette — picks ONE great place at random from the top matches.
// Random feel, but never bad/irrelevant: real venues only, filtered + scored.

const express = require('express')
const { query } = require('../db/pool')
const { getWeather } = require('../clients/weather')
const { getProfile, plannerBoosts, applySignal } = require('../services/travelProfile')
const { CITIES } = require('../config')
const { reverseGeocode } = require('../clients/google')
const { gatherCandidates, getRecentSpins, recordSpin, storeIntelligence } = require('../services/rouletteEngine')
const logger = require('../utils/logger')
const router = express.Router()

// mode → categories it should pull from
const MODE_CATEGORIES = {
  food:        ['restaurant', 'cafe'],
  drinks:      ['bar', 'pub'],
  live_event:  ['music_venue', 'bar', 'nightclub'],   // events prioritised separately
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

// POST /roulette { mode, distance, budget, who, vibe, spinMode, lat, lng, selectedCity, deviceId }
router.post('/', async (req, res, next) => {
  try {
    const { mode = 'anything', distance = '20min', budget, who, vibe, spinMode = 'discover', selectedCity, deviceId } = req.body || {}
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
    const radiusMiles = Math.max(2, Math.round(radiusM / 1609) || 5)
    const when = new Date()

    // weather (for rainy_day / outdoor handling)
    let weather = null
    try { weather = await getWeather(lat, lng) } catch {}

    // profile (gentle personalisation of the spin)
    let boosts = null
    const pkey = req.userId ? { userId: req.userId } : (deviceId ? { deviceId } : null)
    if (pkey) { try { boosts = plannerBoosts(await getProfile(pkey)) } catch {} }

    // ── GATHER CANDIDATES from ALL sources (DB + live APIs) with full audit ──
    // Only fetch the Google place-types relevant to the selected mode (faster + on-target).
    const GOOGLE_TYPES_BY_MODE = {
      food: ['restaurant', 'cafe'],
      drinks: ['bar', 'pub'],
      live_event: ['bar', 'night_club'],
      hidden_gem: ['restaurant', 'cafe', 'bar', 'art_gallery', 'tourist_attraction'],
      tourist_spot: ['tourist_attraction', 'museum', 'art_gallery', 'historical_landmark', 'park'],
      date_night: ['restaurant', 'bar'],
      rainy_day: ['museum', 'art_gallery', 'cafe', 'restaurant'],
      anything: ['restaurant', 'cafe', 'bar', 'pub', 'tourist_attraction', 'museum', 'art_gallery', 'park'],
    }
    const googleTypes = GOOGLE_TYPES_BY_MODE[mode] || GOOGLE_TYPES_BY_MODE.anything
    const { venues, events, audit } = await gatherCandidates({ lat, lng, cityName, cats, radiusMiles, googleTypes })

    // ── ANTI-REPETITION: recent spins for this user/device ──
    const recent = await getRecentSpins({ deviceId, userId: req.userId })
    const keyOf = (item) => item.kind === 'event'
      ? `e:${item.e.id || item.e.name}`
      : `v:${item.v.id || item.v.name}`
    const repetitionPenalty = (k) => {
      let p = 0
      if (recent.last === k) p -= 1000          // same as previous spin
      if (recent.last5.has(k)) p -= 500          // in last 5 spins
      if (recent.today.has(k)) p -= 100          // shown earlier today
      return p
    }

    // ── Score VENUES ──
    const wantHidden = mode === 'hidden_gem'
    const wantIndoor = mode === 'rainy_day' || weather?.planningHint?.mode === 'indoor'
    const scoredVenues = venues.map(v => {
      let score = 0, reasons = [], reject = false
      const km = haversineKm(lat, lng, v.lat, v.lng)
      if (km != null) {
        if (km * 1000 > radiusM * 1.4) reject = true
        else { score += Math.max(0, 25 - km * 8); if (km * 1000 <= radiusM) reasons.push('nearby') }
      }
      const open = isOpenNow(v.opening_hours, when)
      if (open === false) reject = true
      else if (open === true) { score += 10; reasons.push('open now') }
      if (v.rating) { score += Math.min(v.rating * 3, 15); if (v.rating >= 4.4) reasons.push('highly rated') }
      score += Math.min((v.rating_count || 0) / 400, 5)
      if ((MODE_CATEGORIES[mode] || []).includes(v.category_slug)) { score += 25; reasons.push('matches your vibe') }
      if (budget === 'cheap') { if (v.price_level && v.price_level <= 2) { score += 8; reasons.push('good value') } else if (v.price_level >= 3) score -= 12 }
      if (budget === 'treat') { if (v.price_level >= 3) { score += 8; reasons.push('a proper treat') } }
      if (wantHidden) {
        if ((v.rating_count || 0) > 2500) score -= 12
        else if ((v.rating_count || 0) < 600 && v.rating >= 4.3) { score += 14; reasons.push('a real local gem') }
      }
      if (wantIndoor && ['park'].includes(v.category_slug)) score -= 8
      if (boosts?.categoryBoost?.[v.category_slug]) score += Math.min(boosts.categoryBoost[v.category_slug], 10)
      score += Math.random() * 8                    // freshness jitter
      const isGem = (v.rating_count || 0) < 600 && (v.rating || 0) >= 4.3
      const item = { kind: 'venue', v, score, reasons, reject, km, open, isGem }
      item.score += repetitionPenalty(keyOf(item))
      return item
    }).filter(s => !s.reject && s.score > -100)

    // ── Score EVENTS ──
    const scoredEvents = events.map(e => {
      let score = 0, reasons = [], reject = false
      const km = (e.lat != null) ? haversineKm(lat, lng, e.lat, e.lng) : null
      if (km != null) {
        if (km * 1000 > radiusM * 2.5) reject = true
        else score += Math.max(0, 25 - km * 6)
      }
      const hrs = (new Date(e.starts_at) - when) / 3600000
      if (hrs >= 0 && hrs <= 12) { score += 30; reasons.push('on today') }
      else if (hrs <= 48) { score += 22; reasons.push('on soon') }
      else if (hrs <= 24 * 7) { score += 12; reasons.push('this week') }
      else if (hrs < 0) reject = true                // already passed
      const p = (e.provider || '').toLowerCase()
      if (p.includes('skiddle') || p.includes('eventbrite') || p.includes('ticketmaster')) { score += 18; reasons.push('live event') }
      else score += 8
      const cg = `${e.category || ''} ${e.genre || ''}`.toLowerCase()
      if (mode === 'drinks' && /club|dj|party|bar/.test(cg)) { score += 25; reasons.push('matches your vibe') }
      if (mode === 'date_night' && /music|comedy|theatre|live/.test(cg)) { score += 20; reasons.push('great for a date') }
      if (mode === 'live_event') { score += 20; reasons.push('a live event') }
      if (mode === 'anything') score += 10
      if (budget === 'cheap' && e.is_free) { score += 10; reasons.push('free') }
      score += Math.random() * 8                    // freshness jitter
      const item = { kind: 'event', e, score, reasons, reject, km }
      item.score += repetitionPenalty(keyOf(item))
      return item
    }).filter(s => !s.reject && s.score > -100)

    // ── BALANCED POOL with a LARGE qualified set (30-50), then random pick ──
    scoredEvents.sort((a, b) => b.score - a.score)
    const gems = scoredVenues.filter(s => s.isGem).sort((a, b) => b.score - a.score)
    const regular = scoredVenues.filter(s => !s.isGem).sort((a, b) => b.score - a.score)

    const POOL = 40                                  // large qualified pool (spec: 30-50)
    let eventShare = 0.4, venueShare = 0.4, gemShare = 0.2
    if (mode === 'live_event') { eventShare = 0.8; venueShare = 0.15; gemShare = 0.05 }
    else if (vibe === 'lively' || vibe === 'adventure') { eventShare = 0.5; venueShare = 0.35; gemShare = 0.15 }
    else if (vibe === 'chill') { eventShare = 0.25; venueShare = 0.45; gemShare = 0.3 }

    let pool = [
      ...scoredEvents.slice(0, Math.round(POOL * eventShare)),
      ...regular.slice(0, Math.round(POOL * venueShare)),
      ...gems.slice(0, Math.round(POOL * gemShare)),
    ]
    if (pool.length < POOL) {
      const rest = [...scoredEvents, ...regular, ...gems].filter(x => !pool.includes(x)).sort((a, b) => b.score - a.score)
      pool.push(...rest.slice(0, POOL - pool.length))
    }
    // never let the immediately-previous result back in
    pool = pool.filter(item => keyOf(item) !== recent.last)

    // ── FULL AUDIT LOG ──
    const totalCandidates = (audit.dbVenues.count + audit.googlePlaces.count + audit.dbEvents.count + audit.skiddle.count + audit.ticketmaster.count + audit.eventbrite.count)
    logger.info('[roulette AUDIT] ' + JSON.stringify({
      city: cityName, mode, vibe,
      sources: {
        googlePlaces: audit.googlePlaces, dbVenues: audit.dbVenues,
        skiddle: audit.skiddle, ticketmaster: audit.ticketmaster, eventbrite: audit.eventbrite, dbEvents: audit.dbEvents,
      },
      totalCandidates,
      afterFilter: venues.length + events.length,
      afterScoring: scoredVenues.length + scoredEvents.length,
      finalPool: pool.length,
    }))

    // store discovered venues/events into the intelligence cache (non-blocking)
    storeIntelligence({ venues, events }).catch(() => {})

    if (!pool.length) return res.json({ error: 'no_matches', message: "Nothing good open and nearby right now — try a wider distance or different mode.", audit })

    // RANDOM pick from the large qualified pool.
    const pick = pool[Math.floor(Math.random() * pool.length)]
    const chosenKey = keyOf(pick)
    recordSpin({ deviceId, userId: req.userId, resultKey: chosenKey, resultName: pick.kind === 'event' ? pick.e.name : pick.v.name }).catch(() => {})

    const debug = { totalCandidates, finalPool: pool.length, audit }

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
