// src/routes/syncGrid.js
// Geographic grid sync — tiles a bounding box with overlapping circles.
// For rural/landscape areas where city-point presets miss villages.
// Also provides a large-radius event sweep endpoint for Skiddle/TM/EB.
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

const REGIONS = {
  wales: {
    name: 'Wales',
    north: 53.45, south: 51.35, west: -5.35, east: -2.65,
    tileSpacingKm: 10, tileRadiusM: 8000,
    label: 'Full Wales — all towns, villages, national parks',
    types: ['restaurant','cafe','bar','pub','tourist_attraction','park','historical_landmark','museum'],
  },
  north_wales: {
    name: 'North Wales',
    north: 53.45, south: 52.55, west: -4.75, east: -2.90,
    tileSpacingKm: 7, tileRadiusM: 6000,
    label: 'Anglesey to Llangollen, Snowdonia to coast',
    types: ['restaurant','cafe','bar','pub','tourist_attraction','park','historical_landmark','museum','art_gallery','church'],
  },
  mid_wales: {
    name: 'Mid Wales',
    north: 52.80, south: 51.80, west: -4.80, east: -3.00,
    tileSpacingKm: 10, tileRadiusM: 8000,
    label: 'Dolgellau, Machynlleth, Aberystwyth, Brecon',
    types: ['restaurant','cafe','bar','pub','tourist_attraction','park','historical_landmark','museum'],
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
      tiles.push({ lat: Math.round(lat * 100000) / 100000, lng: Math.round(lng * 100000) / 100000 })
    }
  }
  return tiles
}

function normaliseName(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/ +/g, ' ').trim()
}

// In-memory state — Railway keeps the process alive during a sync
const syncState = {}

// GET /sync-grid/status
router.get('/status', checkSecret, (req, res) => {
  res.json(syncState)
})

// GET /sync-grid/preview?region=wales — cost estimate before running
router.get('/preview', checkSecret, (req, res) => {
  const regionKey = (req.query.region || 'wales').toLowerCase()
  const region = REGIONS[regionKey]
  if (!region) return res.status(400).json({ error: 'Unknown region. Available: ' + Object.keys(REGIONS).join(', ') })
  const tiles = buildTileGrid(region)
  const totalRequests = tiles.length * region.types.length
  const costUSD = (totalRequests * 0.032).toFixed(2)
  res.json({
    region: regionKey, label: region.label,
    tiles: tiles.length, types: region.types.length,
    totalRequests, estimatedCostUSD: costUSD,
    tileSpacingKm: region.tileSpacingKm, tileRadiusM: region.tileRadiusM,
    sampleTiles: tiles.slice(0, 5),
    message: 'Estimated ' + totalRequests + ' requests = $' + costUSD + '. Run /sync-grid/run?region=' + regionKey + ' to start.',
  })
})

// GET /sync-grid/run?region=wales&start=0
// ?start= lets you resume from a tile index if Railway interrupted it
router.get('/run', checkSecret, async (req, res) => {
  const regionKey = (req.query.region || 'wales').toLowerCase()
  const region = REGIONS[regionKey]
  if (!region) return res.status(400).json({ error: 'Unknown region. Available: ' + Object.keys(REGIONS).join(', ') })
  if (syncState[regionKey] && syncState[regionKey].running) {
    return res.json({ message: 'Already running', state: syncState[regionKey] })
  }
  const tiles = buildTileGrid(region)
  const startIdx = Math.max(0, parseInt(req.query.start || '0'))
  syncState[regionKey] = {
    running: true, region: regionKey, label: region.label,
    total: tiles.length, done: startIdx, added: 0, updated: 0, errors: 0,
    startedAt: new Date().toISOString(), lastTile: null,
  }
  res.json({
    message: 'Grid sync started for ' + region.label + '. ' + (tiles.length - startIdx) + ' tiles to process.',
    state: syncState[regionKey], statusUrl: '/sync-grid/status',
  })

  const state = syncState[regionKey]
  ;(async () => {
    for (let i = startIdx; i < tiles.length; i++) {
      const tile = tiles[i]
      state.done = i; state.lastTile = tile
      try {
        const venues = await google.fetchVenues(tile.lat, tile.lng, region.tileRadiusM, {
          types: region.types, parallel: false, timeoutMs: 12000,
        })
        for (const v of venues) {
          try {
            const vLat = (v.location && v.location.latitude != null) ? v.location.latitude : v.lat
            const vLng = (v.location && v.location.longitude != null) ? v.location.longitude : v.lng
            if (vLat == null || vLng == null) continue
            const result = await upsertVenue({
              name: v.name,
              normalisedName: normaliseName(v.name),
              category: v.primaryType || v.category || 'place',
              lat: vLat, lng: vLng,
              address: v.address, postcode: null,
              phone: v.phone || null,
              website: v.website || null,
              rating: v.rating || null,
              ratingCount: v.ratingCount || null,
              priceLevel: v.priceLevel || null,
              openingHours: v.regularOpeningHours || v.currentOpeningHours || null,
              businessStatus: v.businessStatus || null,
              photos: v.photos || [],
              coverPhoto: (v.photos && v.photos[0]) ? v.photos[0].url : null,
              googlePlaceId: v.providerId || v.googlePlaceId || null,
              sources: [{ provider: 'google', providerId: v.providerId || v.googlePlaceId || null, raw: v }],
            }, region.name)
            if (result.isNew) state.added++; else state.updated++
          } catch (e) {
            state.errors++
          }
        }
        // 350ms between tiles — safe within Google quota
        await new Promise(function(r) { setTimeout(r, 350) })
      } catch (e) {
        logger.error('[grid-sync] tile ' + i + ' (' + tile.lat + ',' + tile.lng + ') failed: ' + e.message)
        state.errors++
        await new Promise(function(r) { setTimeout(r, 2000) })
      }
    }
    state.running = false
    state.done = tiles.length
    state.finishedAt = new Date().toISOString()
    logger.info('[grid-sync] ' + regionKey + ' complete: ' + state.added + ' added, ' + state.updated + ' updated, ' + state.errors + ' errors')
  })()
})

// GET /sync-grid/events?lat=52.74&lng=-3.88&radius=40
// Single large-radius sweep for events — covers all of Wales from one point.
// Run weekly, or when you move to a new area. No cost (Skiddle/TM/EB are free APIs).
router.get('/events', checkSecret, async (req, res) => {
  const lat = parseFloat(req.query.lat)
  const lng = parseFloat(req.query.lng)
  const radiusMiles = Math.min(parseInt(req.query.radius || '40'), 100)
  const cityLabel = req.query.city || 'Wales'
  if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required. Example: ?lat=52.74&lng=-3.88&radius=40' })

  syncState.events = {
    running: true, lat: lat, lng: lng, radiusMiles: radiusMiles,
    added: 0, updated: 0, errors: 0, startedAt: new Date().toISOString(),
  }
  res.json({
    message: 'Fetching events within ' + radiusMiles + ' miles from Skiddle, Ticketmaster & Eventbrite. No API cost.',
    state: syncState.events, statusUrl: '/sync-grid/status',
  })

  const state = syncState.events
  ;(async () => {
    try {
      const { matchEventToVenue } = require('../services/matchEvents')
      const ticketmaster = require('../clients/ticketmaster')
      const eventbrite = require('../clients/eventbrite')

      const results = await Promise.all([
        skiddle.fetchEvents(lat, lng, radiusMiles, 60, { maxResults: 500, timeoutMs: 20000 }).catch(function(e) {
          logger.error('[grid-events] skiddle failed: ' + e.message); return []
        }),
        ticketmaster.fetchEvents(lat, lng, radiusMiles, 60, { maxResults: 300, maxPages: 3, timeoutMs: 20000 }).catch(function(e) {
          logger.error('[grid-events] ticketmaster failed: ' + e.message); return []
        }),
        eventbrite.fetchEvents(lat, lng, Math.min(radiusMiles, 50), 60).catch(function(e) {
          logger.error('[grid-events] eventbrite failed: ' + e.message); return []
        }),
      ])

      const sk = results[0], tm = results[1], eb = results[2]
      const allEvents = sk.concat(tm).concat(eb)
      logger.info('[grid-events] Skiddle:' + sk.length + ' TM:' + tm.length + ' EB:' + eb.length + ' total:' + allEvents.length)
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
      logger.info('[grid-events] done: ' + state.added + ' added, ' + state.updated + ' updated, ' + state.errors + ' errors')
    } catch (e) {
      state.running = false
      state.error = e.message
      logger.error('[grid-events] failed: ' + e.message)
    }
  })()
})

module.exports = router

// GET /sync-grid/enrich?limit=50&city=Wales
// Re-queues all venues that have no enrichment (profile_last_enriched IS NULL)
// or whose enrichment is stale (>7 days old). Safe to call multiple times.
// Because the queue is in-memory, call this again if Railway restarts.
router.get('/enrich', checkSecret, async (req, res, next) => {
  try {
    const { scheduleVenueEnrichment, getQueueStatus } = require('../services/backgroundEnrichment')
    const limit = Math.min(parseInt(req.query.limit || '200'), 500)
    const city = req.query.city || null
    const params = []
    const where = [
      "(profile_last_enriched IS NULL OR profile_last_enriched < now() - interval '7 days')",
      "(enrichment_status IS NULL OR enrichment_status != 'done' OR enrichment_last_completed_at < now() - interval '7 days')"
    ]
    if (city) { params.push(city); where.push('city = $' + params.length) }
    params.push(limit)
    const { rows } = await query(
      'SELECT id, name, city FROM venues WHERE (' + where[0] + ' OR ' + where[1] + ') ' +
      (city ? 'AND city = $1 ' : '') +
      'ORDER BY rating_count DESC NULLS LAST, created_at DESC LIMIT $' + params.length,
      params
    )
    let queued = 0
    for (const v of rows) {
      if (scheduleVenueEnrichment(v.id, 'grid_reenrich')) queued++
    }
    const eta = Math.round(queued * 2.5 / 60)
    res.json({
      message: queued + ' venues queued for enrichment. ETA ~' + eta + ' mins. Check /sync-grid/enrich-status.',
      queued, scanned: rows.length, city: city || 'all',
      queueStatus: getQueueStatus()
    })
  } catch (err) { next(err) }
})

// GET /sync-grid/enrich-status — how many left in the enrichment queue
router.get('/enrich-status', checkSecret, async (req, res, next) => {
  try {
    const { getQueueStatus } = require('../services/backgroundEnrichment')
    const { rows } = await query(
      "SELECT COUNT(*) total, " +
      "COUNT(*) FILTER (WHERE profile_last_enriched IS NOT NULL) enriched, " +
      "COUNT(*) FILTER (WHERE profile_last_enriched IS NULL) unenriched, " +
      "COUNT(*) FILTER (WHERE enrichment_status = 'done') done, " +
      "COUNT(*) FILTER (WHERE enrichment_status = 'pending') pending " +
      "FROM venues"
    )
    res.json({ db: rows[0], queue: getQueueStatus() })
  } catch (err) { next(err) }
})
