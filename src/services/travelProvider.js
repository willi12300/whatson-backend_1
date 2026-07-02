// src/services/travelProvider.js
// Travel provider SEAM. One entry point — getTravel() — that the rest of the
// app calls instead of hitting Google Routes directly. Today it delegates to
// Google Routes for all modes. When the National Rail OJP API is available,
// rail/transit legs will be served by getRailTravel() (live times, delays)
// WITHOUT changing any caller. This is the whole reason the seam exists.
//
// Design:
//  - getTravel(from, to, opts) → the same shape planNight already consumes
//    ({ walking, driving, cycling, transit, primary }), plus per-leg metadata
//    about which provider produced it and whether it looks rail-relevant.
//  - Callers never know or care which provider answered.

const { travelBetween } = require('../clients/routes')
const logger = require('../utils/logger')

// ── National Rail OJP stub ──────────────────────────────────────────────────
// NOT YET IMPLEMENTED. When you have the OJP API:
//   1. Add the client in src/clients/nationalRailOjp.js (credentials via env,
//      e.g. OJP_API_KEY / OJP_ENDPOINT).
//   2. Implement getRailTravel() below to return:
//        { mode:'rail', durationSeconds, durationText, distanceMeters,
//          distanceText, railProvider:'national_rail_ojp',
//          legs:[{ from, to, departs, arrives, delayMins, platform, operator }] }
//   3. Set OJP_ENABLED=true in Railway. No caller changes needed — getTravel
//      will automatically prefer OJP for rail-relevant transit legs.
const OJP_ENABLED = String(process.env.OJP_ENABLED || '').toLowerCase() === 'true'

async function getRailTravel(/* from, to, opts */) {
  // Placeholder until the OJP integration lands. Returning null makes getTravel
  // transparently fall back to Google's generic transit leg.
  if (!OJP_ENABLED) return null
  logger.warn('[travelProvider] OJP_ENABLED but getRailTravel not implemented yet — falling back to generic transit')
  return null
}

// Heuristic: does this transit leg look like it plausibly involves a train
// (rather than a short bus hop)? Crude on purpose — Google won't tell us
// reliably. Once OJP is wired this becomes precise. Used only to decide which
// legs are worth asking a rail provider about, and to flag them for the UI.
function looksLikeRail(straightMeters, transitLeg) {
  if (!transitLeg) return false
  // Longer journeys are far more likely to be rail than bus.
  const km = straightMeters / 1000
  if (km >= 12) return true
  // Medium journeys where transit is much faster than walking → likely rail.
  return km >= 5
}

// Great-circle metres (local copy so this module is standalone).
function haversine(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// The single entry point. Returns the same shape planNight already uses, or
// null if no provider could answer (caller then shows no leg — same as today).
async function getTravel(from, to, opts = {}) {
  if (from?.lat == null || to?.lat == null) return null

  // 1. Base travel from Google Routes (walking/driving/cycling/transit).
  const base = await travelBetween(from, to).catch(err => {
    logger.warn('[travelProvider] google travelBetween failed: ' + err.message)
    return null
  })
  if (!base) return null

  // 2. If there's a transit leg, decide whether it's rail-relevant and, when a
  //    real rail provider is available, upgrade it with live data.
  const straight = haversine(from.lat, from.lng, to.lat, to.lng)
  if (base.transit) {
    const railRelevant = looksLikeRail(straight, base.transit)
    base.transit.looksLikeRail = railRelevant
    base.transit.railProvider = 'google_generic'   // OJP will flip this later

    if (railRelevant) {
      const rail = await getRailTravel(from, to, opts).catch(() => null)
      if (rail) {
        // OJP answered — replace the generic transit leg with live rail data.
        base.transit = { ...rail, mode: 'transit', looksLikeRail: true }
        // If rail is clearly the sensible primary for a long hop, prefer it.
        if (straight / 1000 >= 12) base.primary = 'transit'
      }
    }
  }

  return base
}

module.exports = { getTravel, getRailTravel, looksLikeRail, OJP_ENABLED }
