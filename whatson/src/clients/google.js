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

module.exports = { fetchVenues }
