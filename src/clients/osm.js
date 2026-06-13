// src/clients/osm.js
// OpenStreetMap Overpass API — free, no key. Catches the long tail of small venues.

const axios = require('axios')
const logger = require('../utils/logger')

const URL = 'https://overpass-api.de/api/interpreter'

const AMENITY_TO_CATEGORY = {
  pub: 'pub',
  bar: 'bar',
  nightclub: 'nightclub',
  cafe: 'cafe',
  restaurant: 'restaurant',
  music_venue: 'music_venue',
  comedy_club: 'comedy_club',
  karaoke: 'karaoke',
}

async function fetchVenues(bbox) {
  const { south, west, north, east } = bbox
  const filter =
    '["amenity"~"^(pub|bar|nightclub|cafe|restaurant|music_venue|comedy_club|karaoke)$"]["name"]'
  const query = `[out:json][timeout:60];(node${filter}(${south},${west},${north},${east});way${filter}(${south},${west},${north},${east}););out center tags;`

  try {
    const res = await axios.post(URL, `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 70000,
    })

    const out = []
    for (const el of res.data.elements || []) {
      const lat = el.lat ?? el.center?.lat
      const lng = el.lon ?? el.center?.lon
      const tags = el.tags || {}
      if (!lat || !lng || !tags.name) continue

      const addr = [
        tags['addr:housenumber'] && tags['addr:street']
          ? `${tags['addr:housenumber']} ${tags['addr:street']}`
          : tags['addr:street'],
        tags['addr:city'],
        tags['addr:postcode'],
      ]
        .filter(Boolean)
        .join(', ')

      out.push({
        provider: 'osm',
        providerId: `${el.type}/${el.id}`,
        name: tags.name,
        address: addr,
        postcode: tags['addr:postcode'] || null,
        lat,
        lng,
        category: AMENITY_TO_CATEGORY[tags.amenity] || 'other',
        phone: tags.phone || tags['contact:phone'] || null,
        website: tags.website || tags['contact:website'] || null,
        liveMusic: tags.live_music === 'yes',
        raw: tags,
      })
    }
    logger.info(`OSM Overpass: ${out.length} venues`)
    return out
  } catch (err) {
    logger.error('OSM Overpass failed:', err.message)
    return []
  }
}

module.exports = { fetchVenues }
