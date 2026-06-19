const { query } = require('../db/pool')
const google = require('../clients/google')
const foursquare = require('../clients/foursquare')
const osm = require('../clients/osm')
const skiddle = require('../clients/skiddle')
const eventbrite = require('../clients/eventbrite')
const ticketmaster = require('../clients/ticketmaster')
const { deduplicate, mergeCluster } = require('./dedup')
const { matchEventToVenue } = require('./matchEvents')
const logger = require('../utils/logger')

async function upsertVenue(v, city) {
  const googleSource = (v.sources || []).find(s => s.provider === 'google') || null
  const googlePlaceId = googleSource?.providerId || v.googlePlaceId || null
  const googleMapsUrl = googlePlaceId ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name || '')}&query_place_id=${encodeURIComponent(googlePlaceId)}` : null
  let venueId = null
  for (const s of v.sources) {
    const { rows } = await query(`SELECT venue_id FROM venue_sources WHERE provider=$1 AND provider_id=$2`, [s.provider, s.providerId])
    if (rows.length) { venueId = rows[0].venue_id; break }
  }
  const isNew = !venueId
  if (venueId) {
    await query(`UPDATE venues SET name=$1,normalised_name=$2,category_slug=$3,lat=$4,lng=$5,address=$6,postcode=$7,phone=$8,website=$9,rating=$10,rating_count=$11,price_level=$12,opening_hours=$13,business_status=$14,photos=$15,cover_photo=$16,city=$17,google_place_id=COALESCE($18, google_place_id),google_maps_url=COALESCE(google_maps_url,$19),updated_at=now(),last_seen_at=now() WHERE id=$20`,
      [v.name,v.normalisedName,v.category,v.lat,v.lng,v.address,v.postcode,v.phone,v.website,v.rating,v.ratingCount,v.priceLevel,v.openingHours?JSON.stringify(v.openingHours):null,v.businessStatus,JSON.stringify(v.photos||[]),v.coverPhoto,city,googlePlaceId,googleMapsUrl,venueId])
  } else {
    const { rows } = await query(`INSERT INTO venues (name,normalised_name,category_slug,lat,lng,address,postcode,phone,website,rating,rating_count,price_level,opening_hours,business_status,photos,cover_photo,city,google_place_id,google_maps_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [v.name,v.normalisedName,v.category,v.lat,v.lng,v.address,v.postcode,v.phone,v.website,v.rating,v.ratingCount,v.priceLevel,v.openingHours?JSON.stringify(v.openingHours):null,v.businessStatus,JSON.stringify(v.photos||[]),v.coverPhoto,city,googlePlaceId,googleMapsUrl])
    venueId = rows[0].id
  }
  for (const s of v.sources) {
    await query(`INSERT INTO venue_sources (venue_id,provider,provider_id,raw) VALUES ($1,$2,$3,$4) ON CONFLICT (provider,provider_id) DO UPDATE SET venue_id=EXCLUDED.venue_id,raw=EXCLUDED.raw`,
      [venueId,s.provider,s.providerId,s.raw?JSON.stringify(s.raw):null])
  }
  return { id: venueId, isNew }
}

async function upsertEvent(e, venueId, confidence) {
  const existing = await query(`SELECT e.id FROM events e JOIN event_sources es ON es.event_id=e.id WHERE es.provider=$1 AND es.provider_id=$2`, [e.provider, e.providerId])
  let eventId, isNew = false
  if (existing.rows.length) {
    eventId = existing.rows[0].id
    await query(`UPDATE events SET venue_id=$1,name=$2,description=$3,image_url=$4,category=$5,genre=$6,starts_at=$7,ends_at=$8,is_free=$9,min_price=$10,ticket_url=$11,raw_venue_name=$12,raw_address=$13,match_confidence=$14,updated_at=now() WHERE id=$15`,
      [venueId,e.name,e.description,e.imageUrl,e.category,e.genre,e.startsAt,e.endsAt,e.isFree,e.minPrice,e.ticketUrl,e.venueName,e.venueAddress,confidence,eventId])
  } else {
    const { rows } = await query(`INSERT INTO events (venue_id,name,description,image_url,category,genre,starts_at,ends_at,is_free,min_price,ticket_url,raw_venue_name,raw_address,match_confidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [venueId,e.name,e.description,e.imageUrl,e.category,e.genre,e.startsAt,e.endsAt,e.isFree,e.minPrice,e.ticketUrl,e.venueName,e.venueAddress,confidence])
    eventId = rows[0].id; isNew = true
  }
  await query(`INSERT INTO event_sources (event_id,provider,provider_id,raw) VALUES ($1,$2,$3,$4) ON CONFLICT (provider,provider_id) DO UPDATE SET event_id=EXCLUDED.event_id,raw=EXCLUDED.raw`,
    [eventId,e.provider,e.providerId,e.raw?JSON.stringify(e.raw):null])
  return { isNew }
}

async function syncCity(cityPreset) {
  const cityName = cityPreset.name
  const log = await query(`INSERT INTO sync_log (city,status) VALUES ($1,'running') RETURNING id`, [cityName])
  const logId = log.rows[0].id
  const stats = { venuesAdded:0, venuesUpdated:0, eventsAdded:0, eventsUpdated:0 }
  try {
    logger.info(`=== SYNC START: ${cityName} ===`)
    const [g, f, o] = await Promise.all([
      google.fetchVenues(cityPreset.lat, cityPreset.lng, cityPreset.radiusMeters),
      foursquare.fetchVenues(cityPreset.lat, cityPreset.lng, cityPreset.radiusMeters),
      osm.fetchVenues(cityPreset.bbox),
    ])
    const candidates = [...g, ...f, ...o]
    logger.info(`Raw candidates: ${candidates.length}`)
    const clusters = deduplicate(candidates)
    logger.info(`Unique venues: ${clusters.length}`)
    for (const cluster of clusters) {
      try {
        const merged = mergeCluster(cluster)
        const { isNew } = await upsertVenue(merged, cityName)
        if (isNew) stats.venuesAdded++; else stats.venuesUpdated++
      } catch (err) { logger.error('Venue upsert failed:', err.message) }
    }
    const [sk, eb, tm] = await Promise.all([
      skiddle.fetchEvents(cityPreset.lat, cityPreset.lng, cityPreset.radiusMiles),
      eventbrite.fetchEvents(cityPreset.lat, cityPreset.lng, cityPreset.radiusMiles),
      ticketmaster.fetchEvents(cityPreset.lat, cityPreset.lng, cityPreset.radiusMiles),
    ])
    const allEvents = [...sk, ...eb, ...tm]
    logger.info(`Raw events: ${allEvents.length}`)
    for (const e of allEvents) {
      try {
        const match = await matchEventToVenue(e, cityName)
        if (match.method === 'none') continue
        const { isNew } = await upsertEvent(e, match.venueId, match.confidence)
        if (isNew) stats.eventsAdded++; else stats.eventsUpdated++
      } catch (err) { logger.error('Event upsert failed:', err.message) }
    }
    await query(`UPDATE events SET status='expired' WHERE ends_at < now() OR (ends_at IS NULL AND starts_at < now() - interval '6 hours')`)
    await query(`UPDATE sync_log SET status='done',finished_at=now(),venues_added=$1,venues_updated=$2,events_added=$3,events_updated=$4 WHERE id=$5`,
      [stats.venuesAdded,stats.venuesUpdated,stats.eventsAdded,stats.eventsUpdated,logId])

    // Derive pricing + menu links from the freshly-synced data (best-effort)
    try {
      const { enrichVenueIntelligence } = require('./venueIntelligence')
      await enrichVenueIntelligence(cityName)
    } catch (e) { logger.error('intelligence enrich skipped:', e.message) }

    logger.info(`=== SYNC DONE: ${cityName} ===`, stats)
    return stats
  } catch (err) {
    logger.error(`Sync failed:`, err.message)
    await query(`UPDATE sync_log SET status='error',finished_at=now(),error=$1 WHERE id=$2`, [err.message, logId])
    throw err
  }
}

module.exports = { syncCity }
