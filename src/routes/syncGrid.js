// src/routes/syncGrid.js
// Geographic grid sync — tiles an entire bounding box with overlapping circles.
// Used for rural/landscape areas (Wales, national parks etc.) where
// settlement-based city presets miss villages and scattered attractions.
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

// Wales bounding box
const REGIONS = {
  wales: {
    name: 'Wales',
    north: 53.45, south: 51.35, west: -5.35, east: -2.65,
    tileSpacingKm: 10,
    tileRadiusM: 8000,
    label: 'North/Mid/South Wales',
    // Rural-optimised types: covers pubs, cafés, castles, viewpoints, walks
    // without wasting quota on urban noise (takeaways, nail salons etc.)
    types: [
      'restaurant', 'cafe', 'bar', 'pub',
      'tourist_attraction', 'park', 'historical_landmark', 'museum',
    ],
  },
  // North Wales focus — tighter grid to get every village
  north_wales: {
    name: 'North Wales',
    north: 53.45, south: 52.55, west: -4.75, east: -2.90,
    tileSpacingKm: 7,
    tileRadiusM: 6000,
    label: 'Anglesey to Llangollen, Snowdonia to coast',
    types: [
      'restaurant', 'cafe', 'bar', 'pub',
      'tourist_attraction', 'park', 'historical_landmark', 'museum',
      'art_gallery', 'church',
    ],
  },
  // Mid Wales — Dolgellau, Machynlleth, Cardigan Bay corridor
  mid_wales: {
    name: 'Mid Wales',
    north: 52.80, south: 51.80, west: -4.80, east: -3.00,
    tileSpacingKm: 10,
    tileRadiusM: 8000,
    label: 'Dolgellau, Machynlleth, Aberystwyth, Brecon',
    types: [
      'restaurant', 'cafe', 'bar', 'pub',
      'tourist_attraction', 'park', 'historical_landmark', 'museum',
    ],
  },
}

function buildTileGrid(region) {
  const { north, south, west, east, tileSpacingKm, tileRadiusM } = region
  const mPerDegLat = 111320
  const midLat = (north + south) / 2
  const mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180)
  const spacingLat = tileSpacingKm * 1000 / mPerDegLat
  const spacingLng = tileSpacingKm * 1000 / mPerDegLng

  const tiles = []
  for (let lat = south + spacingLat / 2; lat < north; lat += spacingLat) {
    for (let lng = west + spacingLng / 2; lng < east; lng += spacingLng) {
      tiles.push({ lat: parseFloat(lat.toFixed(5)), lng: parseFloat(lng.toFixed(5)) })
    }
  }
  return tiles
}

// State for long-running sync — stored in memory (Railway keeps process alive)
const gridSyncState = {}

// GET /sync-grid/status — check progress of any running grid sync
router.get('/status', checkSecret, (req, res) => {
  res.json(gridSyncState)
})

// GET /sync-grid/preview?region=wales — show tile count + estimated cost before running
router.get('/preview', checkSecret, (req, res) => {
  const regionKey = (req.query.region || 'wales').toLowerCase()
  const region = REGIONS[regionKey]
  if (!region) return res.status(400).json({ error: `Unknown region. Available: ${Object.keys(REGIONS).join(', ')}` })
  const tiles = buildTileGrid(region)
  const totalRequests = tiles.length * region.types.length
  res.json({
    region: regionKey, label: region.label,
    tiles: tiles.length,
    types: region.types.length,
    totalRequests,
    estimatedCostUSD: (totalRequests * 0.032).toFixed(2),
    tileSpacingKm: region.tileSpacingKm,
    tileRadiusM: region.tileRadiusM,
    sampleTiles: tiles.slice(0, 5),
    message: `This will make ~${totalRequests} Google API requests costing ~$${(totalRequests * 0.032).toFixed(2)}. Run /sync-grid/run?region=${regionKey} to start.`
  })
})

// GET /sync-grid/run?region=wales&start=0 — run the grid sync
// ?start= lets you resume from a tile index if it was interrupted
router.get('/run', checkSecret, async (req, res) => {
  const regionKey = (req.query.region || 'wales').toLowerCase()
  const region = REGIONS[regionKey]
  if (!region) return res.status(400).json({ error: `Unknown region. Available: ${Object.keys(REGIONS).join(', ')}` })
  if (gridSyncState[regionKey]?.running) {
    return res.json({ message: 'Already running', state: gridSyncState[regionKey] })
  }

  const tiles = buildTileGrid(region)
  const startIdx = Math.max(0, parseInt(req.query.start || '0'))
  const cityLabel = region.name

  gridSyncState[regionKey] = {
    running: true, region: regionKey, total: tiles.length,
    done: startIdx, added: 0, updated: 0, errors: 0,
    startedAt: new Date().toISOString(), lastTile: null,
  }

  res.json({
    message: `Grid sync started for ${region.label}. ${tiles.length - startIdx} tiles to process.`,
    state: gridSyncState[regionKey],
    statusUrl: '/sync-grid/status',
  })

  // Run async, staggered so we don't exceed Google's rate limit
  ;(async () => {
    const state = gridSyncState[regionKey]
    for (let i = startIdx; i < tiles.length; i++) {
      const tile = tiles[i]
      state.done = i; state.lastTile = tile
      try {
        // Fetch from Google using the region's type list
        const venues = await google.fetchVenues(tile.lat, tile.lng, region.tileRadiusM, {
          types: region.types, parallel: false, timeoutMs: 12000,
        })

        for (const v of venues) {
          try {
            const vLat = v.location?.latitude ?? v.lat
            const vLng = v.location?.longitude ?? v.lng
            await upsertVenue({
              name: v.name, normalisedName: (v.name || '').toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim(),
              category: v.primaryType || v.category || 'place',
              lat: vLat, lng: vLng, address: v.address, postcode: null,
              phone: v.phone, website: v.website,
              rating: v.rating, ratingCount: v.ratingCount, priceLevel: v.priceLevel,
              openingHours: v.regularOpeningHours || v.currentOpeningHours || null,
              businessStatus: v.businessStatus, photos: v.photos || [],
              coverPhoto: v.photos?.[0]?.url || null,
              googlePlaceId: v.providerId || v.googlePlaceId,
              sources: [{ provider: 'google', providerId: v.providerId || v.googlePlaceId, raw: v }],
            }, cityLabel).then(r => { if (r.isNew) state.added++; else state.updated++ })
          } catch (e) { state.errors++ }
        }

        // 350ms between tiles → ~2 tiles/sec, safe within Google rate limits
        await new Promise(r => setTimeout(r, 350))
      } catch (e) {
        logger.error(`[grid-sync] tile ${i} (${tile.lat},${tile.lng}) failed:`, e.message)
        state.errors++
        await new Promise(r => setTimeout(r, 2000)) // back off on error
      }
    }
    state.running = false
    state.done = tiles.length
    state.finishedAt = new Date().toISOString()
    logger.info(`[grid-sync] ${regionKey} complete: ${state.added} added, ${state.updated} updated, ${state.errors} errors`)
  })()
})

module.exports = router
