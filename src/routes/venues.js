const express = require('express')
const { query } = require('../db/pool')
const { distanceMeters, normaliseName } = require('../utils/helpers')
const { repairVenuePhotos } = require('../utils/helpers')
const { nearbySearch } = require('../services/nearbySearch')
const { fetchVenues, findPlaceDetails } = require('../clients/google')
const logger = require('../utils/logger')
const { getVenueProfile, syncTripAdvisorForVenue, syncTripAdvisorBatch, syncGoogleForVenue, syncGoogleBatch, refreshGemTags } = require('../services/venueProfile')
const { classifyIntent } = require('../services/searchIntent')
const { buildSearchResults } = require('../services/searchResults')
const { scheduleVenueEnrichment, getQueueStatus } = require('../services/backgroundEnrichment')
const { upsertVenue } = require('../services/sync')
const router = express.Router()

// GET /venues/test-google — quick health check for the Places API (New).
// Hit this in a browser after enabling Places API (New) to confirm it works.
// GET /venues/debug/counts?city=Liverpool
// Shows how many venues are actually in the DB per category — diagnoses a sparse DB.
// GET /venues/debug/enrichment?city=Liverpool
// Shows the TRUTH about enrichment: how many venues were checked vs actually have data.
// Diagnoses "it jumped to 0" — tells us if venues were marked checked without being enriched.
router.get('/debug/enrichment', async (req, res) => {
  try {
    const city = req.query.city || 'Liverpool'
    const r = await query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE google_last_checked IS NOT NULL)::int AS google_checked,
         COUNT(*) FILTER (WHERE google_place_id IS NOT NULL)::int AS has_google_id,
         COUNT(*) FILTER (WHERE rating IS NOT NULL)::int AS has_rating,
         COUNT(*) FILTER (WHERE cover_photo IS NOT NULL)::int AS has_photo,
         COUNT(*) FILTER (WHERE google_last_checked IS NULL)::int AS never_checked,
         COUNT(*) FILTER (WHERE tripadvisor_last_checked IS NOT NULL)::int AS ta_checked,
         COUNT(*) FILTER (WHERE tripadvisor_rating IS NOT NULL)::int AS has_ta_rating
       FROM venues WHERE city = $1`,
      [city]
    )
    const d = r.rows[0]
    return res.json({
      city,
      ...d,
      reading: {
        google: `${d.has_google_id}/${d.total} matched to Google, ${d.has_photo} have photos, ${d.has_rating} have ratings`,
        stillToCheck: `${d.never_checked} venues never checked by Google yet`,
        tripadvisor: `${d.has_ta_rating}/${d.total} have TripAdvisor ratings`,
      },
    })
  } catch (e) { return res.json({ error: e.message }) }
})

router.get('/debug/counts', async (req, res) => {
  try {
    const city = req.query.city || 'Liverpool'
    const byCat = await query(
      `SELECT category_slug, COUNT(*)::int AS n FROM venues WHERE city = $1 GROUP BY category_slug ORDER BY n DESC`,
      [city]
    )
    const total = await query(`SELECT COUNT(*)::int AS n FROM venues WHERE city = $1`, [city])
    const bySource = await query(
      `SELECT vs.provider, COUNT(DISTINCT vs.venue_id)::int AS n
       FROM venue_sources vs JOIN venues v ON v.id = vs.venue_id
       WHERE v.city = $1 GROUP BY vs.provider ORDER BY n DESC`,
      [city]
    )
    const lastSync = await query(
      `SELECT status, venues_added, venues_updated, started_at, finished_at
       FROM sync_log WHERE city = $1 ORDER BY id DESC LIMIT 1`,
      [city]
    )
    return res.json({
      city,
      totalVenues: total.rows[0]?.n || 0,
      byCategory: byCat.rows,
      bySource: bySource.rows,
      lastSync: lastSync.rows[0] || 'never run',
      hint: 'Low numbers + Google as the only source = run a full sync. Google caps at 20/type; OSM & Foursquare add the bulk.',
    })
  } catch (e) {
    return res.json({ error: e.message })
  }
})

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


function placeTypeToCategory(input) {
  const t = String(input || '').toLowerCase()
  if (['park', 'garden', 'campground'].includes(t)) return t === 'garden' ? 'garden' : 'park'
  if (t.includes('museum')) return 'museum'
  if (t.includes('art_gallery')) return 'gallery'
  if (t.includes('historical') || t.includes('landmark') || t.includes('church')) return 'historic'
  if (t.includes('movie_theater')) return 'cinema'
  if (t.includes('performing_arts') || t.includes('theater')) return 'theatre'
  if (t.includes('night_club')) return 'nightclub'
  if (t.includes('bar')) return 'bar'
  if (t.includes('pub')) return 'pub'
  if (t.includes('cafe')) return 'cafe'
  if (t.includes('bakery') || t.includes('breakfast')) return 'cafe'
  if (t.includes('restaurant') || t.includes('meal')) return 'restaurant'
  if (t.includes('tourist_attraction') || t.includes('point_of_interest')) return 'attraction'
  return 'other'
}

function buildUpsertVenueFromPayload(payload = {}, details = null) {
  const d = details || {}
  const rawTypes = d.types || payload.types || []
  const primaryType = d.primaryType || payload.primaryType || payload.type || payload.category || rawTypes[0] || null
  const category = placeTypeToCategory(primaryType)
  const googlePlaceId = d.googlePlaceId || d.providerId || payload.googlePlaceId || payload.google_place_id || payload.place_id || null
  const name = d.name || payload.name || payload.title
  const lat = d.lat ?? payload.lat
  const lng = d.lng ?? payload.lng
  return {
    name,
    normalisedName: normaliseName(name || ''),
    category,
    lat,
    lng,
    address: d.address || payload.address || payload.location || null,
    postcode: payload.postcode || null,
    phone: d.phone || payload.phone || null,
    website: d.website || payload.website || null,
    rating: d.rating ?? payload.rating ?? payload.googleRating ?? null,
    ratingCount: d.ratingCount ?? payload.rating_count ?? payload.ratingCount ?? payload.googleReviewCount ?? null,
    priceLevel: d.priceLevel ?? payload.price_level ?? payload.priceLevel ?? null,
    openingHours: d.openingHours || payload.opening_hours || payload.openingHours || null,
    businessStatus: d.businessStatus || payload.business_status || payload.businessStatus || null,
    photos: d.photos || payload.photos || (payload.cover_photo ? [{ url: payload.cover_photo, source: 'sappo' }] : []),
    coverPhoto: (d.photos && d.photos[0] && (d.photos[0].url || d.photos[0])) || payload.cover_photo || payload.photoUrl || payload.image || null,
    googlePlaceId,
    google_maps_url: d.googleMapsUrl || payload.google_maps_url || payload.googleMapsUrl || payload.mapUrl || null,
    sources: googlePlaceId ? [{ provider: 'google', providerId: googlePlaceId, raw: d.raw || payload.raw || payload }] : [],
  }
}

async function findExistingVenue(payload = {}) {
  const googlePlaceId = payload.googlePlaceId || payload.google_place_id || payload.place_id || null
  if (googlePlaceId) {
    const bySource = await query(
      `SELECT v.* FROM venue_sources vs JOIN venues v ON v.id=vs.venue_id WHERE vs.provider='google' AND vs.provider_id=$1 LIMIT 1`,
      [googlePlaceId]
    )
    if (bySource.rows[0]) return bySource.rows[0]
    const byPlace = await query(`SELECT * FROM venues WHERE google_place_id=$1 LIMIT 1`, [googlePlaceId])
    if (byPlace.rows[0]) return byPlace.rows[0]
  }
  const name = payload.name || payload.title
  if (!name) return null
  const params = [normaliseName(name)]
  let where = `normalised_name = $1`
  if (payload.city) { params.push(payload.city); where += ` AND city = $${params.length}` }
  const exact = await query(`SELECT * FROM venues WHERE ${where} ORDER BY rating_count DESC NULLS LAST LIMIT 1`, params)
  if (exact.rows[0]) return exact.rows[0]

  const fuzzyParams = [`%${name}%`]
  let fuzzyWhere = `name ILIKE $1`
  if (payload.city) { fuzzyParams.push(payload.city); fuzzyWhere += ` AND city = $${fuzzyParams.length}` }
  const fuzzy = await query(`SELECT * FROM venues WHERE ${fuzzyWhere} ORDER BY rating_count DESC NULLS LAST LIMIT 1`, fuzzyParams)
  if (fuzzy.rows[0]) return fuzzy.rows[0]
  return null
}

// POST /venues/resolve-profile
// Resolve/create an internal SAPPO venue profile from Roulette/AI/Google results.
// This is the single safe entry point for cards that do not already have a SAPPO venue id.
router.post('/resolve-profile', async (req, res, next) => {
  try {
    const payload = req.body || {}
    const name = payload.name || payload.title
    if (!name && !(payload.googlePlaceId || payload.google_place_id || payload.place_id)) {
      return res.status(400).json({ error: 'name or googlePlaceId required' })
    }

    const existing = await findExistingVenue(payload)
    if (existing?.id) {
      scheduleVenueEnrichment(existing.id, 'resolve_existing')
      return res.json({ status: 'resolved_existing', venueId: existing.id, venue: existing })
    }

    const placeId = payload.googlePlaceId || payload.google_place_id || payload.place_id || null
    const queryText = placeId
      ? null
      : [name, payload.address, payload.city].filter(Boolean).join(', ')
    const details = placeId
      ? await require('../clients/google').getPlaceDetails(placeId).catch(() => null)
      : await findPlaceDetails(queryText).catch(() => null)

    const upsert = buildUpsertVenueFromPayload(payload, details)
    if (!upsert.name || upsert.lat == null || upsert.lng == null) {
      return res.status(422).json({ error: 'Could not create profile: missing name/coordinates', detailsFound: !!details })
    }
    const city = payload.city || upsert.city || 'Liverpool'
    const result = await upsertVenue(upsert, city)
    if (result?.id) {
      scheduleVenueEnrichment(result.id, 'resolve_created')
      const { rows } = await query(`SELECT * FROM venues WHERE id=$1`, [result.id])
      return res.json({ status: result.isNew ? 'created' : 'resolved_upsert', venueId: result.id, venue: rows[0] || { id: result.id, name: upsert.name } })
    }
    return res.status(500).json({ error: 'Could not create profile' })
  } catch (err) { next(err) }
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
    res.json({ count: result.length, venues: result.map(v => repairVenuePhotos(v)) })
  } catch (err) { next(err) }
})

// GET /venues/search?q=berry+rye&city=Liverpool&lat=..&lng=..&limit=15
// Dedicated name search for the search bar: type a venue name, get the best
// matches ranked by relevance (exact > prefix > fuzzy), then quality, then
// (optionally) proximity. Typo-tolerant via pg_trgm similarity. Location is
// optional — search works anywhere, and just nudges ties toward what's near.
// GET /venues/smart-search?q=date+night&city=Liverpool&lat=..&lng=..
// The unified search endpoint the search bar calls. Classifies intent, resolves
// venue-name-vs-category, and returns a BLENDED, sectioned result — all from the
// DB. The user just sees great results; the intent machinery is invisible.
router.get('/smart-search', async (req, res, next) => {
  try {
    const raw = (req.query.q || req.query.search || '').toString().trim()
    const city = req.query.city || null
    const lat = req.query.lat ? parseFloat(req.query.lat) : null
    const lng = req.query.lng ? parseFloat(req.query.lng) : null

    if (raw.length < 2) {
      return res.json({ query: raw, intent: 'empty', sections: [], note: 'Type to search.' })
    }

    const intent = classifyIntent(raw)

    // Surprise → tell the frontend to route to Sappo (roulette/discovery).
    if (intent.intent === 'surprise') {
      return res.json({ query: raw, intent: 'surprise', routeTo: 'sappo', sections: [], say: 'Feeling spontaneous? Let Sappo pick for you.' })
    }

    // Resolve venue-name-vs-category: for short queries that might be a specific
    // place ("Sefton Park"), check for a strong exact venue match first. If we
    // find one, surface it as a top "Best match" section before any category blend.
    let topMatchSection = null
    if (intent.intent === 'venue_lookup' || intent.maybeVenueName) {
      const nq = normaliseName(raw)
      const { rows } = await query(
        `SELECT id,name,category_slug,lat,lng,address,city,rating,rating_count,price_level,cover_photo,photos,gem_tags,
                similarity(normalised_name, $1) AS sim, (normalised_name = $1) AS exact
           FROM venues
          WHERE (normalised_name % $1 OR normalised_name LIKE $2)
            AND business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'
            ${city ? 'AND city = $3' : ''}
          ORDER BY (normalised_name = $1) DESC, similarity(normalised_name, $1) DESC
          LIMIT 3`,
        city ? [nq, `%${nq}%`, city] : [nq, `%${nq}%`]
      ).catch(() => ({ rows: [] }))
      const strong = rows.filter(r => r.exact || Number(r.sim) >= 0.65)
      if (strong.length) {
        const items = strong.map(v => {
          const { normalised_name, sim, exact, gem_tags, ...rest } = v
          const out = repairVenuePhotos(rest)
          out.tags = (() => { try { return Array.isArray(gem_tags) ? gem_tags : JSON.parse(gem_tags || '[]') } catch { return [] } })()
          return out
        })
        topMatchSection = { key: 'best_match', title: 'Best Match', icon: '📍', type: 'venues', items }
        if (intent.intent === 'venue_lookup') {
          return res.json({ query: raw, intent: 'venue_lookup', autoJumpVenueId: strong[0].exact ? strong[0].id : null, sections: [topMatchSection] })
        }
      }
    }

    const { sections, meta } = await buildSearchResults(intent, { city, lat, lng })
    const allSections = topMatchSection ? [topMatchSection, ...sections] : sections

    res.json({
      query: raw,
      intent: intent.intent,
      vibe: intent.vibe || null,
      needsAI: intent.needsAI || false,
      routeTo: intent.intent === 'itinerary' ? 'plan' : null,
      sections: allSections,
      meta,
    })
  } catch (err) { next(err) }
})

// Detect whether a search string is a BARE venue lookup ("Sefton Park") or a
// REQUEST that happens to mention things ("somewhere a bit like Sefton Park").
// This is what stops the search bar slamming Sefton Park in the user's face
// when they actually wanted somewhere similar. Pure string logic — no AI call.
const REQUEST_PHRASES = [
  'like ', 'similar to', 'somewhere', 'something', 'a place', 'place like', 'places',
  'near ', 'close to', 'around ', 'nearby', 'by the', 'next to',
  'what\'s on', 'whats on', 'what is on', 'things to do', 'to do in', 'to do near',
  'where can', 'where should', 'where to', 'can i', 'should i', 'i want', 'i fancy',
  'looking for', 'suggest', 'recommend', 'find me', 'find us', 'show me somewhere',
  'good for', 'best place', 'best places', 'a bit like', 'kind of', 'sort of',
  'vibe', 'atmosphere', 'cheap', 'romantic', 'fun', 'quiet', 'lively', 'tonight',
  'this weekend', 'for a date', 'with kids', 'with friends', 'for lunch', 'for dinner',
  'for drinks', 'for coffee', 'anywhere', 'options', 'ideas',
]
function looksLikeRequest(rawInput) {
  // Normalise curly/smart apostrophes (phones autocorrect to these) so phrase
  // matching works on real mobile input.
  const s = ' ' + rawInput.toLowerCase().replace(/[''`]/g, "'").trim() + ' '
  // Any request phrase present → it's a request, not a bare lookup.
  for (const p of REQUEST_PHRASES) {
    if (s.includes(p)) return true
  }
  // Question mark, or lots of words, also signals a request rather than a name.
  if (rawInput.includes('?')) return true
  const wordCount = rawInput.trim().split(/\s+/).length
  if (wordCount >= 7) return true          // venue names are rarely this long
  return false
}

router.get('/search', async (req, res, next) => {
  try {
    const raw = (req.query.q || req.query.search || '').toString().trim()
    if (raw.length < 2) {
      return res.json({ count: 0, venues: [], note: 'Type at least 2 characters to search.' })
    }
    const qNorm = normaliseName(raw)              // normalise the SAME way stored names are
    if (!qNorm) return res.json({ count: 0, venues: [] })

    const isRequest = looksLikeRequest(raw)
    const city = req.query.city || null
    const lat = req.query.lat ? parseFloat(req.query.lat) : null
    const lng = req.query.lng ? parseFloat(req.query.lng) : null
    const limit = Math.min(parseInt(req.query.limit || '15'), 50)

    const params = [qNorm, `${qNorm}%`, `%${qNorm}%`]
    let cityWhere = ''
    if (city) { params.push(city); cityWhere = `AND city = $${params.length}` }

    // Candidate set: anything with a trigram similarity above a low floor, OR a
    // substring match (so short exact queries always surface). The trigram index
    // on normalised_name makes similarity() fast.
    const sql = `
      SELECT id, name, category_slug, lat, lng, address, city, rating, rating_count,
             price_level, cover_photo, photos, gem_tags,
             normalised_name,
             similarity(normalised_name, $1) AS sim,
             (normalised_name = $1) AS exact_match,
             (normalised_name LIKE $2) AS prefix_match,
             (normalised_name LIKE $3) AS substr_match
        FROM venues
       WHERE business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'
         AND (normalised_name % $1 OR normalised_name LIKE $3)
         ${cityWhere}
       LIMIT 200`
    const { rows } = await query(sql, params)

    // Rank in JS so we can blend the signals cleanly.
    const scored = rows.map(v => {
      let score = 0
      if (v.exact_match) score += 100
      if (v.prefix_match) score += 40
      if (v.substr_match) score += 25
      score += (Number(v.sim) || 0) * 30                       // fuzzy closeness (0..1 → 0..30)
      // Quality tiebreaker: well-rated, well-reviewed places float up.
      const rating = Number(v.rating) || 0
      const reviews = Number(v.rating_count) || 0
      if (reviews >= 20) score += Math.min((rating - 3.5) * 3, 6) + Math.min(reviews / 500, 4)
      // Optional proximity nudge (never a filter): closer = a small bump.
      let distance_m = null
      if (lat != null && lng != null && v.lat != null && v.lng != null) {
        distance_m = Math.round(distanceMeters(lat, lng, v.lat, v.lng))
        score += Math.max(0, 6 - distance_m / 1000)            // up to +6 within ~6km
      }
      return { v, score, distance_m }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

    const ranked = scored.map(({ v, score, distance_m }) => {
      const { normalised_name, ...rest } = v
      const out = repairVenuePhotos(rest)
      if (distance_m != null) out.distance_m = distance_m
      out._score = score
      out._exact = v.exact_match || v.prefix_match
      return out
    })

    // Auto-jump decision: take the user STRAIGHT to a venue only when we're
    // confident it's a bare lookup of a specific place — i.e. NOT request-phrased
    // ("somewhere like Sefton Park" must NOT auto-jump), and the top match is
    // clearly ahead of the rest (a decisive winner, not a toss-up).
    const top = ranked[0]
    const second = ranked[1]
    const decisiveLead = top && (!second || (top._score - second._score) >= 30)
    const strongTop = top && (top._exact || top._score >= 90)
    const autoJump = !isRequest && strongTop && decisiveLead

    const venues = ranked.map(({ _score, _exact, ...v }) => v)   // strip internal fields

    res.json({
      count: venues.length,
      query: raw,
      // Frontend contract:
      //  - autoJumpVenueId set → open this venue directly (bare lookup).
      //  - looksLikeRequest true → this reads like a request; if the user is in
      //    Search, offer an "Ask Sappo" handoff instead of just showing matches.
      autoJumpVenueId: autoJump ? top.id : null,
      looksLikeRequest: isRequest,
      suggestAskSappo: isRequest || venues.length === 0,
      venues,
    })
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
    res.json({ venues: rows.map(v => repairVenuePhotos(v)) })
  } catch (err) { next(err) }
})



// GET /venues/enrich-tripadvisor?secret=...&city=Liverpool&limit=50
// Browser-friendly: bulk-matches venues to TripAdvisor to add ratings + reviews.
// Run AFTER Google enrichment. Repeat until "matched" reaches 0.
// GET /venues/reset-tripadvisor?secret=...&city=Liverpool
// Wipes existing TripAdvisor data so the (now stricter) matcher can re-run cleanly.
// Use this ONCE to clear wrong matches (e.g. a pub showing McDonald's reviews),
// then run /enrich-tripadvisor again to re-match properly.
router.get('/reset-tripadvisor', async (req, res, next) => {
  try {
    if ((req.query.secret || '') !== process.env.SYNC_SECRET) {
      return res.status(403).json({ error: 'Bad or missing secret' })
    }
    const city = req.query.city || 'Liverpool'
    const r = await query(
      `UPDATE venues SET tripadvisor_location_id = NULL, tripadvisor_rating = NULL,
         tripadvisor_review_count = NULL, tripadvisor_ranking = NULL, tripadvisor_url = NULL,
         tripadvisor_top_review = NULL, tripadvisor_status = NULL, tripadvisor_last_checked = NULL
       WHERE city = $1`,
      [city]
    )
    return res.json({
      reset: 'TRIPADVISOR_CLEARED',
      city,
      venuesReset: r.rowCount,
      note: 'Now run /venues/enrich-tripadvisor again — it will re-match with the stricter logic.',
    })
  } catch (err) { next(err) }
})

router.get('/enrich-tripadvisor', async (req, res, next) => {
  try {
    if ((req.query.secret || '') !== process.env.SYNC_SECRET) {
      return res.status(403).json({ error: 'Bad or missing secret' })
    }
    const out = await syncTripAdvisorBatch({
      city: req.query.city || 'Liverpool',
      limit: parseInt(req.query.limit || '50'),
      force: false,
    })
    res.json({
      tripadvisor: 'ENRICHMENT_RUN_COMPLETE',
      scanned: out.scanned,
      matched: out.matched,
      failed: out.failed,
      matchedNames: (out.results || []).filter(r => r.matched).map(r => r.name).slice(0, 20),
      note: 'Run this URL again for the next batch. Repeat until "matched" reaches 0.',
    })
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

// GET /venues/derive-gem-tags?secret=...&city=Liverpool&limit=50
// Backfill gem tags from review text ALREADY stored on venues (no new API
// calls, no Google billing). Run repeatedly until "scanned" reaches 0.
router.get('/derive-gem-tags', async (req, res, next) => {
  try {
    if ((req.query.secret || '') !== process.env.SYNC_SECRET) {
      return res.status(403).json({ error: 'Bad or missing secret' })
    }
    const city = req.query.city || 'Liverpool'
    const limit = Math.min(parseInt(req.query.limit || '50'), 200)
    // Pick venues with some review data that haven't been tagged yet (or are
    // stale), oldest-checked first — mirrors the enrichment batch pattern.
    const { rows } = await query(
      `SELECT id, name, google_review_sample, tripadvisor_top_review
         FROM venues
        WHERE city ILIKE $1
          AND (google_review_sample IS NOT NULL OR tripadvisor_top_review IS NOT NULL)
          AND (gem_tags_checked IS NULL OR gem_tags_checked < now() - interval '30 days')
        ORDER BY gem_tags_checked ASC NULLS FIRST
        LIMIT $2`,
      [city, limit]
    )
    let tagged = 0
    const examples = []
    for (const v of rows) {
      const derived = await refreshGemTags(v)
      if (derived.tags.length) {
        tagged++
        if (examples.length < 20) examples.push({ name: v.name, tags: derived.tags })
      }
    }
    res.json({
      gemTags: 'DERIVATION_RUN_COMPLETE',
      city,
      scanned: rows.length,
      tagged,
      examples,
      note: 'Run this URL again for the next batch. Repeat until "scanned" reaches 0. Uses only stored review text — no API calls.',
    })
  } catch (err) { next(err) }
})

// GET /venues/enrich-google?secret=...&city=Liverpool&limit=50
// Browser-friendly version: bulk-matches venues to Google to fill in images/ratings/hours.
// Run it repeatedly until "failed" stops shrinking — each run does `limit` venues.
router.get('/enrich-google', async (req, res, next) => {
  try {
    if ((req.query.secret || '') !== process.env.SYNC_SECRET) {
      return res.status(403).json({ error: 'Bad or missing secret' })
    }
    const out = await syncGoogleBatch({
      city: req.query.city || 'Liverpool',
      limit: parseInt(req.query.limit || '50'),
      force: false,   // only enrich venues that still need it
    })
    res.json({
      google: 'ENRICHMENT_RUN_COMPLETE',
      scanned: out.scanned,
      matched: out.matched,
      failed: out.failed,
      matchedNames: out.results.filter(r => r.matched).map(r => r.name).slice(0, 20),
      note: 'Run this URL again to process the next batch. Repeat until "matched" reaches 0 (nothing left to enrich).',
    })
  } catch (err) { next(err) }
})

// POST /venues/admin/sync-google?city=Liverpool&limit=25&force=true
// Bulk sync Google Place IDs/details/review snippets into the venue database.
router.post('/admin/sync-google', async (req, res, next) => {
  try {
    const out = await syncGoogleBatch({
      city: req.query.city || req.body?.city || null,
      limit: parseInt(req.query.limit || req.body?.limit || 25),
      force: String(req.query.force || req.body?.force || '').toLowerCase() === 'true',
    })
    res.json({ google: 'SYNC_COMPLETE', ...out })
  } catch (err) { next(err) }
})


// GET /venues/admin/enrichment-status — see background enrichment queue health.
router.get('/admin/enrichment-status', async (req, res) => {
  res.json({ enrichment: getQueueStatus() })
})

// POST /venues/admin/queue-enrichment?city=Liverpool&limit=100
// Queues existing venues for TripAdvisor + social/website enrichment in the background.
router.post('/admin/queue-enrichment', async (req, res, next) => {
  try {
    const city = req.query.city || req.body?.city || null
    const limit = parseInt(req.query.limit || req.body?.limit || 100)
    const params = []
    const where = []
    if (city) { params.push(city); where.push(`city = $${params.length}`) }
    where.push(`(tripadvisor_location_id IS NULL OR socials_checked = FALSE OR profile_last_enriched IS NULL)`)
    params.push(limit)
    const { rows } = await query(
      `SELECT id, name FROM venues ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY rating_count DESC NULLS LAST, rating DESC NULLS LAST LIMIT $${params.length}`,
      params
    )
    let queued = 0
    for (const v of rows) if (scheduleVenueEnrichment(v.id, 'manual_bulk_queue')) queued++
    res.json({ queued, scanned: rows.length, venues: rows.map(v => ({ id: v.id, name: v.name })), status: getQueueStatus() })
  } catch (err) { next(err) }
})

// POST /venues/:id/queue-enrichment — queues all enrichment for one venue.
router.post('/:id/queue-enrichment', async (req, res) => {
  const queued = scheduleVenueEnrichment(req.params.id, 'manual_single_queue')
  res.json({ queued, status: getQueueStatus() })
})

// POST /venues/:id/sync-google — force Google enrichment for one venue.
router.post('/:id/sync-google', async (req, res, next) => {
  try {
    const result = await syncGoogleForVenue(req.params.id, { force: true })
    if (!result) return res.status(404).json({ error: 'Venue not found' })
    res.json({ google: result.matched ? 'MATCHED' : 'NO_MATCH', result })
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
