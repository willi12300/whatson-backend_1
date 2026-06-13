// src/dedup/venues.ts
// Three-signal deduplication: name similarity + proximity + cross-source ID match

import { haversine } from '../utils/geo'
import { normaliseVenueName, extractDomain, normalisePhone } from '../utils/normalise'
import { logger } from '../utils/logger'

// Jaro-Winkler similarity (lightweight, no external dep needed)
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1
  if (!s1.length || !s2.length) return 0

  const matchDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1
  const s1Matches = new Array(s1.length).fill(false)
  const s2Matches = new Array(s2.length).fill(false)
  let matches = 0
  let transpositions = 0

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDist)
    const end = Math.min(i + matchDist + 1, s2.length)
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue
      s1Matches[i] = true
      s2Matches[j] = true
      matches++
      break
    }
  }

  if (!matches) return 0

  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue
    while (!s2Matches[k]) k++
    if (s1[i] !== s2[k]) transpositions++
    k++
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3

  // Winkler prefix bonus
  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

export interface VenueCandidate {
  id: string           // temporary ID (index in array before DB)
  name: string
  normalisedName: string
  lat: number
  lng: number
  googlePlaceId?: string
  foursquareId?: string
  osmId?: string
  phone?: string | null
  website?: string | null
  sourceData: any      // raw data from the source
  source: 'google' | 'foursquare' | 'osm'
}

export interface DeduplicatedVenue {
  master: VenueCandidate
  duplicates: VenueCandidate[]
}

/**
 * Score two venues on how likely they are the same place.
 * Returns a score 0–3:
 *   3 = definitely same (cross-source ID match)
 *   2 = almost certainly same (name + proximity)
 *   1 = possibly same
 *   0 = different
 */
export function scoreDuplicate(a: VenueCandidate, b: VenueCandidate): number {
  let score = 0

  // Signal 1: name similarity
  const nameSim = jaroWinkler(a.normalisedName, b.normalisedName)
  if (nameSim >= 0.85) score++

  // Signal 2: proximity (< 80 metres)
  const dist = haversine(a.lat, a.lng, b.lat, b.lng)
  if (dist < 80) score++

  // Signal 3: cross-source ID or contact match (strong signal)
  if (a.googlePlaceId && b.googlePlaceId && a.googlePlaceId === b.googlePlaceId) return 3
  if (a.foursquareId && b.foursquareId && a.foursquareId === b.foursquareId) return 3
  if (a.osmId && b.osmId && a.osmId === b.osmId) return 3

  if (a.phone && b.phone) {
    const pa = normalisePhone(a.phone)
    const pb = normalisePhone(b.phone)
    if (pa.length >= 10 && pa === pb) score++
  }

  if (a.website && b.website) {
    const da = extractDomain(a.website)
    const db = extractDomain(b.website)
    if (da && db && da === db) score++
  }

  return score
}

/**
 * Deduplicate a flat array of venue candidates.
 * Uses a simple O(n²) pass — fine for city-scale (< 2000 venues).
 * For large datasets, use spatial index first to limit comparisons.
 */
export function deduplicateVenues(venues: VenueCandidate[]): DeduplicatedVenue[] {
  const used = new Set<number>()
  const groups: DeduplicatedVenue[] = []

  for (let i = 0; i < venues.length; i++) {
    if (used.has(i)) continue

    const group: VenueCandidate[] = []
    const master = venues[i]
    used.add(i)

    for (let j = i + 1; j < venues.length; j++) {
      if (used.has(j)) continue
      const score = scoreDuplicate(master, venues[j])
      if (score >= 2) {
        group.push(venues[j])
        used.add(j)
      }
    }

    groups.push({ master, duplicates: group })
  }

  const dupeCount = groups.reduce((n, g) => n + g.duplicates.length, 0)
  logger.info({ total: venues.length, unique: groups.length, dupes: dupeCount },
    'Venue deduplication complete')

  return groups
}

/**
 * Merge source refs from all duplicates into the master record's sourceRefs JSON
 */
export function mergeSourceRefs(group: DeduplicatedVenue): Record<string, string> {
  const refs: Record<string, string> = {}
  const all = [group.master, ...group.duplicates]
  for (const v of all) {
    if (v.googlePlaceId) refs.google_place_id = v.googlePlaceId
    if (v.foursquareId) refs.foursquare_id = v.foursquareId
    if (v.osmId) refs.osm_id = v.osmId
  }
  return refs
}

/**
 * Pick the best master from a group.
 * Preference: Google > Foursquare > OSM (data quality ordering)
 */
export function pickMaster(group: DeduplicatedVenue): VenueCandidate {
  const all = [group.master, ...group.duplicates]
  return (
    all.find(v => v.source === 'google') ||
    all.find(v => v.source === 'foursquare') ||
    all[0]
  )
}
