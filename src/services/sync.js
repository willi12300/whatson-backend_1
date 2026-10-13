const { query, pool } = require('../db/pool')
const { findDuplicateVenue, canonicalVenueId } = require('./venueIdentity')
const google = require('../clients/google')
const foursquare = require('../clients/foursquare')
const osm = require('../clients/osm')
const skiddle = require('../clients/skiddle')
const eventbrite = require('../clients/eventbrite')
const ticketmaster = require('../clients/ticketmaster')
const { deduplicate, mergeCluster } = require('./dedup')
const { matchEventToVenue } = require('./matchEvents')
const logger = require('../utils/logger')
const { hasUsablePhotos } = require('./photoData')
const { destinationName } = require('./destinations')

function queueEnrichment(venueId, reason) {
  try {
    const { scheduleVenueEnrichment } = require('./backgroundEnrichment')
    scheduleVenueEnrichment(venueId, reason)
  } catch (e) { logger.error('[sync] enrichment queue skipped:', e.message) }
}

async function upsertVenue(v, city) {
 const client=await pool.connect()
 try {
  await client.query('BEGIN')
  await client.query('SELECT pg_advisory_xact_lock(20261012)')
  const result=await upsertVenueRecord(v,city,(text,params)=>client.query(text,params))
  await client.query('COMMIT')
  queueEnrichment(result.id,result.isNew?'new_venue':'refreshed_venue')
  return result
 } catch(e){await client.query('ROLLBACK');throw e} finally{client.release()}
}

async function upsertVenueRecord(v,city,query) {
  const locality=city
  city=destinationName(city,v)
  const sources = Array.isArray(v.sources) ? v.sources.filter(Boolean) : []
  const googleSource = sources.find(s => s.provider === 'google') || null
  const googlePlaceId = googleSource?.providerId || v.googlePlaceId || null
  const googleMapsUrl = googlePlaceId ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name || '')}&query_place_id=${encodeURIComponent(googlePlaceId)}` : null
  let venueId = null,identityMatch=false
  for (const s of sources) {
    const { rows } = await query(`SELECT venue_id FROM venue_sources WHERE provider=$1 AND provider_id=$2`, [s.provider, s.providerId])
    if (rows.length) { venueId = rows[0].venue_id; break }
  }
  if(!venueId&&googlePlaceId){const {rows}=await query('SELECT id FROM venues WHERE google_place_id=$1 ORDER BY claimed DESC,id ASC LIMIT 1',[googlePlaceId]);venueId=rows[0]?.id||null}
  if(!venueId){const duplicate=await findDuplicateVenue(v,query);venueId=duplicate?.id||null;identityMatch=!!duplicate}
  if(venueId)venueId=await canonicalVenueId(venueId,query)
  const isNew = !venueId
  if (venueId) {
    const incomingPhotos = hasUsablePhotos(v.photos) ? JSON.stringify(v.photos) : null
    const incomingCover = typeof v.coverPhoto === 'string' && v.coverPhoto.trim() ? v.coverPhoto : null
    if(identityMatch){
      await query(`UPDATE venues SET address=COALESCE(address,$1),phone=COALESCE(phone,$2),website=COALESCE(website,$3),rating=COALESCE(rating,$4),rating_count=COALESCE(rating_count,$5),google_place_id=COALESCE(google_place_id,$6),google_maps_url=COALESCE(google_maps_url,$7),photos=CASE WHEN jsonb_array_length(COALESCE(photos,'[]'::jsonb))=0 THEN COALESCE($8::jsonb,photos) ELSE photos END,cover_photo=COALESCE(cover_photo,$9),last_seen_at=now() WHERE id=$10`,[v.address,v.phone,v.website,v.rating,v.ratingCount,googlePlaceId,googleMapsUrl,incomingPhotos,incomingCover,venueId])
    }else {
    await query(`UPDATE venues SET name=$1,normalised_name=$2,category_slug=$3,lat=$4,lng=$5,address=$6,postcode=$7,phone=$8,website=$9,rating=$10,rating_count=$11,price_level=$12,opening_hours=$13,business_status=$14,photos=COALESCE($15::jsonb, photos),cover_photo=COALESCE($16, cover_photo),city=$17,google_place_id=COALESCE($18, google_place_id),google_maps_url=COALESCE(google_maps_url,$19),source_locality=COALESCE(source_locality,$21),updated_at=now(),last_seen_at=now() WHERE id=$20`,
      [v.name,v.normalisedName,v.category,v.lat,v.lng,v.address,v.postcode,v.phone,v.website,v.rating,v.ratingCount,v.priceLevel,v.openingHours?JSON.stringify(v.openingHours):null,v.businessStatus,incomingPhotos,incomingCover,city,googlePlaceId,googleMapsUrl,venueId,locality])
    }
  } else {
    const { rows } = await query(`INSERT INTO venues (name,normalised_name,category_slug,lat,lng,address,postcode,phone,website,rating,rating_count,price_level,opening_hours,business_status,photos,cover_photo,city,google_place_id,google_maps_url,source_locality) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
      [v.name,v.normalisedName,v.category,v.lat,v.lng,v.address,v.postcode,v.phone,v.website,v.rating,v.ratingCount,v.priceLevel,v.openingHours?JSON.stringify(v.openingHours):null,v.businessStatus,JSON.stringify(v.photos||[]),v.coverPhoto,city,googlePlaceId,googleMapsUrl,locality])
    venueId = rows[0].id
  }
  for (const s of sources) {
    await query(`INSERT INTO venue_sources (venue_id,provider,provider_id,raw) VALUES ($1,$2,$3,$4) ON CONFLICT (provider,provider_id) DO UPDATE SET venue_id=EXCLUDED.venue_id,raw=EXCLUDED.raw`,
      [venueId,s.provider,s.providerId,s.raw?JSON.stringify(s.raw):null])
  }
  // Any venue discovered or refreshed by APIs should become richer over time.
  // Fire-and-forget so city sync / roulette / concierge stay fast.
  // Queue enrichment only after the wrapper commits the transaction.
  return { id: venueId, isNew }
}

async function upsertEvent(e, venueId, confidence) {
  const existing = await query(`SELECT e.id FROM events e JOIN event_sources es ON es.event_id=e.id WHERE es.provider=$1 AND es.provider_id=$2`, [e.provider, e.providerId])
  let eventId, isNew = false
  if (existing.rows.length) {
    eventId = existing.rows[0].id
    await query(`UPDATE events SET venue_id=$1,name=$2,description=$3,image_url=$4,category=$5,genre=$6,starts_at=$7,ends_at=$8,is_free=$9,min_price=$10,ticket_url=$11,raw_venue_name=$12,raw_address=$13,match_confidence=$14,status=CASE WHEN $7::timestamptz >= now() THEN 'active' ELSE status END,updated_at=now() WHERE id=$15`,
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
    // Google grid-tiling is the PRIMARY source (high quality, deep coverage despite the
    // 20-per-request cap). OSM is an optional supplement controlled by SYNC_USE_OSM.
    const useOsm = process.env.SYNC_USE_OSM === 'true'   // default OFF — Google-first
    const gridSize = parseInt(process.env.SYNC_GRID_SIZE || '4', 10)
    const [g, f, o] = await Promise.all([
      google.fetchVenuesGrid(cityPreset.lat, cityPreset.lng, cityPreset.radiusMeters, { gridSize }),
      foursquare.fetchVenues(cityPreset.lat, cityPreset.lng, cityPreset.radiusMeters),
      useOsm ? osm.fetchVenues(cityPreset.bbox) : Promise.resolve([]),
    ])
    logger.info(`Sources → Google(grid): ${g.length}, Foursquare: ${f.length}, OSM: ${o.length}`)
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

module.exports = { syncCity, upsertVenue, upsertEvent }

