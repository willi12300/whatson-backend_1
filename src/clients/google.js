const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const TYPES = [
  // food & drink
  'bar', 'night_club', 'restaurant', 'cafe', 'pub',
  // tourist attractions & culture (for travellers)
  'tourist_attraction', 'museum', 'art_gallery', 'park',
  'historical_landmark', 'church', 'zoo', 'aquarium',
]

async function searchType(lat, lng, radius, type, timeoutMs = 15000) {
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
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours,places.currentOpeningHours,places.photos,places.internationalPhoneNumber,places.websiteUri,places.businessStatus',
          'Content-Type': 'application/json',
        },
        timeout: timeoutMs,
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
      openingHours: p.currentOpeningHours || p.regularOpeningHours || null,
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

async function fetchVenues(lat, lng, radius, opts = {}) {
  if (!config.google.key) { logger.warn('Google key missing'); return [] }
  const { types = TYPES, parallel = false, timeoutMs = 15000 } = opts
  const seen = new Set()
  const out = []

  if (parallel) {
    // Fast path (Roulette): fire all type searches at once, cap each by timeout.
    const settled = await Promise.allSettled(
      types.map(type => searchType(lat, lng, radius, type, timeoutMs))
    )
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        for (const v of r.value) {
          if (!seen.has(v.providerId)) { seen.add(v.providerId); out.push(v) }
        }
      }
    }
  } else {
    // Sequential path (sync job): gentle on rate limits.
    for (const type of types) {
      const batch = await searchType(lat, lng, radius, type, timeoutMs)
      for (const v of batch) {
        if (!seen.has(v.providerId)) { seen.add(v.providerId); out.push(v) }
      }
      await sleep(150)
    }
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
          'X-Goog-FieldMask': 'places.id,places.location,places.formattedAddress,places.displayName,places.rating,places.userRatingCount,places.photos,places.types,places.primaryType,places.websiteUri,places.googleMapsUri',
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
      ratingCount: p.userRatingCount ?? null,
      providerId: p.id || null,
      googlePlaceId: p.id || null,
      types: p.types || [],
      primaryType: p.primaryType || null,
      website: p.websiteUri || null,
      googleMapsUrl: p.googleMapsUri || null,
      photoUrl,
    }
  } catch (e) {
    logger.error('[google] findPlace failed:', e.response?.status || e.message)
    return null
  }
}


// Search Google Places by venue name/address and return a full details object.
// This is used when an older DB venue does not yet have a google_place_id saved.
async function findPlaceDetails(textQuery, timeoutMs = 8000) {
  if (!config.google.key || !textQuery) return null
  try {
    const res = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      { textQuery, maxResultCount: 3 },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.types,places.primaryType,places.websiteUri,places.googleMapsUri,places.businessStatus,places.currentOpeningHours,places.regularOpeningHours',
        },
        timeout: timeoutMs,
      }
    )
    const places = res.data?.places || []
    if (!places.length) return null
    // Prefer the first result from Google, then fetch proper details/reviews by place ID.
    const p = places[0]
    if (!p?.id) return null
    const details = await getPlaceDetails(p.id, timeoutMs)
    return details || {
      provider: 'google',
      providerId: p.id,
      name: p.displayName?.text || null,
      address: p.formattedAddress || null,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      website: p.websiteUri || null,
      googleMapsUrl: p.googleMapsUri || null,
      businessStatus: p.businessStatus || null,
      photos: [],
      reviews: [],
      raw: p,
    }
  } catch (e) {
    logger.error('[google] findPlaceDetails failed:', e.response?.status || e.message)
    return null
  }
}

// Reverse-geocode coordinates → real city/town name, anywhere in the world.
// Uses the Google Geocoding API (same key as Places). Returns { city, country, formatted } or null.
async function reverseGeocode(lat, lng) {
  if (!config.google.key || lat == null || lng == null) return null
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { latlng: `${lat},${lng}`, key: config.google.key, result_type: 'locality|postal_town|administrative_area_level_2' },
      timeout: 8000,
    })
    const result = res.data?.results?.[0]
    if (!result) return null
    const comp = result.address_components || []
    const find = (type) => comp.find(c => c.types.includes(type))?.long_name || null
    const city = find('locality') || find('postal_town') || find('administrative_area_level_2')
    const country = find('country')
    return city ? { city, country, formatted: result.formatted_address } : null
  } catch (e) {
    logger.error('[google] reverseGeocode failed:', e.response?.status || e.message)
    return null
  }
}


// Fetch richer details for a known Google Place ID, including review snippets where Google returns them.
// Used by venue profiles as a fallback when TripAdvisor does not have a match.
async function getPlaceDetails(placeId, timeoutMs = 8000) {
  if (!config.google.key || !placeId) return null
  try {
    const res = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
      headers: {
        'X-Goog-Api-Key': config.google.key,
        'X-Goog-FieldMask': [
          'id',
          'displayName',
          'formattedAddress',
          'location',
          'rating',
          'userRatingCount',
          'priceLevel',
          'regularOpeningHours',
          'currentOpeningHours',
          'photos',
          'internationalPhoneNumber',
          'websiteUri',
          'businessStatus',
          'googleMapsUri',
          'reviews'
        ].join(','),
      },
      timeout: timeoutMs,
    })
    const p = res.data || {}
    return {
      provider: 'google',
      providerId: p.id || placeId,
      name: p.displayName?.text || null,
      address: p.formattedAddress || null,
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      priceLevel: p.priceLevel ?? null,
      phone: p.internationalPhoneNumber || null,
      website: p.websiteUri || null,
      googleMapsUrl: p.googleMapsUri || null,
      businessStatus: p.businessStatus || null,
      openingHours: p.currentOpeningHours || p.regularOpeningHours || null,
      photos: (p.photos || []).slice(0, 6).map(ph => ({
        url: `https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=900&key=${config.google.key}`,
        source: 'google',
      })),
      reviews: (p.reviews || []).map(r => ({
        text: r.text?.text || r.originalText?.text || '',
        author: r.authorAttribution?.displayName || 'Google user',
        rating: r.rating || null,
        publishedDate: r.publishTime || null,
        url: r.googleMapsUri || p.googleMapsUri || null,
        source: 'google',
      })).filter(r => r.text),
      raw: p,
    }
  } catch (e) {
    logger.error('[google] getPlaceDetails failed:', e.response?.status || e.message)
    return null
  }
}


// Text search for intent-specific discovery queries such as "breakfast near me" or
// "quiet parks with a lake". Nearby type search can over-favour the same famous
// city-centre venues; text search gives Google more context and often surfaces
// smaller local places.
async function searchTextPlaces(textQuery, lat, lng, radius = 3000, opts = {}) {
  if (!config.google.key || !textQuery) return []
  const { includedType = null, timeoutMs = 8000, maxResultCount = 20 } = opts
  try {
    const body = {
      textQuery,
      maxResultCount: Math.min(Math.max(maxResultCount, 1), 20),
    }
    if (lat != null && lng != null) {
      body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius } }
    }
    if (includedType) body.includedType = includedType
    const res = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': config.google.key,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.rating,places.userRatingCount,places.priceLevel,places.regularOpeningHours,places.currentOpeningHours,places.photos,places.internationalPhoneNumber,places.websiteUri,places.businessStatus,places.googleMapsUri',
        },
        timeout: timeoutMs,
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
      primaryType: p.primaryType || includedType || (p.types || [])[0] || null,
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? null,
      priceLevel: p.priceLevel ?? null,
      phone: p.internationalPhoneNumber || null,
      website: p.websiteUri || null,
      businessStatus: p.businessStatus || null,
      googleMapsUrl: p.googleMapsUri || null,
      openingHours: p.currentOpeningHours || p.regularOpeningHours || null,
      photos: (p.photos || []).slice(0, 3).map(ph => ({
        url: `https://places.googleapis.com/v1/${ph.name}/media?maxWidthPx=500&key=${config.google.key}`,
        source: 'google',
      })),
      raw: p,
    }))
  } catch (e) {
    logger.error('[google] searchTextPlaces failed:', e.response?.status || e.message)
    return []
  }
}


module.exports = { fetchVenues, findPlace, findPlaceDetails, reverseGeocode, getPlaceDetails, searchTextPlaces }
