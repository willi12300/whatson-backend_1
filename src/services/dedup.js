// src/services/dedup.js
// Deduplicate venue candidates from multiple providers into canonical records.

const {
  distanceMeters,
  normaliseName,
  normalisePhone,
  extractDomain,
  jaroWinkler,
} = require('../utils/helpers')

/**
 * Score how likely two venue candidates are the same place.
 * Returns 0..3+. We treat >= 2 as a duplicate.
 *  - cross-source contact match (phone/website) is a strong extra point
 */
function scoreDuplicate(a, b) {
  let score = 0

  const nameSim = jaroWinkler(normaliseName(a.name), normaliseName(b.name))
  if (nameSim >= 0.85) score++

  const dist = distanceMeters(a.lat, a.lng, b.lat, b.lng)
  if (dist < 80) score++

  // contact matches
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

// Provider quality ranking — higher wins as the "master" record
const PROVIDER_RANK = { google: 3, foursquare: 2, osm: 1 }

/**
 * Group candidates into clusters of duplicates.
 * Input: flat array of candidates from all providers.
 * Output: array of clusters, each { master, members: [...] }.
 */
function deduplicate(candidates) {
  const used = new Array(candidates.length).fill(false)
  const clusters = []

  for (let i = 0; i < candidates.length; i++) {
    if (used[i]) continue
    const members = [candidates[i]]
    used[i] = true

    for (let j = i + 1; j < candidates.length; j++) {
      if (used[j]) continue
      // compare against any member already in the cluster
      const isDupe = members.some((m) => scoreDuplicate(m, candidates[j]) >= 2)
      if (isDupe) {
        members.push(candidates[j])
        used[j] = true
      }
    }

    // pick the master = highest provider rank, tiebreak by most data
    const master = members.slice().sort((x, y) => {
      const r = (PROVIDER_RANK[y.provider] || 0) - (PROVIDER_RANK[x.provider] || 0)
      if (r !== 0) return r
      return scoreData(y) - scoreData(x)
    })[0]

    clusters.push({ master, members })
  }

  return clusters
}

// crude "how complete is this record" score for tiebreaking
function scoreData(c) {
  let s = 0
  if (c.rating) s++
  if (c.phone) s++
  if (c.website) s++
  if (c.photos && c.photos.length) s += 2
  if (c.openingHours) s++
  if (c.address) s++
  return s
}

/**
 * Merge a cluster into a single venue object ready for DB upsert.
 * Fills gaps in the master from other members.
 */
function mergeCluster(cluster) {
  const { master, members } = cluster

  const merged = {
    name: master.name,
    normalisedName: normaliseName(master.name),
    lat: master.lat,
    lng: master.lng,
    address: master.address || null,
    postcode: master.postcode || null,
    phone: master.phone || null,
    website: master.website || null,
    rating: master.rating ?? null,
    ratingCount: master.ratingCount ?? null,
    priceLevel: master.priceLevel ?? null,
    openingHours: master.openingHours || null,
    businessStatus: master.businessStatus || null,
    photos: master.photos || [],
    category: deriveCategory(master),
    sources: [],
  }

  // fill gaps from other members
  for (const m of members) {
    if (!merged.address && m.address) merged.address = m.address
    if (!merged.postcode && m.postcode) merged.postcode = m.postcode
    if (!merged.phone && m.phone) merged.phone = m.phone
    if (!merged.website && m.website) merged.website = m.website
    if (merged.rating == null && m.rating != null) merged.rating = m.rating
    if (merged.priceLevel == null && m.priceLevel != null) merged.priceLevel = m.priceLevel
    if ((!merged.photos || !merged.photos.length) && m.photos?.length) merged.photos = m.photos
    if (!merged.openingHours && m.openingHours) merged.openingHours = m.openingHours
    // collect every source
    merged.sources.push({ provider: m.provider, providerId: m.providerId, raw: m.raw })
  }

  merged.coverPhoto = merged.photos?.[0]?.url || null
  return merged
}

// Map provider-specific types to our category slugs
function deriveCategory(c) {
  if (c.category) return c.category // OSM already gives us a slug
  const types = c.types || []
  const primary = (c.primaryType || '').toLowerCase()
  const cats = (c.categories || []).join(' ').toLowerCase()

  if (types.includes('night_club') || primary.includes('night_club') || cats.includes('night'))
    return 'nightclub'
  if (types.includes('bar') || primary.includes('bar') || cats.includes('bar')) return 'bar'
  if (types.includes('pub') || primary.includes('pub') || cats.includes('pub')) return 'pub'
  if (types.includes('cafe') || primary.includes('cafe') || cats.includes('cafe') || cats.includes('coffee'))
    return 'cafe'
  if (types.includes('restaurant') || primary.includes('restaurant') || cats.includes('restaurant'))
    return 'restaurant'
  if (cats.includes('music')) return 'music_venue'
  return 'other'
}

module.exports = { deduplicate, mergeCluster, scoreDuplicate }
