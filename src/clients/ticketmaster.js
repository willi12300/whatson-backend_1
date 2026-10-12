const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

async function fetchEvents(lat, lng, radiusMiles = 5, daysAhead = 30, opts = {}) {
  if (!config.ticketmaster.key) { logger.warn('Ticketmaster key missing'); return [] }
  const { maxResults = Infinity, timeoutMs = 15000, maxPages = Infinity, strict = false } = opts
  const out = []
  const beginning = new Date()
  const end = new Date(beginning)
  end.setDate(end.getDate() + daysAhead)
  const startDateTime = opts.minDate ? opts.minDate + 'T00:00:00Z' : beginning.toISOString().split('.')[0] + 'Z'
  const endDateTime = opts.maxDate ? opts.maxDate + 'T23:59:59Z' : end.toISOString().split('.')[0] + 'Z'
  const seenIds = new Set()
  async function window(startDateTime, endDateTime) {
    let page = 0
    while (page < maxPages) {
      const res = await axios.get('https://app.ticketmaster.com/discovery/v2/events.json', {
        params: {
          apikey: config.ticketmaster.key,
          latlong: `${lat},${lng}`,
          radius: radiusMiles,
          unit: 'miles',
          startDateTime,
          endDateTime,
          size: 100,
          page,
          sort: 'date,asc',
        },
        timeout: timeoutMs,
      })
      if (!res.data.page || !Number.isFinite(res.data.page.totalPages)) throw Object.assign(new Error('Invalid Ticketmaster response'), { reason: 'invalid_response' })
      if (!page && res.data.page.totalElements > 1000 && maxPages === Infinity && maxResults === Infinity) {
        // Discovery API cannot page past item 1,000. Split the time window instead.
        const start = Date.parse(startDateTime), finish = Date.parse(endDateTime)
        if (finish - start < 2000) throw Object.assign(new Error('Ticketmaster window too dense'), { reason: 'pagination_limit' })
        const middle = Math.floor((start + finish) / 2000) * 1000
        const iso = value => new Date(value).toISOString().split('.')[0] + 'Z'
        await window(startDateTime, iso(middle))
        await window(iso(middle + 1000), endDateTime)
        return
      }
      const events = res.data._embedded?.events || []
      if (!Array.isArray(events) || (res.data.page.totalElements > 0 && !events.length)) throw Object.assign(new Error('Invalid Ticketmaster response'), { reason: 'invalid_response' })
      if (!events.length) break
      for (const e of events) {
        if (seenIds.has(e.id)) continue
        seenIds.add(e.id)
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
    }
  }
  try { await window(startDateTime, endDateTime) } catch (err) {
    const reason = err.response?.status ? 'http_' + err.response.status : (err.reason || (err.code === 'ECONNABORTED' ? 'timeout' : 'request_failed'))
    logger.error('Ticketmaster request failed:', reason)
    if (strict) throw Object.assign(new Error('Ticketmaster request failed'), { reason })
  }
  logger.info(`Ticketmaster: ${out.length} events`)
  return out.filter(e => e.startsAt)
}

module.exports = { fetchEvents }
