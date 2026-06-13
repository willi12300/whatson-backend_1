// src/clients/google.js
// Google Places API (New) — Nearby Search.

const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const URL = 'https://places.googleapis.com/v1/places:searchNearby'
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.regularOpeningHours',
  'places.photos',
  'places.internationalPhoneNumber',
  'places.websiteUri',
  'places.businessStatus',
].join(',')

// Google place types relevant to nightlife/hospitality
const TYPES = ['bar', 'night_club', 'restaurant', 'cafe', 'pub']

function priceLevelToInt(pl) {
  const map = {
    PRICE_LEVEL_FREE: 0,
    PRICE_LEVEL_INEXPENSIVE: 1,
    PRICE_LEVEL_MODERATE: 2,
    PRICE_LEVEL_EXPENSIVE: 3,
    PRICE_LEVEL_VERY_EXPENSIVE: 4,
  }
  return pl in map ? map[pl] : null
}

function buildPhotoUrl(photoName, maxWidth = 400) {
  return `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidth}&key=${config.google.key}`
}

async function searchType(lat, lng, radius, type) {
  try {
    const res = await axios.post(
      URL,
      {
        locationRestriction: {
          circle: { center: { latitude: lat, longitude: lng }, radius },
        },
        includedTypes: [type],
        maxResultCount: 20,
      },
      {
        headers: {
          'X-Goog-Api-Key': config.google.key,
          'X-Goog-FieldMask': FIELD_MASK,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    )

    return (res.data.places || []).map((p) => ({
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
      priceLevel: priceLevelToInt(p.priceLevel),
      phone: p.internationalPhoneNumber || null,
      website: p.websiteUri || null,
      businessStatus: p.businessStatus || null,
      openingHours: p.regularOpeningHours || null,
      photos: (p.photos || []).slice(0, 3).map((ph) => ({
        url: buildPhotoUrl(ph.name),
        source: 'google',
      })),
      raw: p,
    }))
  } catch (err) {
    logger.error(`Google searchType(${type}) failed:`, err.response?.data?.error?.message || err.message)
    return []
  }
}

/**
 * Fetch venues around a point for all relevant types.
 * Returns a flat, de-duplicated-by-providerId array.
 */
async function fetchVenues(lat, lng, radius) {
  if (!config.google.key) {
    logger.warn('Google key missing — skipping Google Places')
    return []
  }
  const seen = new Set()
  const out = []
  for (const type of TYPES) {
    const batch = await searchType(lat, lng, radius, type)
    for (const v of batch) {
      if (!seen.has(v.providerId)) {
        seen.add(v.providerId)
        out.push(v)
      }
    }
    await sleep(150) // stay well under rate limits
  }
  logger.info(`Google Places: ${out.length} venues`)
  return out
}

module.exports = { fetchVenues }
