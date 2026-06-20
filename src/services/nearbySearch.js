// src/services/nearbySearch.js
// Proximity-first "nearby" search. Implements the spec's scoring:
// distance 45% · relevance 25% · rating 20% · open-now 10%.

const { query } = require('../db/pool')
const logger = require('../utils/logger')
const { getIntentRule, filterByDecisionRule } = require('./decisionRules')

function haversineM(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some(x => x == null)) return null
  const R = 6371000, r = x => x * Math.PI / 180
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function isOpenNow(openingHours, when = new Date()) {
  try {
    const oh = typeof openingHours === 'string' ? JSON.parse(openingHours) : openingHours
    const periods = oh?.periods
    if (!Array.isArray(periods) || !periods.length) return null
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

// proximity score (0-45): nearer = higher
function proximityScore(m) {
  if (m == null) return 0
  if (m < 300) return 45
  if (m < 800) return 38
  if (m < 1500) return 28
  if (m < 2500) return 16
  if (m < 4000) return 8
  return 2
}
// rating score (0-20)
function ratingScore(rating, count) {
  if (!rating) return 6                       // unknown — neutral-ish
  let s = (rating / 5) * 16
  s += Math.min((count || 0) / 500, 1) * 4    // review volume up to +4
  return Math.min(s, 20)
}
// relevance score (0-25): does category match what they asked for
function relevanceScore(categorySlug, wantedCats) {
  if (!wantedCats || !wantedCats.length) return 18
  return wantedCats.includes(categorySlug) ? 25 : 6
}
// open-now score (0-10)
function openScore(open) {
  if (open === true) return 10
  if (open === false) return 0
  return 5                                    // unknown
}

function walkText(m) {
  if (m == null) return null
  const mins = Math.max(1, Math.round((m / 1000 / 5) * 60))   // ~5km/h
  return `${mins} min walk`
}

// Main: return nearby venues scored proximity-first.
// opts: { lat, lng, categories?, radius?, openNowOnly?, limit?, city? }
async function nearbySearch({ lat, lng, categories = [], radius = 3000, openNowOnly = false, limit = 12, city = null, excludeLodging = false, intent = null, strict = false, debug = false }) {
  if (lat == null || lng == null) return { error: 'no_location' }

  // bounding box prefilter for speed
  const dLat = radius / 111320
  const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180))
  const params = [lat - dLat, lat + dLat, lng - dLng, lng + dLng]
  const where = ['lat BETWEEN $1 AND $2', 'lng BETWEEN $3 AND $4', 'name IS NOT NULL', "category_slug NOT IN ('lodging','hotel')"]
  if (categories.length) { params.push(categories); where.push(`category_slug = ANY($${params.length})`) }
  if (city) { params.push(city); where.push(`city = $${params.length}`) }
  // Some hotels are mis-categorised (as bar/restaurant because they have one).
  // For food/drink/gem sections, also exclude by name (reliable ILIKE patterns).
  if (excludeLodging) {
    for (const word of ['hotel', 'hostel', 'travelodge', 'premier inn', 'aparthotel', 'guest house']) {
      params.push(`%${word}%`)
      where.push(`name NOT ILIKE $${params.length}`)
    }
  }

  const { rows } = await query(
    `SELECT id,name,category_slug,lat,lng,address,rating,rating_count,price_level,opening_hours,website,cover_photo,photos
     FROM venues WHERE ${where.join(' AND ')} LIMIT 250`,
    params
  )

  const rule = getIntentRule(intent)
  const filteredRows = rule ? filterByDecisionRule(rows, rule, { debug }) : rows
  const rowsForScoring = debug && filteredRows.kept ? filteredRows.kept : filteredRows

  const when = new Date()
  const scored = rowsForScoring.map(v => {
    const m = haversineM(lat, lng, v.lat, v.lng)
    const open = isOpenNow(v.opening_hours, when)
    const score = proximityScore(m) + relevanceScore(v.category_slug, categories) + ratingScore(v.rating, v.rating_count) + openScore(open)
    return { v, m, open, score }
  })
  .filter(s => s.m != null && s.m <= radius)
  .filter(s => !openNowOnly || s.open !== false)        // exclude closed if requested
  .sort((a, b) => b.score - a.score)
  .slice(0, limit)

  logger.info('[nearby] ' + JSON.stringify({ lat: +lat.toFixed(3), lng: +lng.toFixed(3), cats: categories, intent, strict, found: rows.length, afterFilter: rowsForScoring.length, returned: scored.length }))

  return {
    debug: debug && rule ? { intent, rule: rule.label, candidatesFound: rows.length, afterHardFilter: rowsForScoring.length, rejected: filteredRows.rejected || [] } : undefined,
    results: scored.map(s => ({
      id: s.v.id,
      title: s.v.name,
      category: s.v.category_slug,
      distance_meters: Math.round(s.m),
      distance_text: s.m < 1000 ? `${Math.round(s.m)}m` : `${(s.m / 1000).toFixed(1)}km`,
      walking_time_estimate: walkText(s.m),
      rating: s.v.rating || null,
      rating_count: s.v.rating_count || null,
      price_level: s.v.price_level || null,
      open_now: s.open,
      address: s.v.address || null,
      lat: s.v.lat, lng: s.v.lng,
      cover_photo: s.v.cover_photo || (Array.isArray(s.v.photos) ? s.v.photos[0] : null),
      source: 'Sappo',
      google_maps_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.v.name}, ${s.v.address || ''}`)}`,
      score: Math.round(s.score),
    })),
  }
}

const ATTRACTION_CATS = ['attraction', 'museum', 'gallery', 'landmark', 'park']

module.exports = { nearbySearch, ATTRACTION_CATS, haversineM, isOpenNow }
