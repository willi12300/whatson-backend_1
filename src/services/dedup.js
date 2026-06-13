const { distanceMeters, normaliseName, normalisePhone, extractDomain, jaroWinkler } = require('../utils/helpers')

const PROVIDER_RANK = { google: 3, foursquare: 2, osm: 1 }

function scoreDuplicate(a, b) {
  let score = 0
  if (jaroWinkler(normaliseName(a.name), normaliseName(b.name)) >= 0.85) score++
  if (distanceMeters(a.lat, a.lng, b.lat, b.lng) < 80) score++
  if (a.phone && b.phone && normalisePhone(a.phone).length >= 10 && normalisePhone(a.phone) === normalisePhone(b.phone)) score++
  if (a.website && b.website && extractDomain(a.website) && extractDomain(a.website) === extractDomain(b.website)) score++
  return score
}

function deduplicate(candidates) {
  const used = new Array(candidates.length).fill(false)
  const clusters = []
  for (let i = 0; i < candidates.length; i++) {
    if (used[i]) continue
    const members = [candidates[i]]
    used[i] = true
    for (let j = i + 1; j < candidates.length; j++) {
      if (used[j]) continue
      if (members.some(m => scoreDuplicate(m, candidates[j]) >= 2)) {
        members.push(candidates[j]); used[j] = true
      }
    }
    const master = members.slice().sort((x, y) => (PROVIDER_RANK[y.provider] || 0) - (PROVIDER_RANK[x.provider] || 0))[0]
    clusters.push({ master, members })
  }
  return clusters
}

function mergeCluster({ master, members }) {
  const merged = {
    name: master.name,
    normalisedName: normaliseName(master.name),
    lat: master.lat, lng: master.lng,
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
  for (const m of members) {
    if (!merged.address && m.address) merged.address = m.address
    if (!merged.postcode && m.postcode) merged.postcode = m.postcode
    if (!merged.phone && m.phone) merged.phone = m.phone
    if (!merged.website && m.website) merged.website = m.website
    if (merged.rating == null && m.rating != null) merged.rating = m.rating
    if (!merged.photos?.length && m.photos?.length) merged.photos = m.photos
    if (!merged.openingHours && m.openingHours) merged.openingHours = m.openingHours
    merged.sources.push({ provider: m.provider, providerId: m.providerId, raw: m.raw })
  }
  merged.coverPhoto = merged.photos?.[0]?.url || null
  return merged
}

function deriveCategory(c) {
  if (c.category) return c.category
  const types = c.types || []
  const primary = (c.primaryType || '').toLowerCase()
  const cats = (c.categories || []).join(' ').toLowerCase()
  if (types.includes('night_club') || primary.includes('night_club')) return 'nightclub'
  if (types.includes('bar') || primary.includes('bar') || cats.includes('bar')) return 'bar'
  if (types.includes('pub') || primary.includes('pub') || cats.includes('pub')) return 'pub'
  if (types.includes('cafe') || primary.includes('cafe') || cats.includes('coffee')) return 'cafe'
  if (types.includes('restaurant') || primary.includes('restaurant') || cats.includes('restaurant')) return 'restaurant'
  if (cats.includes('music')) return 'music_venue'
  return 'other'
}

module.exports = { deduplicate, mergeCluster }
