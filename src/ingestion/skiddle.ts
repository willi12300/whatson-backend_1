// src/ingestion/skiddle.ts
import axios from 'axios'
import { config, LIVERPOOL } from '../config'
import { logger } from '../utils/logger'

const BASE = 'https://www.skiddle.com/api/v1/events/'

export interface RawSkiddleEvent {
  skiddleId: string
  name: string
  description: string | null
  imageUrl: string | null
  startsAt: Date
  endsAt: Date | null
  isFree: boolean
  minPrice: number | null
  ticketUrl: string | null
  venueName: string
  venueAddress: string
  venueLat: number
  venueLng: number
  skiddleVenueId: string | null
  genres: string[]
}

export async function ingestSkiddle(daysAhead = 30): Promise<RawSkiddleEvent[]> {
  const results: RawSkiddleEvent[] = []
  const seenIds = new Set<string>()

  const today = new Date()
  const future = new Date(today)
  future.setDate(future.getDate() + daysAhead)

  const dateRange = `${fmt(today)}:${fmt(future)}`
  let offset = 0

  while (true) {
    try {
      const res = await axios.get(BASE, {
        params: {
          api_key: config.SKIDDLE_API_KEY,
          latitude: LIVERPOOL.lat,
          longitude: LIVERPOOL.lng,
          radius: 5,
          limit: 100,
          offset,
          daterange: dateRange,
          description: 1
        }
      })

      const data = res.data
      if (!data.results || data.results.length === 0) break

      for (const e of data.results) {
        if (seenIds.has(e.id)) continue
        seenIds.add(e.id)

        results.push({
          skiddleId: String(e.id),
          name: e.eventname,
          description: e.description || null,
          imageUrl: e.largeimageurl || e.imageurl || null,
          startsAt: new Date(e.startdate),
          endsAt: e.enddate ? new Date(e.enddate) : null,
          isFree: parseFloat(e.mineticketprice) === 0,
          minPrice: e.mineticketprice ? parseFloat(e.mineticketprice) : null,
          ticketUrl: e.link || null,
          venueName: e.venue?.name || '',
          venueAddress: [e.venue?.address, e.venue?.town, e.venue?.postcode].filter(Boolean).join(', '),
          venueLat: parseFloat(e.venue?.latitude || '0'),
          venueLng: parseFloat(e.venue?.longitude || '0'),
          skiddleVenueId: e.venue?.id ? String(e.venue.id) : null,
          genres: e.genres ? e.genres.map((g: any) => g.genrename) : []
        })
      }

      if (data.results.length < 100) break
      offset += 100
      await sleep(300)
    } catch (err: any) {
      logger.error({ err: err.message, offset }, 'Skiddle request failed')
      break
    }
  }

  logger.info({ count: results.length }, 'Skiddle ingestion complete')
  return results
}

function fmt(d: Date): string {
  return d.toISOString().split('T')[0]
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
