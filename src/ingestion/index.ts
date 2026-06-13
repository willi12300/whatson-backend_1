// src/ingestion/index.ts
// Run: npm run ingest:all  |  npm run ingest:venues  |  npm run ingest:events

import { prisma } from '../db/client'
import { ingestGooglePlaces, getGooglePhotoUrl } from './google'
import { ingestFoursquare } from './foursquare'
import { ingestOsm } from './osm'
import { ingestSkiddle } from './skiddle'
import { ingestEventbrite } from './eventbrite'
import { deduplicateVenues, mergeSourceRefs, pickMaster, VenueCandidate } from '../dedup/venues'
import { matchEventToVenue } from '../matching/eventToVenue'
import { normaliseVenueName } from '../utils/normalise'
import { logger } from '../utils/logger'

// ─── Map source types to our VenueType enum ───────────────────────────────

function googleTypeToVenueType(types: string[]): string {
  if (types.includes('night_club')) return 'NIGHTCLUB'
  if (types.includes('bar')) return 'BAR'
  if (types.includes('pub')) return 'PUB'
  if (types.includes('restaurant')) return 'RESTAURANT'
  if (types.includes('cafe')) return 'CAFE'
  if (types.includes('comedy_club')) return 'COMEDY_CLUB'
  if (types.includes('karaoke')) return 'KARAOKE'
  return 'OTHER'
}

function osmAmenityToVenueType(amenity: string): string {
  const map: Record<string, string> = {
    pub: 'PUB', bar: 'BAR', nightclub: 'NIGHTCLUB',
    cafe: 'CAFE', restaurant: 'RESTAURANT',
    music_venue: 'MUSIC_VENUE', comedy_club: 'COMEDY_CLUB',
    karaoke: 'KARAOKE'
  }
  return map[amenity] || 'OTHER'
}

// ─── Venues ingestion ─────────────────────────────────────────────────────

export async function runVenueIngestion() {
  logger.info('=== Starting venue ingestion ===')

  // 1. Fetch from all sources in parallel
  const [googleVenues, foursquareVenues, osmVenues] = await Promise.all([
    ingestGooglePlaces(),
    ingestFoursquare(),
    ingestOsm()
  ])

  logger.info({
    google: googleVenues.length,
    foursquare: foursquareVenues.length,
    osm: osmVenues.length
  }, 'Raw venue counts')

  // 2. Normalise to candidates
  const candidates: VenueCandidate[] = [
    ...googleVenues.map((v, i) => ({
      id: `g_${i}`,
      name: v.name,
      normalisedName: normaliseVenueName(v.name),
      lat: v.lat, lng: v.lng,
      googlePlaceId: v.googlePlaceId,
      phone: v.phone, website: v.website,
      source: 'google' as const,
      sourceData: v
    })),
    ...foursquareVenues.map((v, i) => ({
      id: `f_${i}`,
      name: v.name,
      normalisedName: normaliseVenueName(v.name),
      lat: v.lat, lng: v.lng,
      foursquareId: v.foursquareId,
      phone: v.phone, website: v.website,
      source: 'foursquare' as const,
      sourceData: v
    })),
    ...osmVenues.map((v, i) => ({
      id: `o_${i}`,
      name: v.name,
      normalisedName: normaliseVenueName(v.name),
      lat: v.lat, lng: v.lng,
      osmId: v.osmId,
      source: 'osm' as const,
      sourceData: v
    }))
  ]

  // 3. Deduplicate
  const deduped = deduplicateVenues(candidates)
  logger.info({ unique: deduped.length }, 'Unique venues after dedup')

  // 4. Upsert into database
  let created = 0, updated = 0

  for (const group of deduped) {
    const master = pickMaster(group)
    const sourceRefs = mergeSourceRefs(group)
    const d = master.sourceData

    const venueType = master.source === 'google'
      ? googleTypeToVenueType(d.types)
      : master.source === 'osm'
        ? osmAmenityToVenueType(d.amenity)
        : 'OTHER'

    const photos = master.source === 'google'
      ? (d.photos || []).slice(0, 3).map((p: any) => ({
          url: getGooglePhotoUrl(p.name),
          source: 'google', width: p.widthPx, height: p.heightPx
        }))
      : master.source === 'foursquare'
        ? (d.photos || []).map((url: string) => ({ url, source: 'foursquare' }))
        : []

    // Check if venue already exists (by any source ID)
    let existing = null
    if (sourceRefs.google_place_id) {
      existing = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Venue" WHERE "sourceRefs"->>'google_place_id' = ${sourceRefs.google_place_id} LIMIT 1
      `
    }
    if (!existing?.length && sourceRefs.foursquare_id) {
      existing = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Venue" WHERE "sourceRefs"->>'foursquare_id' = ${sourceRefs.foursquare_id} LIMIT 1
      `
    }

    const upsertData = {
      name: d.name,
      lat: master.lat, lng: master.lng,
      address: d.address || '',
      city: 'Liverpool', country: 'GB',
      venueType: venueType as any,
      rating: d.rating || null,
      ratingCount: d.ratingCount || null,
      priceLevel: d.priceLevel || null,
      phone: d.phone || null,
      website: d.website || null,
      openingHours: d.openingHours || null,
      businessStatus: d.businessStatus || null,
      photos: photos,
      coverPhoto: photos[0]?.url || null,
      sourceRefs,
      lastSeenAt: new Date()
    }

    if (existing?.length) {
      await prisma.venue.update({ where: { id: existing[0].id }, data: upsertData })
      updated++
    } else {
      await prisma.venue.create({ data: { ...upsertData, canonical: true, claimed: false } })
      created++
    }
  }

  logger.info({ created, updated }, '=== Venue ingestion complete ===')
}

// ─── Events ingestion ─────────────────────────────────────────────────────

export async function runEventIngestion() {
  logger.info('=== Starting event ingestion ===')

  const [skiddleEvents, eventbriteEvents] = await Promise.all([
    ingestSkiddle(),
    ingestEventbrite()
  ])

  const allRaw = [
    ...skiddleEvents.map(e => ({ ...e, externalIdSource: 'skiddle' as const, externalVenueId: e.skiddleVenueId || undefined })),
    ...eventbriteEvents.map(e => ({ ...e, externalIdSource: 'eventbrite' as const, externalVenueId: e.eventbriteVenueId || undefined }))
  ]

  let created = 0, updated = 0, unmatched = 0

  for (const raw of allRaw) {
    const match = await matchEventToVenue({
      venueName: raw.venueName,
      venueAddress: raw.venueAddress,
      venueLat: raw.venueLat || undefined,
      venueLng: raw.venueLng || undefined,
      externalVenueId: raw.externalVenueId,
      externalIdSource: raw.externalIdSource
    })

    if (match.method === 'none') { unmatched++; continue }

    const source = raw.externalIdSource
    const sourceRefKey = source === 'skiddle' ? 'skiddle_id'
      : source === 'eventbrite' ? 'eventbrite_id' : 'ticketmaster_id'
    const sourceId = source === 'skiddle' ? (raw as any).skiddleId : (raw as any).eventbriteId

    // Check for existing event
    const existing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Event" WHERE "sourceRefs"->>${sourceRefKey} = ${sourceId} LIMIT 1
    `

    const data = {
      venueId: match.venueId,
      name: raw.name,
      description: raw.description,
      imageUrl: raw.imageUrl,
      startsAt: raw.startsAt,
      endsAt: raw.endsAt,
      isFree: raw.isFree,
      minPrice: raw.minPrice,
      ticketUrl: raw.ticketUrl,
      rawVenueName: raw.venueName,
      rawAddress: raw.venueAddress,
      matchedConfidence: match.confidence,
      sourceRefs: { [sourceRefKey]: sourceId },
      status: 'ACTIVE' as const
    }

    if (existing.length) {
      await prisma.event.update({ where: { id: existing[0].id }, data })
      updated++
    } else {
      await prisma.event.create({ data })
      created++
    }
  }

  logger.info({ created, updated, unmatched }, '=== Event ingestion complete ===')
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────

const arg = process.argv[2]
if (arg === 'venues') runVenueIngestion().then(() => process.exit(0))
else if (arg === 'events') runEventIngestion().then(() => process.exit(0))
else if (arg === 'all') {
  runVenueIngestion()
    .then(runEventIngestion)
    .then(() => process.exit(0))
}
