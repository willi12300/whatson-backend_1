// src/clients/routes.js
// Google Routes API — travel time/distance between two points across modes.
// Uses the same Google API key as Places (needs "Routes API" enabled in the console).
// Degrades gracefully: if no key or the call fails, returns null and the app carries on.

const axios = require('axios')
const { config } = require('../config')
const logger = require('../utils/logger')

const MODE_MAP = {
  walking: 'WALK',
  driving: 'DRIVE',
  cycling: 'BICYCLE',
  transit: 'TRANSIT',
}

// Get travel info for ONE mode between two coords.
async function routeFor(mode, from, to) {
  const travelMode = MODE_MAP[mode]
  if (!travelMode) return null
  const body = {
    origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
    destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
    travelMode,
  }
  // routing preference only valid for DRIVE/TWO_WHEELER
  if (travelMode === 'DRIVE') body.routingPreference = 'TRAFFIC_AWARE'

  const res = await axios.post(
    'https://routes.googleapis.com/directions/v2:computeRoutes',
    body,
    {
      headers: {
        'X-Goog-Api-Key': config.google.key,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  )
  const route = res.data?.routes?.[0]
  if (!route) return null
  const seconds = parseInt(String(route.duration).replace('s', '')) || null
  return {
    mode,
    durationSeconds: seconds,
    durationText: seconds != null ? fmtDuration(seconds) : null,
    distanceMeters: route.distanceMeters ?? null,
    distanceText: route.distanceMeters != null ? fmtDistance(route.distanceMeters) : null,
  }
}

// Get all relevant modes between two stops. Returns { walking, driving, cycling, transit }.
async function travelBetween(from, to) {
  if (!config.google.key) return null
  if (from?.lat == null || to?.lat == null) return null

  // Pick modes based on distance — no point offering transit for 200m.
  const straight = haversine(from.lat, from.lng, to.lat, to.lng)
  const modes = []
  if (straight <= 2500) modes.push('walking')   // walk if within ~2.5km
  modes.push('driving')                          // always offer taxi/car
  if (straight <= 8000) modes.push('cycling')    // cycle if within ~8km
  if (straight >= 800) modes.push('transit')     // transit if worth it

  const results = {}
  await Promise.all(modes.map(async m => {
    try { const r = await routeFor(m, from, to); if (r) results[m] = r }
    catch (e) { /* one mode failing shouldn't kill the rest */ }
  }))

  if (!Object.keys(results).length) return null
  // pick a sensible "primary" suggestion: walk if <=15min, else driving
  let primary = 'driving'
  if (results.walking && results.walking.durationSeconds <= 15 * 60) primary = 'walking'
  results.primary = primary
  return results
}

function fmtDuration(sec) {
  const min = Math.round(sec / 60)
  if (min < 1) return '<1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60), m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}
function fmtDistance(m) {
  if (m < 1000) return `${m} m`
  return `${(m / 1000).toFixed(1)} km`
}
function haversine(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a))*Math.cos(r(c))*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}

module.exports = { travelBetween, routeFor }
