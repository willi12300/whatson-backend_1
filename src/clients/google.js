const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const TYPES = ['bar', 'night_club', 'restaurant', 'cafe', 'pub']

async function searchType(lat, lng, radius, type) {
  try {
    const res = await axios.post(
      'https://places.googleapis.com/v1/places:searchNearby',
      {
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
        includedTypes: [type],
        maxResultCount: 20,
      },
      {
        headers: {
          'X-Goog-Api-Key': config.google.key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours,places.photos,places.internationalPhoneNumber,places.websiteUri,places.businessStatus',
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    )
    return (res.data.places || []).map(p => ({
      provider: 'google',
      providerId: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      types: p.types || [],
      primaryType: p.primaryType || type,
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      priceLevel: p.priceLevel ?? null,
      phone: p.internationalPhoneNumber || null,
      website: p.websiteUri || null,
      businessStatus: p.businessStatus || null,
      openingHours: p.regularOpeningHours || null,
      photos: (p.photos || []).slice(0, 3).map(ph => ({
        url: `https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=400&key=${config.google.key}`,
        source: 'google',
      })),
      raw: p,
    }))
  } catch (err) {
    logger.error(`Google searchType(${type}) failed:`, err.response?.data?.error?.message || err.message)
    return []
  }
}

async function fetchVenues(lat, lng, radius) {
  if (!config.google.key) { logger.warn('Google key missing'); return [] }
  const seen = new Set()
  const out = []
  for (const type of TYPES) {
    const batch = await searchType(lat, lng, radius, type)
    for (const v of batch) {
      if (!seen.has(v.providerId)) { seen.add(v.providerId); out.push(v) }
    }
    await sleep(150)
  }
  logger.info(`Google Places: ${out.length} venues`)
  return out
}

// Look up a place by name + address → returns { lat, lng, address, photoUrl, rating } or null.
// Used to give Gemini's "Sappo pick" stops real coordinates for the map.
async function findPlace(textQuery) {
  if (!config.google.key) return null
  try {
    const res = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      { textQuery, maxResultCount: 1 },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.key,
          'X-Goog-FieldMask': 'places.location,places.formattedAddress,places.displayName,places.rating,places.photos',
        },
        timeout: 8000,
      }
    )
    const p = res.data?.places?.[0]
    if (!p?.location) return null
    let photoUrl = null
    if (p.photos?.[0]?.name) {
      photoUrl = `https://places.googleapis.com/v1/${p.photos[0].name}/media?maxWidthPx=600&key=${config.google.key}`
    }
    return {
      lat: p.location.latitude,
      lng: p.location.longitude,
      address: p.formattedAddress || null,
      name: p.displayName?.text || null,
      rating: p.rating || null,
      photoUrl,
    }
  } catch (e) {
    logger.error('[google] findPlace failed:', e.response?.status || e.message)
    return null
  }
}

module.exports = { fetchVenues, findPlace }
