const axios = require('axios')
const { config } = require('../config')
const logger = require('../utils/logger')

const BASE = 'https://api.content.tripadvisor.com/api/v1'

function hasTripAdvisor() {
  return !!config.tripadvisor?.key
}

function normaliseCategory(categorySlug) {
  if (!categorySlug) return 'attractions'
  const cat = String(categorySlug).toLowerCase()
  if (['restaurant', 'cafe', 'bakery', 'food', 'brunch'].includes(cat)) return 'restaurants'
  if (['bar', 'pub', 'nightclub', 'music_venue', 'comedy_club'].includes(cat)) return 'attractions'
  if (['hotel', 'lodging', 'accommodation'].includes(cat)) return 'hotels'
  return 'attractions'
}

function formatLatLong(lat, lng) {
  if (lat == null || lng == null) return undefined
  return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`
}

function normaliseText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanSearchName(name) {
  return String(name || '')
    .replace(/[’`´]/g, "'")
    .replace(/\b(cocktail bar|bar|pub|club|nightclub|restaurant|cafe|coffee shop|venue|liverpool|manchester|uk|united kingdom)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function noPunctuationVariant(name) {
  return String(name || '')
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractCity(address = '') {
  const a = String(address || '')
  const known = ['Liverpool', 'Manchester', 'London', 'Birmingham', 'Leeds', 'Chester', 'York']
  return known.find(c => new RegExp(`\\b${c}\\b`, 'i').test(a)) || null
}

function tripadvisorNameScore(query, itemName) {
  const q = normaliseText(query)
  const n = normaliseText(itemName)
  if (!q || !n) return 999
  if (n === q) return 0
  if (n.includes(q) || q.includes(n)) return 1
  const qWords = q.split(' ').filter(w => w.length > 2)
  const nWords = new Set(n.split(' ').filter(Boolean))
  const overlap = qWords.filter(w => nWords.has(w)).length
  const missPenalty = Math.max(0, qWords.length - overlap)
  return 10 - overlap + missPenalty
}

function buildTripAdvisorQueries({ name, address, city }) {
  const out = []
  const push = q => {
    q = String(q || '').replace(/\s+/g, ' ').trim()
    if (q && !out.some(x => normaliseText(x) === normaliseText(q))) out.push(q)
  }
  const cleaned = cleanSearchName(name)
  const noPunc = noPunctuationVariant(name)
  const resolvedCity = city || extractCity(address)
  push(name)
  if (resolvedCity) push(`${name} ${resolvedCity}`)
  if (cleaned) push(cleaned)
  if (cleaned && resolvedCity) push(`${cleaned} ${resolvedCity}`)
  if (noPunc && noPunc !== name) push(noPunc)
  if (noPunc && resolvedCity) push(`${noPunc} ${resolvedCity}`)
  if (address) push(`${name} ${address}`)
  return out
}

async function searchTripAdvisorLocation({ name, lat, lng, address, categorySlug, radiusKm = 5 }) {
  if (!hasTripAdvisor() || !name) return null

  const latLong = formatLatLong(lat, lng)
  const baseParams = {
    key: config.tripadvisor.key,
    language: 'en',
  }
  if (latLong) baseParams.latLong = latLong
  if (address) baseParams.address = address
  if (radiusKm) baseParams.radius = radiusKm

  const city = arguments[0]?.city || extractCity(address)
  const queryVariants = buildTripAdvisorQueries({ name, address, city })
  const searches = []
  const cat = normaliseCategory(categorySlug)
  const categories = [cat, undefined]

  // Bars/clubs/events are often stored in inconsistent TripAdvisor buckets.
  const slug = String(categorySlug || '').toLowerCase()
  if (['bar', 'pub', 'nightclub', 'club', 'music_venue', 'comedy_club', 'event', 'events'].includes(slug)) {
    categories.push('restaurants', 'attractions')
  }
  if (['restaurant', 'cafe', 'bakery', 'food', 'brunch'].includes(slug)) {
    categories.push('restaurants')
  }

  for (const q of queryVariants) {
    for (const category of categories) {
      searches.push(category ? { searchQuery: q, category } : { searchQuery: q })
    }
  }

  const seen = new Set()
  let allLocations = []

  for (const extra of searches) {
    const key = JSON.stringify(extra)
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const res = await axios.get(`${BASE}/location/search`, {
        params: { ...baseParams, ...extra },
        timeout: 4500,
      })
      const locations = res.data?.data || []
      if (locations.length) {
        allLocations = allLocations.concat(locations.map(l => ({ ...l, _query: extra.searchQuery })))
        // If there is a strong exact/contains match, no need to keep trying.
        if (locations.some(l => tripadvisorNameScore(extra.searchQuery, l.name) <= 1)) break
      }
    } catch (err) {
      logger.error('[tripadvisor] search failed:', err.response?.status || err.message)
    }
  }

  if (!allLocations.length) {
    logger.info(`[tripadvisor] no match for ${name}; tried ${seen.size} queries`)
    return null
  }

  const sorted = allLocations.slice().sort((a, b) => {
    const aNameScore = Math.min(tripadvisorNameScore(name, a.name), tripadvisorNameScore(cleaned || name, a.name))
    const bNameScore = Math.min(tripadvisorNameScore(name, b.name), tripadvisorNameScore(cleaned || name, b.name))
    if (aNameScore !== bNameScore) return aNameScore - bNameScore
    const ad = Number(a.distance || 999)
    const bd = Number(b.distance || 999)
    return ad - bd
  })

  const best = sorted[0] || null
  if (best) logger.info(`[tripadvisor] match ${name} -> ${best.name || best.location_id} (${best.location_id})`)
  return best
}

async function getTripAdvisorDetails(locationId) {
  if (!hasTripAdvisor() || !locationId) return null
  try {
    const res = await axios.get(`${BASE}/location/${locationId}/details`, {
      params: { key: config.tripadvisor.key, language: 'en', currency: 'GBP' },
      timeout: 4500,
    })
    return res.data || null
  } catch (err) {
    logger.error('[tripadvisor] details failed:', err.response?.status || err.message)
    return null
  }
}

async function getTripAdvisorReviews(locationId) {
  if (!hasTripAdvisor() || !locationId) return []
  try {
    const res = await axios.get(`${BASE}/location/${locationId}/reviews`, {
      params: { key: config.tripadvisor.key, language: 'en' },
      timeout: 4500,
    })
    return res.data?.data || []
  } catch (err) {
    logger.error('[tripadvisor] reviews failed:', err.response?.status || err.message)
    return []
  }
}

function normaliseTripAdvisor({ search, details, reviews }) {
  if (!search && !details) return null
  const d = details || {}
  const top = reviews?.[0] || null
  return {
    locationId: String(d.location_id || search?.location_id || ''),
    rating: d.rating != null ? Number(d.rating) : null,
    reviewCount: d.num_reviews != null ? Number(d.num_reviews) : null,
    ranking: d.ranking_data?.ranking_string || d.ranking || null,
    url: d.web_url || null,
    photoUrl: d.photo?.images?.large?.url || d.photo?.images?.medium?.url || null,
    topReview: top ? {
      text: top.text || top.title || null,
      author: top.user?.username || top.author || 'TripAdvisor traveller',
      rating: top.rating != null ? Number(top.rating) : null,
      publishedDate: top.published_date || null,
      url: top.url || null,
      source: 'tripadvisor',
    } : null,
    raw: { search, details, reviews: reviews?.slice?.(0, 3) || [] },
  }
}

async function enrichTripAdvisorForVenue(venue) {
  if (!hasTripAdvisor()) return null
  const search = venue.tripadvisor_location_id
    ? { location_id: venue.tripadvisor_location_id, name: venue.name }
    : await searchTripAdvisorLocation({
        name: venue.name,
        lat: venue.lat,
        lng: venue.lng,
        address: venue.address,
        city: venue.city,
        categorySlug: venue.category_slug,
      })
  const locationId = search?.location_id || search?.locationId || venue.tripadvisor_location_id
  if (!locationId) return null

  const [details, reviews] = await Promise.all([
    getTripAdvisorDetails(locationId),
    getTripAdvisorReviews(locationId),
  ])
  return normaliseTripAdvisor({ search, details, reviews })
}

module.exports = {
  hasTripAdvisor,
  searchTripAdvisorLocation,
  getTripAdvisorDetails,
  getTripAdvisorReviews,
  enrichTripAdvisorForVenue,
}
