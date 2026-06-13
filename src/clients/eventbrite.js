const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

async function fetchEvents(lat, lng, withinMiles = 5, daysAhead = 30) {
  if (!config.eventbrite.token) { logger.warn('Eventbrite token missing'); return [] }
  const future = new Date()
  future.setDate(future.getDate() + daysAhead)
  const out = []
  let page = 1
  while (page <= 10) {
    try {
      const res = await axios.get('https://www.eventbriteapi.com/v3/events/search/', {
        headers: { Authorization: `Bearer ${config.eventbrite.token}` },
        params: { 'location.latitude': lat, 'location.longitude': lng, 'location.within': `${withinMiles}mi`, 'start_date.range_start': new Date().toISOString().split('.')[0] + 'Z', 'start_date.range_end': future.toISOString().split('.')[0] + 'Z', expand: 'venue', page },
        timeout: 15000,
      })
      for (const e of res.data.events || []) {
        out.push({
          provider: 'eventbrite', providerId: e.id,
          name: e.name?.text || '',
          description: e.description?.text || null,
          imageUrl: e.logo?.url || null,
          startsAt: e.start?.utc ? new Date(e.start.utc) : null,
          endsAt: e.end?.utc ? new Date(e.end.utc) : null,
          isFree: !!e.is_free, minPrice: null,
          ticketUrl: e.url || null, category: null, genre: null,
          venueName: e.venue?.name || '',
          venueAddress: e.venue?.address?.localized_address_display || '',
          venueLat: e.venue?.latitude ? parseFloat(e.venue.latitude) : null,
          venueLng: e.venue?.longitude ? parseFloat(e.venue.longitude) : null,
          raw: e,
        })
      }
      const pg = res.data.pagination
      if (!pg || page >= pg.page_count) break
      page++
      await sleep(300)
    } catch (err) {
      const s = err.response?.status
      if (s === 404 || s === 400) { logger.warn('Eventbrite search not available for this token'); break }
      logger.error('Eventbrite failed:', err.message); break
    }
  }
  logger.info(`Eventbrite: ${out.length} events`)
  return out.filter(e => e.startsAt)
}

module.exports = { fetchEvents }
