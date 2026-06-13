const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const CATEGORIES = ['13065', '13032', '13003', '13338', '10032']

async function fetchVenues(lat, lng, radius) {
  if (!config.foursquare.key) { logger.warn('Foursquare key missing'); return [] }
  const seen = new Set()
  const out = []
  for (const cat of CATEGORIES) {
    try {
      const res = await axios.get('https://api.foursquare.com/v3/places/search', {
        params: { ll: `${lat},${lng}`, radius, categories: cat, limit: 50, fields: 'fsq_id,name,location,categories,rating,photos,hours,tel,website,price' },
        headers: { Authorization: config.foursquare.key, Accept: 'application/json' },
        timeout: 15000,
      })
      for (const p of res.data.results || []) {
        if (!p.location?.lat || seen.has(p.fsq_id)) continue
        seen.add(p.fsq_id)
        out.push({
          provider: 'foursquare',
          providerId: p.fsq_id,
          name: p.name,
          address: [p.location?.address, p.location?.locality, p.location?.postcode].filter(Boolean).join(', '),
          postcode: p.location?.postcode || null,
          lat: p.location.lat,
          lng: p.location.lng,
          categories: (p.categories || []).map(c => c.name),
          rating: p.rating ? Math.round((p.rating / 2) * 10) / 10 : null,
          priceLevel: p.price ?? null,
          phone: p.tel || null,
          website: p.website || null,
          photos: (p.photos || []).slice(0, 3).map(ph => ({ url: `${ph.prefix}400x400${ph.suffix}`, source: 'foursquare' })),
          raw: p,
        })
      }
    } catch (err) {
      logger.error(`Foursquare cat(${cat}) failed:`, err.response?.data?.message || err.message)
    }
    await sleep(200)
  }
  logger.info(`Foursquare: ${out.length} venues`)
  return out
}

module.exports = { fetchVenues }
