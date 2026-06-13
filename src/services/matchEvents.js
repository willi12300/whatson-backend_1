// src/services/matchEvents.js
// Match an event (with venue name + coords) to a canonical venue in our DB.

const { query } = require('../db/pool')
const { distanceMeters, normaliseName, jaroWinkler } = require('../utils/helpers')
const logger = require('../utils/logger')

/**
 * Returns { venueId, confidence, method } for an event.
 * Strategy:
 *   1. name + proximity  (best, when event has coords)
 *   2. fuzzy name only   (pg_trgm)
 *   3. create stub venue (so the event still shows on the map)
 */
async function matchEventToVenue(event, city) {
  // ── 1. name + proximity ──────────────────────────────
  if (event.venueLat && event.venueLng) {
    const { rows } = await query(
      `SELECT id, name, lat, lng FROM venues
       WHERE city = $1
       AND lat BETWEEN $2 - 0.01 AND $2 + 0.01
       AND lng BETWEEN $3 - 0.015 AND $3 + 0.015`,
      [city, event.venueLat, event.venueLng]
    )

    let best = null
    let bestScore = 0
    const target = normaliseName(event.venueName)

    for (const v of rows) {
      const dist = distanceMeters(event.venueLat, event.venueLng, v.lat, v.lng)
      if (dist > 250) continue
      const nameSim = jaroWinkler(target, normaliseName(v.name))
      const proxScore = Math.max(0, 1 - dist / 250)
      const combined = nameSim * 0.7 + proxScore * 0.3
      if (nameSim >= 0.7 && combined > bestScore) {
        bestScore = combined
        best = v
      }
    }
    if (best) return { venueId: best.id, confidence: bestScore, method: 'name_proximity' }
  }

  // ── 2. fuzzy name only ───────────────────────────────
  const target = normaliseName(event.venueName)
  if (target.length > 3) {
    const { rows } = await query(
      `SELECT id, name, similarity(normalised_name, $1) AS sim
       FROM venues
       WHERE city = $2 AND similarity(normalised_name, $1) > 0.4
       ORDER BY sim DESC
       LIMIT 1`,
      [target, city]
    )
    if (rows.length) {
      const sim = jaroWinkler(target, normaliseName(rows[0].name))
      if (sim >= 0.65) return { venueId: rows[0].id, confidence: sim * 0.6, method: 'name_only' }
    }
  }

  // ── 3. create stub venue ─────────────────────────────
  if (event.venueLat && event.venueLng && event.venueName) {
    const { rows } = await query(
      `INSERT INTO venues (name, normalised_name, category_slug, lat, lng, address, city, claimed)
       VALUES ($1, $2, 'other', $3, $4, $5, $6, false)
       RETURNING id`,
      [
        event.venueName,
        normaliseName(event.venueName),
        event.venueLat,
        event.venueLng,
        event.venueAddress || null,
        city,
      ]
    )
    logger.debug(`Created stub venue for "${event.venueName}"`)
    return { venueId: rows[0].id, confidence: 0.3, method: 'stub' }
  }

  return { venueId: null, confidence: 0, method: 'none' }
}

module.exports = { matchEventToVenue }
