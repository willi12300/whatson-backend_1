// src/ingestion/eventbrite.ts
import axios from 'axios'
import { config, LIVERPOOL } from '../config'
import { logger } from '../utils/logger'

export interface RawEventbriteEvent {
  eventbriteId: string
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
  eventbriteVenueId: string | null
}

export async function ingestEventbrite(daysAhead = 30): Promise<RawEventbriteEvent[]> {
  const results: RawEventbriteEvent[] = []
  const future = new Date()
  future.setDate(future.getDate() + daysAhead)

  let page = 1
  while (true) {
    try {
      const res = await axios.get('https://www.eventbriteapi.com/v3/events/search/', {
        headers: { Authorization: `Bearer ${config.EVENTBRITE_TOKEN}` },
        params: {
          'location.latitude': LIVERPOOL.lat,
          'location.longitude': LIVERPOOL.lng,
          'location.within': '5mi',
          'start_date.range_start': new Date().toISOString(),
          'start_date.range_end': future.toISOString(),
          expand: 'venue,ticket_availability',
          page_size: 50,
          page
        }
      })

      const { events, pagination } = res.data
      if (!events?.length) break

      for (const e of events) {
        results.push({
          eventbriteId: e.id,
          name: e.name?.text || '',
          description: e.description?.text || null,
          imageUrl: e.logo?.url || null,
          startsAt: new Date(e.start.utc),
          endsAt: new Date(e.end.utc),
          isFree: e.is_free,
          minPrice: e.ticket_availability?.minimum_ticket_price?.value
            ? parseFloat(e.ticket_availability.minimum_ticket_price.value) : null,
          ticketUrl: e.url || null,
          venueName: e.venue?.name || '',
          venueAddress: e.venue?.address?.localized_address_display || '',
          venueLat: parseFloat(e.venue?.latitude || '0'),
          venueLng: parseFloat(e.venue?.longitude || '0'),
          eventbriteVenueId: e.venue?.id || null
        })
      }

      if (page >= pagination.page_count) break
      page++
      await sleep(300)
    } catch (err: any) {
      logger.error({ err: err.message, page }, 'Eventbrite request failed')
      break
    }
  }

  logger.info({ count: results.length }, 'Eventbrite ingestion complete')
  return results
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
