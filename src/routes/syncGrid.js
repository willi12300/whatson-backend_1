// src/routes/syncGrid.js
// Geographic grid sync with three passes:
//   venues  — restaurants, pubs, cafés, museums etc.
//   outdoor — hiking areas, campsites, natural features
//   text    — waterfalls, viewpoints, wild swimming, summits, gorges, trails
//             (things Google type-search can't find by type alone)
const express = require('express')
const router = express.Router()
const { config } = require('../config')
const { query } = require('../db/pool')
const { upsertVenue, upsertEvent } = require('../services/sync')
const google = require('../clients/google')
const skiddle = require('../clients/skiddle')
const logger = require('../utils/logger')

function checkSecret(req, res, next) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  if (provided !== config.syncSecret) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// The 6 text queries that type-based search completely misses.
// Deliberately lean — pubs/cafés/campsites are covered by type passes.
const OUTDOOR_TEXT_QUERIES = [
  'waterfall',
  'viewpoint scenic',
  'wild swimming',
  'walking trail',
  'mountain summit',
  'gorge',
]

const REGIONS = {
  // Aberystwyth → Liverpool/Chester/Wirral — the full area Will is covering.
  // GPS determines local relevance; region is just a sync boundary.
  main: {
    name: 'Main Region',
    north: 53.45, south: 52.40, west: -5.35, east: -2.65,
    tileSpacingKm: 7, tileRadiusM: 6000,
    label: 'Aberystwyth to Liverpool, Chester & Wirral — full coverage',
    types: [
      'restaurant', 'cafe', 'bar', 'pub',
      'tourist_attraction', 'museum', 'art_gallery', 'park',
      'historical_landmark', 'church',
    ],
    outdoorTypes: [
      'hiking_area', 'campground', 'natural_feature',
      'visitor_center', 'rv_park',
    ],
    textQueries: OUTDOOR_TEXT_QUERIES,
  },
  // Tight 5km grid just around Dolgellau — run this first for immediate local coverage
  dolgellau: {
    name: 'Dolgellau Area',
    north: 52.92, south: 52.55, west: -4.25, east: -3.45,
    tileSpacingKm: 5, tileRadiusM: 5000,
    label: 'Dolgellau, Cadair Idris, Barmouth, Llwyngwril — tight 5km grid',
    types: [
      'restaurant', 'cafe', 'bar', 'pub',
      'tourist_attraction', 'museum', 'park', 'historical_landmark',
    ],
    outdoorTypes: ['hiking_area', 'campground', 'natural_feature', 'visitor_center'],
    textQueries: OUTDOOR_TEXT_QUERIES,
  },
}

function buildTileGrid(region) {
  const mPerDegLat = 111320
  const midLat = (region.north + region.south) / 2
  const mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180)
  const spacingLat = region.tileSpacingKm * 1000 / mPerDegLat
  const spacingLng = region.tileSpacingKm * 1000 / mPerDegLng
  const tiles = []
  for (let lat = region.south + spacingLat / 2; lat < region.north; lat += spacingLat) {
    for (let lng = region.west + spacingLng / 2; lng < region.east; lng += spacingLng) {
      tiles.push({
        lat: Math.round(lat * 100000) / 100000,
        lng: Math.round(lng * 100000) / 100000,
      })
    }
  }
  return tiles
}

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim()
}

async function saveVenue(v, regionName) {
  try {
    const vLat = (v.location && v.location.latitude != null) ? v.location.latitude : v.lat
    const vLng = (v.location && v.location.longitude != null) ? v.location.longitude : v.lng
    if (!vLat || !vLng || !v.name) return null
    return await upsertVenue({
      name: v.name,
      normalisedName: normaliseName(v.name),
      category: v.primaryType || 'place',
      lat: vLat, lng: vLng,
      address: v.address || null, postcode: null,
      phone: v.phone || null, website: v.website || null,
      rating: v.rating || null, ratingCount: v.ratingCount || null,
      priceLevel: v.priceLevel || null,
      openingHours: v.regularOpeningHours || v.currentOpeningHours || v.openingHours || null,
      businessStatus: v.businessStatus || null,
      photos: v.photos || [],
      coverPhoto: (v.photos && v.photos[0]) ? v.photos[0].url : null,
      googlePlaceId: v.providerId || v.googlePlaceId || null,
      sources: [{ provider: 'google', providerId: v.providerId || v.googlePlaceId || null, raw: v }],
    }, regionName)
  } catch (e) {
    logger.error('[grid] upsert failed for ' + (v.name || '?') + ': ' + e.message)
    return null
  }
}

const syncState = {}

// GET /sync-grid/status
router.get('/status', checkSecret, (req, res) => res.json(syncState))

// GET /sync-grid/preview?region=main&pass=text
router.get('/preview', checkSecret, (req, res) => {
  const regionKey = (req.query.region || 'main').toLowerCase()
  const region = REGIONS[regionKey]
  if (!region) return res.status(400).json({ error: 'Unknown region. Options: ' + Object.keys(REGIONS).join(', ') })
  const pass = req.query.pass || 'venues'
  const tiles = buildTileGrid(region)
  const types = pass === 'outdoor' ? region.outdoorTypes
    : pass === 'text' ? region.textQueries
    : region.types
  const totalRequests = tiles.length * types.length
  res.json({
    region: regionKey, pass, label: region.label,
    tiles: tiles.length, types, typeCount: types.length,
    totalRequests,
    estimatedCostUSD: (totalRequests * 0.032).toFixed(2),
    bounds: { north: region.north, south: region.south, west: region.west, east: region.east },
    resumeUrl: '/sync-grid/run?region=' + regionKey + '&pass=' + pass + '&start=N',
    message: 'Run /sync-grid/run?region=' + regionKey + '&pass=' + pass + ' to start.',
  })
})

// GET /sync-grid/run?region=main&pass=venues&start=0
router.get('/run', checkSecret, async (req, res) => {
  const regionKey = (req.query.region || 'main').toLowerCase()
  const region = REGIONS[regionKey]
  if (!region) return res.status(400).json({ error: 'Unknown region. Options: ' + Object.keys(REGIONS).join(', ') })
  const pass = req.query.pass || 'venues'
  const stateKey = regionKey + '_' + pass
  if (syncState[stateKey] && syncState[stateKey].running) {
    return res.json({ message: 'Already running', state: syncState[stateKey] })
  }
  const tiles = buildTileGrid(region)
  const startIdx = Math.max(0, parseInt(req.query.start || '0'))
  const types = pass === 'outdoor' ? region.outdoorTypes
    : pass === 'text' ? region.textQueries
    : region.types
  if (!types || !types.length) return res.status(400).json({ error: 'No types/queries for pass: ' + pass })

  syncState[stateKey] = {
    running: true, region: regionKey, pass, label: region.label,
    total: tiles.length, done: startIdx, added: 0, updated: 0, errors: 0,
    startedAt: new Date().toISOString(), lastTile: null,
  }
  const state = syncState[stateKey]
  const cost = (tiles.length * types.length * 0.032).toFixed(2)

  res.json({
    message: 'Started: ' + region.label + ' / ' + pass + ' pass. '
      + (tiles.length - startIdx) + ' tiles, '
      + types.length + ' ' + (pass === 'text' ? 'queries' : 'types') + ' each.',
    estimatedCostUSD: cost, state,
    statusUrl: '/sync-grid/status',
    resumeUrl: '/sync-grid/run?region=' + regionKey + '&pass=' + pass + '&start=N',
  })

  ;(async () => {
    for (let i = startIdx; i < tiles.length; i++) {
      const tile = tiles[i]
      state.done = i; state.lastTile = tile
      try {
        let venues = []
        if (pass === 'text') {
          for (const q of types) {
            const results = await google.searchTextPlaces(
              q, tile.lat, tile.lng, region.tileRadiusM,
              { timeoutMs: 10000, maxResultCount: 20 }
            )
            venues = venues.concat(results)
            await new Promise(function(r) { setTimeout(r, 200) })
          }
        } else {
          venues = await google.fetchVenues(tile.lat, tile.lng, region.tileRadiusM, {
            types, parallel: false, timeoutMs: 12000,
          })
        }
        // Dedupe within tile by Google Place ID
        const seen = new Set()
        for (const v of venues) {
          const id = v.providerId || v.googlePlaceId
          if (id && seen.has(id)) continue
          if (id) seen.add(id)
          const result = await saveVenue(v, region.name)
          if (result) { if (result.isNew) state.added++; else state.updated++ }
          else state.errors++
        }
        await new Promise(function(r) { setTimeout(r, 350) })
      } catch (e) {
        logger.error('[grid] tile ' + i + ' (' + tile.lat + ',' + tile.lng + ') ' + pass + ' failed: ' + e.message)
        state.errors++
        await new Promise(function(r) { setTimeout(r, 2000) })
      }
    }
    state.running = false
    state.done = tiles.length
    state.finishedAt = new Date().toISOString()
    logger.info('[grid] ' + stateKey + ' done: +'
      + state.added + ' new, ' + state.updated + ' updated, ' + state.errors + ' errors')
  })()
})

// GET /sync-grid/enrich?limit=200
router.get('/enrich', checkSecret, async (req, res, next) => {
  try {
    const { scheduleVenueEnrichment, getQueueStatus } = require('../services/backgroundEnrichment')
    const limit = Math.min(parseInt(req.query.limit || '200'), 500)
    const city = req.query.city || null
    const params = city ? [limit, city] : [limit]
    const cityClause = city ? 'AND city = $2 ' : ''
    const { rows } = await query(
      "SELECT id, name FROM venues WHERE (profile_last_enriched IS NULL OR enrichment_status IS DISTINCT FROM 'done') "
      + cityClause + 'ORDER BY rating_count DESC NULLS LAST, created_at DESC LIMIT $1',
      params
    )
    let queued = 0
    for (const v of rows) if (scheduleVenueEnrichment(v.id, 'reenrich')) queued++
    res.json({
      queued, scanned: rows.length,
      etaMins: Math.round(queued * 2.5 / 60),
      queue: getQueueStatus(),
    })
  } catch (err) { next(err) }
})

// GET /sync-grid/enrich-status
router.get('/enrich-status', checkSecret, async (req, res, next) => {
  try {
    const { getQueueStatus } = require('../services/backgroundEnrichment')
    const { rows } = await query(
      "SELECT COUNT(*) total, "
      + "COUNT(*) FILTER (WHERE profile_last_enriched IS NOT NULL) enriched, "
      + "COUNT(*) FILTER (WHERE profile_last_enriched IS NULL) unenriched "
      + "FROM venues"
    )
    res.json({ db: rows[0], queue: getQueueStatus() })
  } catch (err) { next(err) }
})

// GET /sync-grid/coverage?lat=52.74&lng=-3.88
router.get('/coverage', checkSecret, async (req, res, next) => {
  try {
    const lat = parseFloat(req.query.lat || 52.7447)
    const lng = parseFloat(req.query.lng || -3.8853)
    const counts = {}
    for (const km of [2, 5, 10, 20, 35]) {
      const { rows } = await query(
        'SELECT COUNT(*) c FROM venues WHERE '
        + '(6371 * acos(LEAST(1.0, cos(radians($1)) * cos(radians(lat)) '
        + '* cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat))))) < $3',
        [lat, lng, km]
      )
      counts[km + 'km'] = parseInt(rows[0].c)
    }
    const { rows: nearest } = await query(
      'SELECT name, city, lat, lng, enrichment_status, '
      + 'profile_last_enriched IS NOT NULL as enriched, '
      + 'ROUND((6371 * acos(LEAST(1.0, cos(radians($1)) * cos(radians(lat)) '
      + '* cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))))::numeric, 2) dist_km '
      + 'FROM venues ORDER BY dist_km ASC LIMIT 20',
      [lat, lng]
    )
    res.json({ centre: { lat, lng }, counts, nearest20: nearest })
  } catch (err) { next(err) }
})

// GET /sync-grid/events?lat=52.74&lng=-3.88&radius=40
router.get('/events', checkSecret, async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng)
  const radiusMiles = Math.min(parseInt(req.query.radius || '40'), 100)
  const cityLabel = req.query.city || 'region'
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' })
  syncState.events = {
    running: true, lat, lng, radiusMiles,
    added: 0, updated: 0, errors: 0, startedAt: new Date().toISOString(),
  }
  res.json({ message: 'Fetching events within ' + radiusMiles + ' miles.', state: syncState.events })
  const state = syncState.events
  ;(async () => {
    try {
      const { matchEventToVenue } = require('../services/matchEvents')
      const ticketmaster = require('../clients/ticketmaster')
      const eventbrite = require('../clients/eventbrite')
      const results = await Promise.all([
        skiddle.fetchEvents(lat, lng, radiusMiles, 60, { maxResults: 500, timeoutMs: 20000 })
          .catch(function(e) { logger.error('[events] skiddle: ' + e.message); return [] }),
        ticketmaster.fetchEvents(lat, lng, radiusMiles, 60, { maxResults: 300, maxPages: 3, timeoutMs: 20000 })
          .catch(function(e) { logger.error('[events] tm: ' + e.message); return [] }),
        eventbrite.fetchEvents(lat, lng, Math.min(radiusMiles, 50), 60)
          .catch(function(e) { logger.error('[events] eb: ' + e.message); return [] }),
      ])
      const allEvents = results[0].concat(results[1]).concat(results[2])
      state.fetched = allEvents.length
      for (const e of allEvents) {
        try {
          const match = await matchEventToVenue(e, cityLabel)
          if (match.method === 'none') continue
          const r = await upsertEvent(e, match.venueId, match.confidence)
          if (r.isNew) state.added++; else state.updated++
        } catch (err) { state.errors++ }
      }
      await query("UPDATE events SET status='expired' WHERE ends_at < now() OR (ends_at IS NULL AND starts_at < now() - interval '6 hours')")
      state.running = false
      state.finishedAt = new Date().toISOString()
    } catch (e) {
      state.running = false; state.error = e.message
    }
  })()
})

module.exports = router
