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

// Race a promise against a hard wall-clock deadline. On timeout, resolve with fallback.
function withDeadline(promise, ms, fallback, label) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => { logger.warn(`[roulette] ${label} hit ${ms}ms deadline`); resolve(fallback) }, ms)),
  ])
}

// ── simple in-memory cache (per-process). Keyed by city+area+radius. ──
// Venues change slowly (cache 6h), events change faster (cache 30min).
const _cache = new Map()
const VENUE_TTL = 6 * 3600 * 1000
const EVENT_TTL = 30 * 60 * 1000
function cacheKey({ cityName, lat, lng, radiusMiles }) {
  const rl = lat != null ? lat.toFixed(2) : 'x'   // ~1km buckets
  const rg = lng != null ? lng.toFixed(2) : 'x'
  return `${cityName}|${rl}|${rg}|${radiusMiles}`
}

function normaliseGoogleCategory(cat) {
  const c = String(cat || '').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_')
  return ({
    night_club: 'night_club',
    tourist_attraction: 'tourist_attraction',
    art_gallery: 'art_gallery',
    historical_landmark: 'historical_landmark',
    performing_arts_theater: 'theatre',
    bakery: 'bakery',
    meal_takeaway: 'meal_takeaway',
    meal_delivery: 'meal_delivery',
  })[c] || c
}

// Gather candidates from ALL sources, with a per-source audit.
// Returns { venues:[], events:[], audit:{} }
async function gatherCandidates({ lat, lng, cityName, cats, radiusMiles = 5, googleTypes = null }) {
  const audit = {
    googlePlaces: { sent: false, ok: false, count: 0 },
    dbVenues: { count: 0 },
    skiddle: { sent: false, ok: false, count: 0 },
    ticketmaster: { sent: false, ok: false, count: 0 },
    eventbrite: { sent: false, ok: false, count: 0 },
    dbEvents: { count: 0 },
  }
  const TIMEOUT = 2500   // per-API cap (spec: 2500ms)

  // ── CACHE FAST PATH: if both venues & events are fresh, return instantly ──
  const ckey = cacheKey({ cityName, lat, lng, radiusMiles })
  const cv = _cache.get('v:' + ckey)
  const ce = _cache.get('e:' + ckey)
  if (cv && ce && (Date.now() - cv.at < VENUE_TTL) && (Date.now() - ce.at < EVENT_TTL)) {
    audit.cached = true
    return { venues: cv.data, events: ce.data, audit }
  }

  // ---- DB reads (fast, local) run in parallel with each other ----
  const dbVenuesP = query(
    `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng, opening_hours, website
     FROM venues WHERE city = $1 AND name IS NOT NULL AND category_slug = ANY($2) LIMIT 400`,
    [cityName, cats]
  ).then(r => r.rows.map(v => ({ ...v, _src: 'db' }))).catch(e => { logger.error('[roulette] db venues failed:', e.message); return [] })

  const dbEventsP = query(
    `SELECT e.id, e.name, e.category, e.genre, e.starts_at, e.is_free, e.min_price, e.ticket_url,
            e.image_url, v.lat, v.lng, v.name AS venue_name, v.address,
            (SELECT provider FROM event_sources es WHERE es.event_id = e.id LIMIT 1) AS provider
     FROM events e LEFT JOIN venues v ON v.id = e.venue_id
     WHERE v.city = $1 AND e.starts_at >= now() AND e.starts_at <= now() + interval '21 days'
       AND e.status = 'active' ORDER BY e.starts_at ASC LIMIT 80`,
    [cityName]
  ).then(r => r.rows.map(e => ({ ...e, _src: 'db' }))).catch(e => { logger.error('[roulette] db events failed:', e.message); return [] })

  // ---- LIVE API calls — ALL in parallel, each capped at TIMEOUT ----
  const haveGPS = lat != null && lng != null
  const googleP = haveGPS ? (async () => {
    audit.googlePlaces.sent = true
    const radiusM = Math.min(radiusMiles * 1609, 20000)
    const types = googleTypes || ['restaurant', 'cafe', 'bar', 'pub', 'tourist_attraction', 'museum', 'art_gallery', 'park']
    const fetched = await google.fetchVenues(lat, lng, radiusM, { types, parallel: true, timeoutMs: TIMEOUT })
    audit.googlePlaces.ok = true; audit.googlePlaces.count = fetched.length
    return fetched.map(v => ({
      id: null,
      provider_id: v.providerId || null,
      name: v.name,
      category_slug: normaliseGoogleCategory(v.category || v.primaryType || 'other'),
      google_types: v.types || [],
      rating: v.rating || null,
      rating_count: v.userRatingCount || v.ratingCount || v.rating_count || null,
      price_level: v.priceLevel || v.price_level || null,
      address: v.formattedAddress || v.address || null,
      lat: v.location?.latitude ?? v.lat,
      lng: v.location?.longitude ?? v.lng,
      opening_hours: v.regularOpeningHours || v.opening_hours || null,
      website: v.websiteUri || v.website || null,
      photos: v.photos || [],
      _src: 'google',
    }))
  })() : Promise.resolve([])

  const skiddleP = haveGPS ? (async () => {
    audit.skiddle.sent = true
    const r = await skiddle.fetchEvents(lat, lng, radiusMiles, 30, { maxResults: 150, timeoutMs: TIMEOUT })
    audit.skiddle.ok = true; audit.skiddle.count = r.length; return r
  })() : Promise.resolve([])

  const tmP = haveGPS ? (async () => {
    audit.ticketmaster.sent = true
    const r = await ticketmaster.fetchEvents(lat, lng, radiusMiles, 30, { maxResults: 100, maxPages: 2, timeoutMs: TIMEOUT })
    audit.ticketmaster.ok = true; audit.ticketmaster.count = r.length; return r
  })() : Promise.resolve([])

  const ebP = haveGPS ? (async () => {
    audit.eventbrite.sent = true
    const r = await eventbrite.fetchEvents(lat, lng, radiusMiles)
    audit.eventbrite.ok = true; audit.eventbrite.count = r.length; return r
  })() : Promise.resolve([])

  // wait for EVERYTHING together — each live API has a hard 3s wall-clock deadline
  const DEADLINE = 3000
  const [dbVenues, dbEvents, gRes, skRes, tmRes, ebRes] = await Promise.all([
    dbVenuesP, dbEventsP,
    withDeadline(googleP, DEADLINE, [], 'google').catch(e => { logger.error('[roulette] google failed:', e.message); audit.googlePlaces.ok = false; return [] }),
    withDeadline(skiddleP, DEADLINE, [], 'skiddle').catch(e => { logger.error('[roulette] skiddle failed:', e.message); audit.skiddle.ok = false; return [] }),
    withDeadline(tmP, DEADLINE, [], 'ticketmaster').catch(e => { logger.error('[roulette] ticketmaster failed:', e.message); audit.ticketmaster.ok = false; return [] }),
    withDeadline(ebP, DEADLINE, [], 'eventbrite').catch(e => { logger.error('[roulette] eventbrite failed:', e.message); audit.eventbrite.ok = false; return [] }),
  ])
  audit.dbVenues.count = dbVenues.length
  audit.dbEvents.count = dbEvents.length

  // normalise live events to our shape
  const liveEvents = []
  for (const arr of [skRes, tmRes, ebRes]) {
    for (const ev of arr) {
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

  const venues = dedupeVenues([...dbVenues, ...gRes]).filter(v => !isBlacklisted(v.name, v.category_slug))
  const events = dedupeEvents([...dbEvents, ...liveEvents])

  // store in cache (venues + events separately so TTLs differ)
  const ck = cacheKey({ cityName, lat, lng, radiusMiles })
  _cache.set('v:' + ck, { at: Date.now(), data: venues })
  _cache.set('e:' + ck, { at: Date.now(), data: events })

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
