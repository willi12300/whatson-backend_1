// src/services/sync.js
// Orchestrates the full ingestion: fetch → dedup → store venues → fetch events → match → store.

const { pool, query } = require('../db/pool')
const google = require('../clients/google')
const foursquare = require('../clients/foursquare')
const osm = require('../clients/osm')
const skiddle = require('../clients/skiddle')
const eventbrite = require('../clients/eventbrite')
const { deduplicate, mergeCluster } = require('./dedup')
const { matchEventToVenue } = require('./matchEvents')
const logger = require('../utils/logger')

/**
 * Upsert a merged venue and its sources. Returns { id, isNew }.
 */
async function upsertVenue(v, city) {
  // Does any of this cluster's sources already exist?
  let venueId = null
  for (const s of v.sources) {
    const { rows } = await query(
      `SELECT venue_id FROM venue_sources WHERE provider = $1 AND provider_id = $2`,
      [s.provider, s.providerId]
    )
    if (rows.length) {
      venueId = rows[0].venue_id
      break
    }
  }

  const isNew = !venueId

  if (venueId) {
    // update existing
    await query(
      `UPDATE venues SET
        name=$1, normalised_name=$2, category_slug=$3, lat=$4, lng=$5,
        address=$6, postcode=$7, phone=$8, website=$9, rating=$10,
        rating_count=$11, price_level=$12, opening_hours=$13, business_status=$14,
        photos=$15, cover_photo=$16, city=$17, updated_at=now(), last_seen_at=now()
       WHERE id=$18`,
      [
        v.name, v.normalisedName, v.category, v.lat, v.lng,
        v.address, v.postcode, v.phone, v.website, v.rating,
        v.ratingCount, v.priceLevel, v.openingHours ? JSON.stringify(v.openingHours) : null,
        v.businessStatus, JSON.stringify(v.photos || []), v.coverPhoto, city, venueId,
      ]
    )
  } else {
    const { rows } = await query(
      `INSERT INTO venues
        (name, normalised_name, category_slug, lat, lng, address, postcode,
         phone, website, rating, rating_count, price_level, opening_hours,
         business_status, photos, cover_photo, city)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        v.name, v.normalisedName, v.category, v.lat, v.lng, v.address, v.postcode,
        v.phone, v.website, v.rating, v.ratingCount, v.priceLevel,
        v.openingHours ? JSON.stringify(v.openingHours) : null,
        v.businessStatus, JSON.stringify(v.photos || []), v.coverPhoto, city,
      ]
    )
    venueId = rows[0].id
  }

  // upsert each source link
  for (const s of v.sources) {
    await query(
      `INSERT INTO venue_sources (venue_id, provider, provider_id, raw)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider, provider_id)
       DO UPDATE SET venue_id = EXCLUDED.venue_id, raw = EXCLUDED.raw`,
      [venueId, s.provider, s.providerId, s.raw ? JSON.stringify(s.raw) : null]
    )
  }

  return { id: venueId, isNew }
}

/**
 * Upsert an event matched to a venue. Returns { isNew }.
 */
async function upsertEvent(e, venueId, confidence, city) {
  const existing = await query(
    `SELECT e.id FROM events e
     JOIN event_sources es ON es.event_id = e.id
     WHERE es.provider = $1 AND es.provider_id = $2`,
    [e.provider, e.providerId]
  )

  let eventId
  let isNew = false

  if (existing.rows.length) {
    eventId = existing.rows[0].id
    await query(
      `UPDATE events SET
        venue_id=$1, name=$2, description=$3, image_url=$4, category=$5, genre=$6,
        starts_at=$7, ends_at=$8, is_free=$9, min_price=$10, ticket_url=$11,
        raw_venue_name=$12, raw_address=$13, match_confidence=$14, updated_at=now()
       WHERE id=$15`,
      [
        venueId, e.name, e.description, e.imageUrl, e.category, e.genre,
        e.startsAt, e.endsAt, e.isFree, e.minPrice, e.ticketUrl,
        e.venueName, e.venueAddress, confidence, eventId,
      ]
    )
  } else {
    const { rows } = await query(
      `INSERT INTO events
        (venue_id, name, description, image_url, category, genre, starts_at, ends_at,
         is_free, min_price, ticket_url, raw_venue_name, raw_address, match_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        venueId, e.name, e.description, e.imageUrl, e.category, e.genre,
        e.startsAt, e.endsAt, e.isFree, e.minPrice, e.ticketUrl,
        e.venueName, e.venueAddress, confidence,
      ]
    )
    eventId = rows[0].id
    isNew = true
  }

  await query(
    `INSERT INTO event_sources (event_id, provider, provider_id, raw)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (provider, provider_id)
     DO UPDATE SET event_id = EXCLUDED.event_id, raw = EXCLUDED.raw`,
    [eventId, e.provider, e.providerId, e.raw ? JSON.stringify(e.raw) : null]
  )

  return { isNew }
}

/**
 * Full sync for a city preset.
 */
async function syncCity(cityPreset) {
  const cityName = cityPreset.name
  const log = await query(
    `INSERT INTO sync_log (city, status) VALUES ($1, 'running') RETURNING id`,
    [cityName]
  )
  const logId = log.rows[0].id
  const stats = { venuesAdded: 0, venuesUpdated: 0, eventsAdded: 0, eventsUpdated: 0 }

  try {
    logger.info(`=== SYNC START: ${cityName} ===`)

    // 1. Fetch venues from all providers (parallel)
    const [g, f, o] = await Promise.all([
      google.fetchVenues(cityPreset.lat, cityPreset.lng, cityPreset.radiusMeters),
      foursquare.fetchVenues(cityPreset.lat, cityPreset.lng, cityPreset.radiusMeters),
      osm.fetchVenues(cityPreset.bbox),
    ])
    const candidates = [...g, ...f, ...o]
    logger.info(`Total raw venue candidates: ${candidates.length}`)

    // 2. Deduplicate
    const clusters = deduplicate(candidates)
    logger.info(`Unique venues after dedup: ${clusters.length}`)

    // 3. Store venues
    for (const cluster of clusters) {
      const merged = mergeCluster(cluster)
      try {
        const { isNew } = await upsertVenue(merged, cityName)
        if (isNew) stats.venuesAdded++
        else stats.venuesUpdated++
      } catch (err) {
        logger.error(`Failed to upsert venue "${merged.name}":`, err.message)
      }
    }

    // 4. Fetch events (parallel)
    const [sk, eb] = await Promise.all([
      skiddle.fetchEvents(cityPreset.lat, cityPreset.lng, 5),
      eventbrite.fetchEvents(cityPreset.lat, cityPreset.lng, 5),
    ])
    const allEvents = [...sk, ...eb]
    logger.info(`Total raw events: ${allEvents.length}`)

    // 5. Match + store events
    for (const e of allEvents) {
      try {
        const match = await matchEventToVenue(e, cityName)
        if (match.method === 'none') continue
        const { isNew } = await upsertEvent(e, match.venueId, match.confidence, cityName)
        if (isNew) stats.eventsAdded++
        else stats.eventsUpdated++
      } catch (err) {
        logger.error(`Failed to process event "${e.name}":`, err.message)
      }
    }

    // 6. Expire old events
    await query(`UPDATE events SET status='expired' WHERE ends_at < now() OR (ends_at IS NULL AND starts_at < now() - interval '6 hours')`)

    await query(
      `UPDATE sync_log SET status='done', finished_at=now(),
        venues_added=$1, venues_updated=$2, events_added=$3, events_updated=$4
       WHERE id=$5`,
      [stats.venuesAdded, stats.venuesUpdated, stats.eventsAdded, stats.eventsUpdated, logId]
    )

    logger.info(`=== SYNC DONE: ${cityName} ===`, stats)
    return stats
  } catch (err) {
    logger.error(`Sync failed for ${cityName}:`, err.message)
    await query(`UPDATE sync_log SET status='error', finished_at=now(), error=$1 WHERE id=$2`, [
      err.message,
      logId,
    ])
    throw err
  }
}

module.exports = { syncCity }
