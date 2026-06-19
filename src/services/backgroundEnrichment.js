// src/services/backgroundEnrichment.js
// Lightweight background enrichment queue for newly discovered venues.
// This keeps Roulette/Concierge fast while Sappo's venue database gets smarter over time.

const { query } = require('../db/pool')
const logger = require('../utils/logger')

const queued = new Set()
const queue = []
let running = false

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function scheduleVenueEnrichment(venueId, reason = 'discovered') {
  const id = Number(venueId)
  if (!Number.isFinite(id) || id <= 0) return false
  if (queued.has(id)) return false
  queued.add(id)
  queue.push({ venueId: id, reason, queuedAt: Date.now() })
  logger.info(`[enrichment] queued venue ${id} (${reason})`)
  setImmediate(processQueue)
  return true
}

async function processQueue() {
  if (running) return
  running = true
  try {
    while (queue.length) {
      const item = queue.shift()
      try {
        await enrichVenueBackground(item.venueId, item.reason)
      } catch (e) {
        logger.error(`[enrichment] venue ${item.venueId} failed: ${e.message}`)
      } finally {
        queued.delete(item.venueId)
      }
      // Be polite to external APIs and avoid TripAdvisor 429s.
      await sleep(2500)
    }
  } finally {
    running = false
  }
}

async function enrichVenueBackground(venueId, reason = 'background') {
  logger.info(`[enrichment] start venue ${venueId} (${reason})`)

  // Mark status as pending without breaking older DBs if columns are missing.
  await query(
    `UPDATE venues SET enrichment_status='pending', enrichment_requested_at=now() WHERE id=$1`,
    [venueId]
  ).catch(() => {})

  // Google profile enrichment: place ID, photos, maps URL, opening hours, rating and Google review snippets.
  try {
    const { syncGoogleForVenue } = require('./venueProfile')
    const google = await syncGoogleForVenue(venueId, { force: false })
    logger.info(`[enrichment] Google venue ${venueId}: ${google?.status || 'unknown'}`)
  } catch (e) {
    logger.error(`[enrichment] Google profile skipped for ${venueId}: ${e.message}`)
  }

  // TripAdvisor sync is safe/cached.
  try {
    const { syncTripAdvisorForVenue } = require('./venueProfile')
    const ta = await syncTripAdvisorForVenue(venueId, { force: false })
    logger.info(`[enrichment] TripAdvisor venue ${venueId}: ${ta?.status || 'unknown'}`)
  } catch (e) {
    logger.error(`[enrichment] TripAdvisor skipped for ${venueId}: ${e.message}`)
  }

  try {
    const { enrichVenueSocials } = require('./enrichSocials')
    const socials = await enrichVenueSocials(venueId)
    logger.info(`[enrichment] Socials venue ${venueId}: ${JSON.stringify(socials)}`)
  } catch (e) {
    logger.error(`[enrichment] Social scrape skipped for ${venueId}: ${e.message}`)
  }

  await query(
    `UPDATE venues SET enrichment_status='done', enrichment_last_completed_at=now() WHERE id=$1`,
    [venueId]
  ).catch(() => {})

  logger.info(`[enrichment] done venue ${venueId}`)
}

function getQueueStatus() {
  return { queued: queue.length, running, queuedIds: Array.from(queued).slice(0, 50) }
}

module.exports = { scheduleVenueEnrichment, enrichVenueBackground, getQueueStatus }
