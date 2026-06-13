const axios = require('axios')
const logger = require('../utils/logger')

async function fetchVenues(bbox) {
  const { south, west, north, east } = bbox
  const filter = '["amenity"~"^(pub|bar|nightclub|cafe|restaurant|music_venue|comedy_club|karaoke)$"]["name"]'
  const query = `[out:json][timeout:60];(node${filter}(${south},${west},${north},${east});way${filter}(${south},${west},${north},${east}););out center tags;`
  try {
    const res = await axios.post('https://overpass-api.de/api/interpreter', `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 70000,
    })
    const out = []
    for (const el of res.data.elements || []) {
      const lat = el.lat ?? el.center?.lat
      const lng = el.lon ?? el.center?.lon
      const tags = el.tags || {}
      if (!lat || !lng || !tags.name) continue
      out.push({
        provider: 'osm',
        providerId: `${el.type}/${el.id}`,
        name: tags.name,
        address: [tags['addr:housenumber'] && tags['addr:street'] ? `${tags['addr:housenumber']} ${tags['addr:street']}` : tags['addr:street'], tags['addr:city'], tags['addr:postcode']].filter(Boolean).join(', '),
        postcode: tags['addr:postcode'] || null,
        lat, lng,
        category: { pub:'pub', bar:'bar', nightclub:'nightclub', cafe:'cafe', restaurant:'restaurant', music_venue:'music_venue', comedy_club:'comedy_club', karaoke:'karaoke' }[tags.amenity] || 'other',
        phone: tags.phone || null,
        website: tags.website || null,
        raw: tags,
      })
    }
    logger.info(`OSM: ${out.length} venues`)
    return out
  } catch (err) {
    logger.error('OSM failed:', err.message)
    return []
  }
}

module.exports = { fetchVenues }
