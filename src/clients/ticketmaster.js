const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

async function fetchEvents(lat, lng, radiusMiles = 5, daysAhead = 30, opts = {}) {
  if (!config.ticketmaster.key) { logger.warn('Ticketmaster key missing'); return [] }
  const { maxResults = Infinity, timeoutMs = 15000, maxPages = 5 } = opts
  const out = []
  const end = new Date()
  end.setDate(end.getDate() + daysAhead)
  let page = 0
  while (page < maxPages) {
    try {
      const res = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
        params: {
          apikey: config.ticketmaster.key,
          latlong: `${lat},${lng}`,
          radius: radiusMiles,
          unit: 'miles',
          startDateTime: new Date().toISOString().split('.')[0] + 'Z',
          endDateTime: end.toISOString().split('.')[0] + 'Z',
          size: 100,
          page,
          sort: 'date,asc',
        },
        timeout: timeoutMs,
      })
      const events = res.data._embedded?.events || []
      if (!events.length) break
      for (const e of events) {
        const venue = e._embedded?.venues?.[0]
        const start = e.dates?.start?.dateTime || (e.dates?.start?.localDate ? e.dates.start.localDate + 'T19:00:00Z' : null)
        if (!start) continue
        out.push({
          provider: 'ticketmaster',
          providerId: e.id,
          name: e.name,
          description: e.info || e.pleaseNote || null,
          imageUrl: e.images?.find(i => i.width > 600)?.url || e.images?.[0]?.url || null,
          startsAt: new Date(start),
          endsAt: null,
          isFree: false,
          minPrice: e.priceRanges?.[0]?.min || null,
          ticketUrl: e.url || null,
          category: e.classifications?.[0]?.segment?.name || null,
          genre: e.classifications?.[0]?.genre?.name || null,
          venueName: venue?.name || '',
          venueAddress: [venue?.address?.line1, venue?.city?.name, venue?.postalCode].filter(Boolean).join(', '),
          venueLat: venue?.location?.latitude ? parseFloat(venue.location.latitude) : null,
          venueLng: venue?.location?.longitude ? parseFloat(venue.location.longitude) : null,
          raw: e,
        })
      }
      const totalPages = res.data.page?.totalPages || 1
      if (page >= totalPages - 1) break
      if (out.length >= maxResults) break
      page++
      await sleep(250)
    } catch (err) {
      logger.error('Ticketmaster failed:', err.response?.status, err.response?.data?.fault?.faultstring || err.message)
      break
    }
  }
  logger.info(`Ticketmaster: ${out.length} events`)
  return out.filter(e => e.startsAt)
}

module.exports = { fetchEvents }
