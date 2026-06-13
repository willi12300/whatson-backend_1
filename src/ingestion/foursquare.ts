// src/ingestion/foursquare.ts
import axios from 'axios'
import { config, LIVERPOOL } from '../config'
import { logger } from '../utils/logger'

const BASE = 'https://api.foursquare.com/v3/places/search'

// Foursquare category IDs: bars, nightlife, restaurants, cafes, music venues
const CATEGORIES = ['13065', '13032', '13035', '13000', '10056', '10001']

export interface RawFoursquareVenue {
  foursquareId: string
  name: string
  address: string
  lat: number
  lng: number
  categories: Array<{ id: string; name: string }>
  rating: number | null
  phone: string | null
  website: string | null
  hours: object | null
  photos: string[] // direct photo URLs
  stats: { totalCheckins: number; totalVisits: number } | null
}

export async function ingestFoursquare(): Promise<RawFoursquareVenue[]> {
  const results: RawFoursquareVenue[] = []
  const seenIds = new Set<string>()

  for (const categoryId of CATEGORIES) {
    let cursor: string | null = null
    let page = 0

    do {
      try {
        const params: Record<string, string> = {
          ll: `${LIVERPOOL.lat},${LIVERPOOL.lng}`,
          radius: String(LIVERPOOL.radius),
          categories: categoryId,
          limit: '50',
          fields: 'fsq_id,name,location,categories,rating,photos,hours,stats,tel,website'
        }
        if (cursor) params.cursor = cursor

        const res = await axios.get(BASE, {
          params,
          headers: {
            Authorization: config.FOURSQUARE_API_KEY,
            Accept: 'application/json'
          }
        })

        for (const p of res.data.results || []) {
          if (seenIds.has(p.fsq_id)) continue
          seenIds.add(p.fsq_id)

          const photos: string[] = (p.photos || [])
            .slice(0, 3)
            .map((ph: any) => `${ph.prefix}400x400${ph.suffix}`)

          results.push({
            foursquareId: p.fsq_id,
            name: p.name,
            address: [
              p.location?.address,
              p.location?.locality,
              p.location?.postcode
            ].filter(Boolean).join(', '),
            lat: p.location?.lat,
            lng: p.location?.lng,
            categories: (p.categories || []).map((c: any) => ({ id: c.id, name: c.name })),
            rating: p.rating ? p.rating / 2 : null, // FSQ rates 0-10, convert to 0-5
            phone: p.tel || null,
            website: p.website || null,
            hours: p.hours || null,
            photos,
            stats: p.stats ? {
              totalCheckins: p.stats.total_checkins || 0,
              totalVisits: p.stats.total_visits || 0
            } : null
          })
        }

        cursor = res.data.context?.next_cursor || null
        page++
        await sleep(200)
      } catch (err: any) {
        logger.error({ err: err.message, categoryId }, 'Foursquare request failed')
        break
      }
    } while (cursor && page < 10) // max 10 pages = 500 results per category
  }

  logger.info({ count: results.length }, 'Foursquare scan complete')
  return results
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
