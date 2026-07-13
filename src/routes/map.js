// src/routes/map.js
// GET /api/map/discover — "Sappo's live view of the city".
//
// Returns a CURATED, quality-ranked set of map pins (venues + events) around a
// point, normalised into ONE pin shape. The guiding rule from the spec is
// "curated quality, not quantity" — so we rank by SappoScore-style quality and
// return the best ~N pins per the requested filter, never a noisy dump of
// everything. All data is first-party (DB): venues + Skiddle/Ticketmaster
// events already synced. No live external calls.

const express = require('express')
const { query } = require('../db/pool')
const { distanceMeters, repairPhotoUrl } = require('../utils/helpers')
const { fetchVenues } = require('../clients/google')
const { getTimeContext, timeOfDayNudge } = require('../services/timeContext')
const logger = require('../utils/logger')

const router = express.Router()

// Filter → the venue category groups (and/or events) that belong to it.
// Google Places type → our category slug (for live fallback normalisation)
const GOOGLE_TYPE_TO_SLUG = {
  restaurant: 'restaurant', cafe: 'cafe', coffee_shop: 'cafe', bakery: 'bakery',
  bar: 'bar', pub: 'pub', night_club: 'nightclub', brewery: 'brewery',
  tourist_attraction: 'tourist_attraction', museum: 'museum', art_gallery: 'art_gallery',
  park: 'park', historical_landmark: 'landmark', church: 'church',
  meal_takeaway: 'meal_takeaway', fast_food_restaurant: 'restaurant',
  wine_bar: 'bar', cocktail_bar: 'bar',
}
// Google type → FILTER_GROUPS key (so filter chips work on live results too)
const GOOGLE_TYPE_TO_GROUP = {
  restaurant: 'food', cafe: 'cafe', coffee_shop: 'cafe', bakery: 'cafe',
  bar: 'drinks', pub: 'drinks', wine_bar: 'drinks', cocktail_bar: 'drinks', brewery: 'drinks',
  night_club: 'nightlife',
  tourist_attraction: 'tourist', museum: 'tourist', art_gallery: 'tourist',
  historical_landmark: 'tourist', church: 'tourist',
  park: 'scenic',
}

const FILTER_GROUPS = {
  events:      { events: true, venueGroups: [] },
  coffee:      { events: false, venueGroups: ['cafe'] },
  attractions: { events: false, venueGroups: ['tourist'] },
  outdoors:    { events: false, venueGroups: ['scenic'] },
  food:        { events: false, venueGroups: ['food'] },
  drinks:      { events: false, venueGroups: ['drinks'] },
  for_you:     { events: true, venueGroups: ['food', 'drinks', 'tourist', 'scenic', 'cafe'] },  // AI Picks: a curated blend
}

const GROUP_SLUGS = {
  food: ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food', 'brunch', 'diner', 'dessert', 'street_food', 'food_market'],
  cafe: ['cafe', 'coffee_shop', 'bakery'],
  drinks: ['bar', 'pub', 'cocktail_bar', 'wine_bar', 'brewery', 'taproom'],
  nightlife: ['nightclub', 'night_club', 'club', 'dance_club'],
  tourist: ['attraction', 'tourist_attraction', 'landmark', 'historical_landmark', 'museum', 'gallery', 'art_gallery', 'historic_site', 'church', 'zoo', 'aquarium'],
  scenic: ['park', 'viewpoint', 'waterfront', 'garden', 'beach', 'trail', 'walking_route'],
}

function parseJson(v, fb) {
  if (v == null) return fb
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return fb }
}
function parseTags(v) { const t = parseJson(v, []); return Array.isArray(t) ? t : [] }

// Open-now from stored hours (returns true/false/null). Same logic as profile.
function openNowFrom(oh) {
  const h = parseJson(oh, {}) || {}
  if (typeof h.open_now === 'boolean') return h.open_now
  if (typeof h.openNow === 'boolean') return h.openNow
  return null
}

// Quality score for curation (rewards known-good, dampens thin-signal).
function qualityRank(rating, reviews) {
  const r = Number(rating) || 0, n = Number(reviews) || 0
  if (!r) return 0
  const confidence = n / (n + 20)
  return (r - 3.4) * 22 * confidence + Math.min(n / 400, 6)
}

// Map a venue's category_slug to a pin category + type label.
function venueCategoryLabel(slug) {
  const s = (slug || '').toLowerCase()
  if (GROUP_SLUGS.cafe.includes(s)) return 'Café'
  if (GROUP_SLUGS.food.includes(s)) return 'Restaurant'
  if (GROUP_SLUGS.drinks.includes(s)) return 'Bar'
  if (GROUP_SLUGS.nightlife.includes(s)) return 'Nightlife'
  if (GROUP_SLUGS.tourist.includes(s)) return 'Attraction'
  if (GROUP_SLUGS.scenic.includes(s)) return 'Outdoors'
  return 'Place'
}

// Build a short, honest AI-style reason for a pin (no LLM call — templated from
// the real signals, same spirit as the roulette "why").
function pinReason({ tags, rating, openNow, isEvent, eventSoon, timeCtx, groups }) {
  if (isEvent) return eventSoon ? 'On soon nearby — a great pick for tonight.' : 'A standout event coming up near you.'
  if (tags.includes('hidden_gem')) return 'A genuine hidden gem loved by locals.'
  if (tags.includes('local_favourite')) return 'A local favourite worth a visit.'
  if (rating >= 4.6) return 'Consistently brilliant and highly rated.'
  const isScenic = groups && groups.has && groups.has('scenic')
  if (isScenic && timeCtx && timeCtx.daylight > 0.6) return 'Lovely while the light lasts.'
  if (rating >= 4.2) return 'Well rated and worth a look.'
  return 'A solid pick near you right now.'
}

router.get('/discover', async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat)
    const lng = parseFloat(req.query.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required' })
    }
    const radius = Math.min(parseInt(req.query.radius || '3000'), 20000)
    const filterKey = (req.query.filter || 'for_you').toLowerCase()
    const filter = FILTER_GROUPS[filterKey] || FILTER_GROUPS.for_you
    const city = req.query.city || null
    const weatherAware = String(req.query.weatherAware || 'true') !== 'false'
    // Curation cap — keep the map calm. AI Picks stays tightest.
    const maxPins = Math.min(parseInt(req.query.limit || (filterKey === 'for_you' ? '18' : '30')), 60)

    // Time context for time-appropriate curation (favours scenic by day,
    // bars/events by evening) — the "feels intelligent" part.
    const tz = Math.round(lng / 15)
    const timeCtx = getTimeContext(new Date(), lat, lng, tz)

    // Bounding box for a cheap first-pass spatial filter (refined by haversine).
    const dLat = radius / 111320
    const dLng = radius / (111320 * Math.cos((lat * Math.PI) / 180))

    const pins = []

    // ── Venues ──
    if (filter.venueGroups.length) {
      const slugs = [...new Set(filter.venueGroups.flatMap(g => GROUP_SLUGS[g] || []))]
      const params = [slugs, lat - dLat, lat + dLat, lng - dLng, lng + dLng]
      let where = `category_slug = ANY($1) AND business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'
                   AND lat BETWEEN $2 AND $3 AND lng BETWEEN $4 AND $5`
      if (city) { params.push(city); where += ` AND city = $${params.length}` }
      const { rows } = await query(
        `SELECT id,name,category_slug,lat,lng,rating,rating_count,price_level,cover_photo,photos,gem_tags,opening_hours
           FROM venues WHERE ${where} LIMIT 500`, params
      ).catch(e => { logger.error('[map] venue query failed: ' + e.message); return { rows: [] } })

      for (const v of rows) {
        const dist = Math.round(distanceMeters(lat, lng, v.lat, v.lng))
        if (dist > radius) continue
        const rating = Number(v.rating) || 0
        const reviews = Number(v.rating_count) || 0
        // Quality floor: keep the map curated. Drop KNOWN-poor venues (real low
        // rating with enough reviews to trust it). Unrated venues are kept
        // (no data ≠ bad) but rank low.
        if (rating > 0 && rating < 3.4 && reviews >= 20) continue
        const tags = parseTags(v.gem_tags)
        let score = qualityRank(rating, v.rating_count)
        // Time-appropriateness nudge (curation, not a filter).
        if (weatherAware) {
          const groups = new Set(filter.venueGroups.filter(g => (GROUP_SLUGS[g] || []).includes((v.category_slug || '').toLowerCase())))
          score += timeOfDayNudge(groups, timeCtx).nudge * 0.3
        }
        // Slight proximity bias so closer good things win ties.
        score += Math.max(0, 4 - dist / 1000)
        if (tags.includes('hidden_gem')) score += 6

        const cover = repairPhotoUrl(v.cover_photo || (parseJson(v.photos, [])[0]?.url) || null)
        const openNow = openNowFrom(v.opening_hours)
        // The venue's OWN category groups (not the filter's) — so the reason
        // fits the actual place (a café never gets a "scenic" reason).
        const slug = (v.category_slug || '').toLowerCase()
        const ownGroups = new Set(Object.keys(GROUP_SLUGS).filter(g => GROUP_SLUGS[g].includes(slug)))
        pins.push({
          _score: score,
          pin: {
            id: `v_${v.id}`, venueId: v.id, type: 'venue', source: 'sappo',
            name: v.name, category: venueCategoryLabel(v.category_slug),
            latitude: v.lat, longitude: v.lng, imageUrl: cover,
            rating: rating || null, distanceMeters: dist,
            openNow, eventTime: null,
            price: v.price_level != null ? '£'.repeat(Math.max(1, Number(v.price_level))) : null,
            aiReason: pinReason({ tags, rating, openNow, isEvent: false, timeCtx, groups: ownGroups }),
            bookingUrl: null, tags,
          },
        })
      }
    }

    // ── Events ──
    if (filter.events) {
      const params = [lat - dLat, lat + dLat, lng - dLng, lng + dLng]
      let where = `e.status='active' AND e.starts_at >= now() AND e.starts_at <= now() + interval '14 days'
                   AND v.lat BETWEEN $1 AND $2 AND v.lng BETWEEN $3 AND $4`
      if (city) { params.push(city); where += ` AND v.city = $${params.length}` }
      const { rows } = await query(
        `SELECT e.id,e.name,e.category,e.genre,e.starts_at,e.is_free,e.min_price,e.ticket_url,e.image_url,
                v.lat,v.lng,v.name AS venue_name
           FROM events e JOIN venues v ON v.id = e.venue_id
          WHERE ${where}
          ORDER BY e.starts_at ASC LIMIT 200`, params
      ).catch(e => { logger.error('[map] event query failed: ' + e.message); return { rows: [] } })

      const now = Date.now()
      for (const e of rows) {
        if (e.lat == null) continue
        const dist = Math.round(distanceMeters(lat, lng, e.lat, e.lng))
        if (dist > radius) continue
        const startsMs = new Date(e.starts_at).getTime()
        const hrsAway = (startsMs - now) / 3600000
        const eventSoon = hrsAway >= 0 && hrsAway <= 12
        // Events curated by soonness + proximity.
        let score = 40 + (eventSoon ? 30 : hrsAway <= 48 ? 18 : 6) + Math.max(0, 6 - dist / 1000)
        const when = new Date(e.starts_at)
        pins.push({
          _score: score,
          pin: {
            id: `e_${e.id}`, eventId: e.id, type: 'event', source: 'skiddle',
            name: e.name, category: e.genre || e.category || 'Event',
            latitude: e.lat, longitude: e.lng, imageUrl: repairPhotoUrl(e.image_url),
            rating: null, distanceMeters: dist,
            openNow: null,
            eventTime: when.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
            price: e.is_free ? 'Free' : (e.min_price != null ? `£${Number(e.min_price)}` : null),
            aiReason: pinReason({ tags: [], isEvent: true, eventSoon }),
            bookingUrl: e.ticket_url || null,
            tags: [e.genre, eventSoon ? 'tonight' : null].filter(Boolean).map(t => String(t).toLowerCase()),
          },
        })
      }
    }

    // ── Live Google fallback — fires only when DB has <5 results nearby ──────────
    // Cost: ~16 Google API requests (one per place type). Only triggers in
    // areas with no synced data. Results are normalised to the same pin shape
    // so the frontend sees no difference.
    const venuesFromDB = pins.filter(p => p.pin.type === 'venue').length
    if (venuesFromDB < 5 && filter.venueGroups.length > 0) {
      try {
        logger.info(`[map] DB returned ${venuesFromDB} venues near ${lat.toFixed(3)},${lng.toFixed(3)} — falling back to live Google`)
        const liveTypes = filter.venueGroups.flatMap(g => {
          const typeMap = { food: ['restaurant','cafe','bakery'], cafe: ['cafe','coffee_shop'],
            drinks: ['bar','pub','wine_bar'], tourist: ['tourist_attraction','museum','art_gallery','park','historical_landmark'],
            scenic: ['park'], nightlife: ['night_club'] }
          return typeMap[g] || []
        })
        const uniqueTypes = [...new Set(liveTypes)]
        const liveVenues = await fetchVenues(lat, lng, radius, { types: uniqueTypes, parallel: true, timeoutMs: 8000 })
        for (const v of liveVenues) {
          const vLat = v.location?.latitude ?? v.lat
          const vLng = v.location?.longitude ?? v.lng
          if (vLat == null || vLng == null) continue
          const dist = Math.round(distanceMeters(lat, lng, vLat, vLng))
          if (dist > radius) continue
          const rating = Number(v.rating) || 0
          if (rating > 0 && rating < 3.4 && Number(v.ratingCount) >= 20) continue
          const slug = GOOGLE_TYPE_TO_SLUG[v.primaryType] || v.primaryType || 'place'
          const group = GOOGLE_TYPE_TO_GROUP[v.primaryType] || 'tourist'
          // Skip if filter doesn't include this group (respect the active chip)
          if (!filter.venueGroups.includes(group) && filterKey !== 'for_you') continue
          const cover = repairPhotoUrl(v.photos?.[0]?.url || null)
          const score = qualityRank(rating, v.ratingCount) + Math.max(0, 4 - dist / 1000)
          pins.push({
            _score: score,
            pin: {
              id: `g_${v.providerId || v.googlePlaceId || (vLat + ',' + vLng)}`,
              venueId: null, type: 'venue', source: 'google_live',
              name: v.name, category: venueCategoryLabel(slug),
              latitude: vLat, longitude: vLng, imageUrl: cover,
              rating: rating || null, distanceMeters: dist,
              openNow: v.businessStatus === 'OPERATIONAL' ? true : null,
              eventTime: null,
              price: v.priceLevel != null ? '£'.repeat(Math.max(1, Number(v.priceLevel))) : null,
              aiReason: pinReason({ tags: [], rating, openNow: null, isEvent: false, timeCtx, groups: new Set([group]) }),
              bookingUrl: null, tags: [],
              // Carry enough data so resolveVenueProfile can create a DB record on tap
              _liveData: { name: v.name, address: v.address, lat: vLat, lng: vLng,
                googlePlaceId: v.googlePlaceId || v.providerId, category: slug,
                rating, ratingCount: v.ratingCount, phone: v.phone, website: v.website,
                photos: v.photos || [], priceLevel: v.priceLevel }
            },
          })
        }
        logger.info(`[map] live Google added ${liveVenues.length} venues → total pins: ${pins.length}`)
      } catch (e) {
        logger.error('[map] live Google fallback failed:', e.message)
      }
    }

    // Curate: rank by score, cap to maxPins. This is the "quality not quantity"
    // rule — the map shows the best pins, not every dot.
    const curated = pins
      .sort((a, b) => b._score - a._score)
      .slice(0, maxPins)
      .map(p => p.pin)

    res.json({
      center: { lat, lng },
      radius,
      filter: filterKey,
      timeOfDay: timeCtx.daypart,
      count: curated.length,
      pins: curated,
    })
  } catch (err) { next(err) }
})

module.exports = router
