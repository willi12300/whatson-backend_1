// src/matching/eventToVenue.ts
import { prisma } from '../db/client'
import { haversine } from '../utils/geo'
import { normaliseVenueName } from '../utils/normalise'
import { logger } from '../utils/logger'

// Simple Jaro-Winkler — same as in dedup
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1.0
  if (!s1.length || !s2.length) return 0
  const matchDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1
  const s1m = new Array(s1.length).fill(false)
  const s2m = new Array(s2.length).fill(false)
  let matches = 0, t = 0
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist)
    const hi = Math.min(i + matchDist + 1, s2.length)
    for (let j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue
      s1m[i] = s2m[j] = true; matches++; break
    }
  }
  if (!matches) return 0
  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1m[i]) continue
    while (!s2m[k]) k++
    if (s1[i] !== s2[k]) t++; k++
  }
  const j = (matches / s1.length + matches / s2.length + (matches - t / 2) / matches) / 3
  let p = 0
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) p++; else break
  }
  return j + p * 0.1 * (1 - j)
}

export interface EventToMatch {
  venueName: string
  venueAddress?: string
  venueLat?: number
  venueLng?: number
  externalVenueId?: string
  externalIdSource?: 'skiddle' | 'eventbrite' | 'ticketmaster'
}

export interface MatchResult {
  venueId: string | null
  confidence: number  // 0.0–1.0
  method: 'external_id' | 'name_proximity' | 'name_only' | 'stub' | 'none'
}

export async function matchEventToVenue(event: EventToMatch): Promise<MatchResult> {

  // ── Step 1: External venue ID match (highest confidence) ──────────────────
  if (event.externalVenueId && event.externalIdSource) {
    const keyMap = {
      skiddle: 'skiddle_venue_id',
      eventbrite: 'eventbrite_venue_id',
      ticketmaster: 'ticketmaster_venue_id'
    }
    const jsonKey = keyMap[event.externalIdSource]
    const v = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Venue"
      WHERE canonical = true
        AND "sourceRefs"->>${jsonKey} = ${event.externalVenueId}
      LIMIT 1
    `
    if (v.length) return { venueId: v[0].id, confidence: 1.0, method: 'external_id' }
  }

  // ── Step 2: Name + proximity match ────────────────────────────────────────
  if (event.venueLat && event.venueLng) {
    const candidates = await prisma.$queryRaw<Array<{ id: string; name: string; dist: number }>>`
      SELECT id, name,
        ST_Distance(
          ST_MakePoint(lng, lat)::geography,
          ST_MakePoint(${event.venueLng}, ${event.venueLat})::geography
        ) as dist
      FROM "Venue"
      WHERE canonical = true
        AND ST_DWithin(
          ST_MakePoint(lng, lat)::geography,
          ST_MakePoint(${event.venueLng}, ${event.venueLat})::geography,
          300
        )
      ORDER BY dist ASC
      LIMIT 10
    `

    let bestVenueId: string | null = null
    let bestScore = 0

    const normEventVenue = normaliseVenueName(event.venueName)

    for (const c of candidates) {
      const nameSim = jaroWinkler(normEventVenue, normaliseVenueName(c.name))
      // Combined score: 70% name similarity + 30% proximity (closer = higher)
      const proxScore = Math.max(0, 1 - c.dist / 300)
      const combined = nameSim * 0.7 + proxScore * 0.3

      if (nameSim >= 0.70 && combined > bestScore) {
        bestScore = combined
        bestVenueId = c.id
      }
    }

    if (bestVenueId) {
      return { venueId: bestVenueId, confidence: bestScore, method: 'name_proximity' }
    }
  }

  // ── Step 3: Name-only fuzzy search (no coordinates) ───────────────────────
  const normName = normaliseVenueName(event.venueName)
  if (normName.length > 3) {
    const byName = await prisma.$queryRaw<Array<{ id: string; name: string }>>`
      SELECT id, name
      FROM "Venue"
      WHERE canonical = true AND city = 'Liverpool'
      ORDER BY similarity(lower(name), ${normName}) DESC
      LIMIT 3
    `
    if (byName.length) {
      const sim = jaroWinkler(normName, normaliseVenueName(byName[0].name))
      if (sim >= 0.65) {
        return { venueId: byName[0].id, confidence: sim * 0.6, method: 'name_only' }
      }
    }
  }

  // ── Step 4: Create stub venue from event data ─────────────────────────────
  if (event.venueLat && event.venueLng && event.venueName) {
    try {
      const stub = await prisma.venue.create({
        data: {
          name: event.venueName,
          lat: event.venueLat,
          lng: event.venueLng,
          address: event.venueAddress || '',
          city: 'Liverpool',
          canonical: true,
          claimed: false,
          sourceRefs: {}
        }
      })
      logger.info({ name: event.venueName }, 'Created stub venue for unmatched event')
      return { venueId: stub.id, confidence: 0.3, method: 'stub' }
    } catch (err) {
      // stub creation failed (e.g. duplicate slug)
    }
  }

  return { venueId: null, confidence: 0, method: 'none' }
}
