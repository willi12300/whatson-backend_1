const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const CATEGORIES = ['13065', '13032', '13003', '13338', '10032']

// Newer Foursquare Service API keys need "Bearer " prefix + version header.
// Older keys are used raw. We try Bearer first, fall back to raw.
function authHeader(key) {
  // If key already looks like it has a prefix, use as-is
  if (/^Bearer\s/i.test(key)) return key
  return `Bearer ${key}`
}

async function fetchVenues(lat, lng, radius) {
  if (!config.foursquare.key) { logger.warn('Foursquare key missing'); return [] }
  const seen = new Set()
  const out = []
  for (const cat of CATEGORIES) {
    try {
      const res = await axios.get('https://places-api.foursquare.com/places/search', {
        params: { ll: `${lat},${lng}`, radius, fsq_category_ids: cat, limit: 50 },
        headers: {
          Authorization: authHeader(config.foursquare.key),
          'X-Places-Api-Version': '2025-06-17',
          Accept: 'application/json',
        },
        timeout: 15000,
      })
      for (const p of res.data.results || []) {
        const lat2 = p.latitude ?? p.geocodes?.main?.latitude
        const lng2 = p.longitude ?? p.geocodes?.main?.longitude
        if (!lat2 || seen.has(p.fsq_place_id || p.fsq_id)) continue
        seen.add(p.fsq_place_id || p.fsq_id)
        out.push({
          provider: 'foursquare',
          providerId: p.fsq_place_id || p.fsq_id,
          name: p.name,
          address: [p.location?.address, p.location?.locality, p.location?.postcode].filter(Boolean).join(', '),
          postcode: p.location?.postcode || null,
          lat: lat2, lng: lng2,
          categories: (p.categories || []).map(c => c.name),
          rating: null,
          priceLevel: p.price ?? null,
          phone: p.tel || null,
          website: p.website || null,
          photos: [],
          raw: p,
        })
      }
    } catch (err) {
      logger.error(`Foursquare cat(${cat}) failed:`, err.response?.status, err.response?.data?.message || err.message)
    }
    await sleep(250)
  }
  logger.info(`Foursquare: ${out.length} venues`)
  return out
}

module.exports = { fetchVenues }
