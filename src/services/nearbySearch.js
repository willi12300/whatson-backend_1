// src/services/nearbySearch.js
// Proximity/discovery-first nearby search.
// SAPPO should not just return the same famous city-centre venues.
// We score by: proximity + relevance + rating quality + discovery/independent potential + open status.
// Review count is deliberately capped so huge chains/tourist favourites don't always win.

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


const CHAIN_PATTERNS = [
  'starbucks','costa','caffe nero','pret','mcdonald','kfc','burger king','subway','greggs',
  'wetherspoon','spoons','slug and lettuce','revolution','all bar one','the ivy','turtle bay',
  'nando','pizza express','zizzi','wagamama','five guys','miller and carter','brewdog',
  'premier inn','travelodge','novotel','holiday inn','ibis','hilton','marriott','malmaison'
]
function isLikelyChain(name = '') {
  const n = String(name || '').toLowerCase()
  return CHAIN_PATTERNS.some(x => n.includes(x))
}
function discoveryScore(v, m) {
  const rating = Number(v.rating || 0)
  const count = Number(v.rating_count || 0)
  let s = 0
  // High quality with modest review volume = strong hidden-gem signal.
  if (rating >= 4.7 && count >= 10 && count <= 600) s += 22
  else if (rating >= 4.5 && count >= 10 && count <= 1000) s += 18
  else if (rating >= 4.3 && count >= 10 && count <= 1500) s += 12
  else if (rating >= 4.0 && count <= 250) s += 7

  if (!isLikelyChain(v.name)) s += 8
  else s -= 12

  // Huge review counts are useful for trust but often mean the obvious places.
  if (count > 5000) s -= 12
  else if (count > 2500) s -= 8
  else if (count > 1200) s -= 4

  // Hyper-local beats defaulting to city centre.
  if (m != null && m < 800) s += 10
  else if (m != null && m < 1500) s += 6
  else if (m != null && m > 3500) s -= 6

  return Math.max(-15, Math.min(30, s))
}
function weightedJitter() {
  // Small randomness prevents the same equal-score cards every time.
  return Math.random() * 4
}
function diversify(scored, limit) {
  const picked = []
  const seenNames = new Set()
  const pool = scored.slice(0, Math.min(scored.length, Math.max(limit * 4, 24)))
  for (const item of pool) {
    const base = String(item.v.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18)
    if (seenNames.has(base)) continue
    seenNames.add(base)
    picked.push(item)
    if (picked.length >= limit) break
  }
  if (picked.length < limit) {
    for (const item of scored) {
      if (!picked.includes(item)) picked.push(item)
      if (picked.length >= limit) break
    }
  }
  return picked
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
    const score =
      (proximityScore(m) * 1.15) +
      (relevanceScore(v.category_slug, categories) * 1.0) +
      (ratingScore(v.rating, v.rating_count) * 0.85) +
      (openScore(open) * 0.6) +
      discoveryScore(v, m) +
      weightedJitter()
    return { v, m, open, score, discovery_score: discoveryScore(v, m), is_independent: !isLikelyChain(v.name) }
  })
  .filter(s => s.m != null && s.m <= radius)
  .filter(s => !openNowOnly || s.open !== false)        // exclude closed if requested
  .sort((a, b) => b.score - a.score)

  const selected = diversify(scored, limit)

  logger.info('[nearby] ' + JSON.stringify({ lat: +lat.toFixed(3), lng: +lng.toFixed(3), cats: categories, intent, strict, found: rows.length, afterFilter: rowsForScoring.length, returned: selected.length }))

  return {
    debug: debug && rule ? { intent, rule: rule.label, candidatesFound: rows.length, afterHardFilter: rowsForScoring.length, rejected: filteredRows.rejected || [] } : undefined,
    results: selected.map(s => ({
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
      discovery_score: Math.round(s.discovery_score || 0),
      is_independent: !!s.is_independent,
    })),
  }
}

const ATTRACTION_CATS = ['attraction', 'museum', 'gallery', 'landmark', 'park']

module.exports = { nearbySearch, ATTRACTION_CATS, haversineM, isOpenNow }
