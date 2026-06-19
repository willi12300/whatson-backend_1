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

async function searchTripAdvisorLocation({ name, lat, lng, address, categorySlug, radiusKm = 3 }) {
  if (!hasTripAdvisor() || !name) return null
  try {
    const params = {
      key: config.tripadvisor.key,
      searchQuery: name,
      language: 'en',
      category: normaliseCategory(categorySlug),
    }
    const latLong = formatLatLong(lat, lng)
    if (latLong) params.latLong = latLong
    if (address) params.address = address
    if (radiusKm) params.radius = radiusKm

    const res = await axios.get(`${BASE}/location/search`, { params, timeout: 4500 })
    const locations = res.data?.data || []
    if (!locations.length) return null

    // Pick closest/name-sensible result. TA returns distance when latLong is supplied.
    const lower = String(name).toLowerCase()
    const sorted = locations.slice().sort((a, b) => {
      const aName = String(a.name || '').toLowerCase()
      const bName = String(b.name || '').toLowerCase()
      const aNameScore = aName.includes(lower) || lower.includes(aName) ? 0 : 1
      const bNameScore = bName.includes(lower) || lower.includes(bName) ? 0 : 1
      if (aNameScore !== bNameScore) return aNameScore - bNameScore
      const ad = Number(a.distance || 999)
      const bd = Number(b.distance || 999)
      return ad - bd
    })
    return sorted[0] || null
  } catch (err) {
    logger.error('[tripadvisor] search failed:', err.response?.status || err.message)
    return null
  }
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
