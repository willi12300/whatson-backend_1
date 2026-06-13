// src/clients/foursquare.js
// Foursquare Places API v3 — Place Search.

const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const URL = 'https://api.foursquare.com/v3/places/search'

// Foursquare category IDs:
// 13065 restaurant, 13032 cafe, 13003 bar, 13338 nightclub, 10032 music venue
const CATEGORIES = ['13065', '13032', '13003', '13338', '10032']

async function searchCategory(lat, lng, radius, categoryId) {
  try {
    const res = await axios.get(URL, {
      params: {
        ll: `${lat},${lng}`,
        radius,
        categories: categoryId,
        limit: 50,
        fields: 'fsq_id,name,location,categories,rating,photos,hours,tel,website,price',
      },
      headers: {
        Authorization: config.foursquare.key,
        Accept: 'application/json',
      },
      timeout: 15000,
    })

    return (res.data.results || []).map((p) => ({
      provider: 'foursquare',
      providerId: p.fsq_id,
      name: p.name,
      address: [p.location?.address, p.location?.locality, p.location?.postcode]
        .filter(Boolean)
        .join(', '),
      postcode: p.location?.postcode || null,
      lat: p.location?.lat ?? p.geocodes?.main?.latitude,
      lng: p.location?.lng ?? p.geocodes?.main?.longitude,
      categories: (p.categories || []).map((c) => c.name),
      rating: p.rating ? Math.round((p.rating / 2) * 10) / 10 : null, // 0-10 -> 0-5
      priceLevel: p.price ?? null, // 1-4
      phone: p.tel || null,
      website: p.website || null,
      photos: (p.photos || []).slice(0, 3).map((ph) => ({
        url: `${ph.prefix}400x400${ph.suffix}`,
        source: 'foursquare',
      })),
      raw: p,
    }))
  } catch (err) {
    logger.error(`Foursquare category(${categoryId}) failed:`, err.response?.data?.message || err.message)
    return []
  }
}

async function fetchVenues(lat, lng, radius) {
  if (!config.foursquare.key) {
    logger.warn('Foursquare key missing — skipping Foursquare')
    return []
  }
  const seen = new Set()
  const out = []
  for (const cat of CATEGORIES) {
    const batch = await searchCategory(lat, lng, radius, cat)
    for (const v of batch) {
      if (v.lat && v.lng && !seen.has(v.providerId)) {
        seen.add(v.providerId)
        out.push(v)
      }
    }
    await sleep(200)
  }
  logger.info(`Foursquare: ${out.length} venues`)
  return out
}

module.exports = { fetchVenues }
