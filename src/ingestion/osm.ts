// src/ingestion/osm.ts
import axios from 'axios'
import { LIVERPOOL } from '../config'
import { logger } from '../utils/logger'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

export interface RawOsmVenue {
  osmId: string
  osmType: 'node' | 'way'
  name: string
  address: string
  lat: number
  lng: number
  amenity: string
  tags: Record<string, string>
}

export async function ingestOsm(): Promise<RawOsmVenue[]> {
  const bbox = LIVERPOOL.bbox
  const query = `
[out:json][timeout:60];
(
  node["amenity"~"^(pub|bar|nightclub|cafe|restaurant|music_venue|comedy_club|karaoke)$"]["name"](${bbox});
  way["amenity"~"^(pub|bar|nightclub|cafe|restaurant|music_venue|comedy_club|karaoke)$"]["name"](${bbox});
);
out center tags;
`

  try {
    const res = await axios.post(OVERPASS_URL, `data=${encodeURIComponent(query)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 70000
    })

    const results: RawOsmVenue[] = []
    for (const el of res.data.elements || []) {
      const lat = el.lat ?? el.center?.lat
      const lng = el.lon ?? el.center?.lon
      if (!lat || !lng || !el.tags?.name) continue

      const tags = el.tags || {}
      const addressParts = [
        tags['addr:housenumber'] && tags['addr:street']
          ? `${tags['addr:housenumber']} ${tags['addr:street']}`
          : null,
        tags['addr:city'] || 'Liverpool',
        tags['addr:postcode'] || null
      ].filter(Boolean)

      results.push({
        osmId: String(el.id),
        osmType: el.type,
        name: tags.name,
        address: addressParts.join(', '),
        lat,
        lng,
        amenity: tags.amenity,
        tags
      })
    }

    logger.info({ count: results.length }, 'OSM scan complete')
    return results
  } catch (err: any) {
    logger.error({ err: err.message }, 'OSM Overpass request failed')
    return []
  }
}
