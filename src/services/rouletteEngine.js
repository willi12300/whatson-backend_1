// src/services/rouletteEngine.js
// The Roulette candidate pipeline with FULL AUDIT logging and anti-repetition.
// Pulls from BOTH the local DB AND live APIs so the candidate pool is large.

const { query } = require('../db/pool')
const logger = require('../utils/logger')
const skiddle = require('../clients/skiddle')
const ticketmaster = require('../clients/ticketmaster')
const eventbrite = require('../clients/eventbrite')
const google = require('../clients/google')

// ── blacklist (accommodation never appears) ──
const BLACKLIST_NAME = ['hotel', 'hostel', 'travelodge', 'premier inn', 'aparthotel', 'guest house', 'motel', 'serviced apartment', 'b&b']
const BLACKLIST_CAT = ['lodging', 'hotel', 'accommodation', 'apartment', 'real_estate', 'rental']
function isBlacklisted(name, cat) {
  if (BLACKLIST_CAT.includes((cat || '').toLowerCase())) return true
  const n = (name || '').toLowerCase()
  return BLACKLIST_NAME.some(w => n.includes(w))
}

function haversineKm(a, b, c, d) {
  if ([a, b, c, d].some(x => x == null)) return null
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Gather candidates from ALL sources, with a per-source audit.
// Returns { venues:[], events:[], audit:{} }
async function gatherCandidates({ lat, lng, cityName, cats, radiusMiles = 5 }) {
  const audit = {
    googlePlaces: { sent: false, ok: false, count: 0 },
    dbVenues: { count: 0 },
    skiddle: { sent: false, ok: false, count: 0 },
    ticketmaster: { sent: false, ok: false, count: 0 },
    eventbrite: { sent: false, ok: false, count: 0 },
    dbEvents: { count: 0 },
  }

  // ---- VENUES: local DB ----
  let dbVenues = []
  try {
    const { rows } = await query(
      `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng, opening_hours, website
       FROM venues WHERE city = $1 AND name IS NOT NULL AND category_slug = ANY($2) LIMIT 400`,
      [cityName, cats]
    )
    dbVenues = rows.map(v => ({ ...v, _src: 'db' }))
    audit.dbVenues.count = dbVenues.length
  } catch (e) { logger.error('[roulette] db venues failed:', e.message) }

  // ---- VENUES: live Google Places (widens the pool beyond what's synced) ----
  let googleVenues = []
  if (lat != null && lng != null) {
    audit.googlePlaces.sent = true
    try {
      const radiusM = Math.min(radiusMiles * 1609, 20000)
      const fetched = await google.fetchVenues(lat, lng, radiusM)
      audit.googlePlaces.ok = true
      audit.googlePlaces.count = fetched.length
      // normalise to the venue shape (these aren't in our DB, so no id)
      googleVenues = fetched.map(v => ({
        id: null, name: v.name, category_slug: v.category || v.primaryType || 'other',
        rating: v.rating || null, rating_count: v.userRatingCount || v.rating_count || null,
        price_level: v.priceLevel || v.price_level || null,
        address: v.formattedAddress || v.address || null,
        lat: v.location?.latitude ?? v.lat, lng: v.location?.longitude ?? v.lng,
        opening_hours: v.regularOpeningHours || v.opening_hours || null,
        website: v.websiteUri || null, _src: 'google',
      }))
    } catch (e) { logger.error('[roulette] google live failed:', e.message); audit.googlePlaces.ok = false }
  }

  // ---- EVENTS: local DB ----
  let dbEvents = []
  try {
    const { rows } = await query(
      `SELECT e.id, e.name, e.category, e.genre, e.starts_at, e.is_free, e.min_price, e.ticket_url,
              e.image_url, v.lat, v.lng, v.name AS venue_name, v.address,
              (SELECT provider FROM event_sources es WHERE es.event_id = e.id LIMIT 1) AS provider
       FROM events e LEFT JOIN venues v ON v.id = e.venue_id
       WHERE v.city = $1 AND e.starts_at >= now() AND e.starts_at <= now() + interval '21 days'
         AND e.status = 'active' ORDER BY e.starts_at ASC LIMIT 80`,
      [cityName]
    )
    dbEvents = rows.map(e => ({ ...e, _src: 'db' }))
    audit.dbEvents.count = dbEvents.length
  } catch (e) { logger.error('[roulette] db events failed:', e.message) }

  // ---- EVENTS: live APIs (the big pool-wideners) ----
  const liveEvents = []
  if (lat != null && lng != null) {
    const [sk, tm, eb] = await Promise.allSettled([
      (async () => { audit.skiddle.sent = true; const r = await skiddle.fetchEvents(lat, lng, radiusMiles); audit.skiddle.ok = true; audit.skiddle.count = r.length; return r })(),
      (async () => { audit.ticketmaster.sent = true; const r = await ticketmaster.fetchEvents(lat, lng, radiusMiles); audit.ticketmaster.ok = true; audit.ticketmaster.count = r.length; return r })(),
      (async () => { audit.eventbrite.sent = true; const r = await eventbrite.fetchEvents(lat, lng, radiusMiles); audit.eventbrite.ok = true; audit.eventbrite.count = r.length; return r })(),
    ])
    for (const res of [sk, tm, eb]) {
      if (res.status === 'fulfilled' && Array.isArray(res.value)) {
        for (const ev of res.value) {
          liveEvents.push({
            id: ev.providerId ? `${ev.provider}:${ev.providerId}` : null,
            name: ev.name, category: ev.category, genre: ev.genre,
            starts_at: ev.startsAt, is_free: ev.isFree, min_price: ev.minPrice,
            ticket_url: ev.ticketUrl, image_url: ev.imageUrl,
            lat: ev.venueLat, lng: ev.venueLng, venue_name: ev.venueName, address: ev.venueAddress,
            provider: ev.provider, _src: 'live',
          })
        }
      }
    }
  }

  // merge + dedupe venues (by name+lat) and events (by provider id or name+date)
  const venues = dedupeVenues([...dbVenues, ...googleVenues]).filter(v => {
    return !isBlacklisted(v.name, v.category_slug)
  })
  const events = dedupeEvents([...dbEvents, ...liveEvents])

  return { venues, events, audit }
}

function dedupeVenues(list) {
  const seen = new Set(); const out = []
  for (const v of list) {
    if (!v.name || v.lat == null) continue
    const key = `${v.name.toLowerCase()}|${v.lat.toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key); out.push(v)
  }
  return out
}
function dedupeEvents(list) {
  const seen = new Set(); const out = []
  for (const e of list) {
    if (!e.name || !e.starts_at) continue
    const key = e.id || `${e.name.toLowerCase()}|${new Date(e.starts_at).toDateString()}`
    if (seen.has(key)) continue
    seen.add(key); out.push(e)
  }
  return out
}

// ── Anti-repetition: fetch recent spin keys for this device/user ──
async function getRecentSpins({ deviceId, userId }) {
  const key = userId ? 'user_id' : 'device_id'
  const val = userId || deviceId
  if (!val) return { last: null, last5: new Set(), today: new Set() }
  try {
    const { rows } = await query(
      `SELECT result_key, shown_at FROM roulette_history
       WHERE ${key} = $1 ORDER BY shown_at DESC LIMIT 30`,
      [val]
    )
    const last = rows[0]?.result_key || null
    const last5 = new Set(rows.slice(0, 5).map(r => r.result_key))
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0)
    const today = new Set(rows.filter(r => new Date(r.shown_at) >= startOfDay).map(r => r.result_key))
    return { last, last5, today }
  } catch (e) { logger.error('[roulette] history fetch failed:', e.message); return { last: null, last5: new Set(), today: new Set() } }
}

// Record a spin result so it isn't repeated.
async function recordSpin({ deviceId, userId, resultKey, resultName }) {
  if (!resultKey) return
  try {
    await query(
      `INSERT INTO roulette_history (device_id, user_id, result_key, result_name) VALUES ($1, $2, $3, $4)`,
      [deviceId || null, userId || null, resultKey, resultName || null]
    )
  } catch (e) { logger.error('[roulette] record spin failed:', e.message) }
}

// Store discovered venues/events into the intelligence cache (fire-and-forget).
async function storeIntelligence({ venues = [], events = [] }) {
  try {
    for (const v of venues) {
      if (v._src !== 'google' || !v.name) continue   // only cache freshly-discovered ones
      const sourceKey = `google:${(v.name || '').toLowerCase()}:${v.lat?.toFixed(4)}`
      await query(
        `INSERT INTO venue_intelligence (source_key, name, category, lat, lng, address, rating, rating_count, website, sources)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (source_key) DO UPDATE SET rating=EXCLUDED.rating, rating_count=EXCLUDED.rating_count, last_updated=now()`,
        [sourceKey, v.name, v.category_slug, v.lat, v.lng, v.address, v.rating, v.rating_count, v.website, ['google']]
      ).catch(() => {})
    }
    for (const e of events) {
      if (e._src !== 'live' || !e.name) continue
      const sourceKey = e.id || `${e.provider}:${(e.name || '').toLowerCase()}`
      await query(
        `INSERT INTO event_intelligence (source_key, title, venue_name, lat, lng, address, starts_at, category, genre, ticket_url, image_url, is_free, min_price, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (source_key) DO UPDATE SET starts_at=EXCLUDED.starts_at, last_updated=now()`,
        [sourceKey, e.name, e.venue_name, e.lat, e.lng, e.address, e.starts_at, e.category, e.genre, e.ticket_url, e.image_url, e.is_free, e.min_price, e.provider]
      ).catch(() => {})
    }
  } catch (e) { logger.error('[roulette] store intelligence failed:', e.message) }
}

module.exports = { gatherCandidates, isBlacklisted, haversineKm, getRecentSpins, recordSpin, storeIntelligence }
