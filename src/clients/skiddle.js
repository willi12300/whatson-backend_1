const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

async function fetchEvents(lat, lng, radiusMiles = 5, daysAhead = 30, opts = {}) {
  if (!config.skiddle.key) { logger.warn('Skiddle key missing'); return [] }
  const { maxResults = Infinity, timeoutMs = 15000, strict = false } = opts
  const today = new Date()
  const future = new Date(today)
  future.setDate(future.getDate() + daysAhead)
  const minDate = opts.minDate || fmt(today)
  const maxDate = opts.maxDate || fmt(future)
  const out = []
  let offset = 0
  const seenPages = new Set()
  while (true) {
    try {
      const res = await axios.get('https://www.skiddle.com/api/v1/events/search/', {
        params: { api_key: config.skiddle.key, latitude: lat, longitude: lng, radius: radiusMiles, limit: 100, offset, minDate, maxDate, order: 'date', description: 1 },
        timeout: timeoutMs,
      })
      if (!Array.isArray(res.data.results)) throw new Error('Invalid Skiddle response')
      const results = res.data.results
      if (!results.length) break
      const pageIds = results.map(e => String(e.id)).join(',')
      if (seenPages.has(pageIds)) throw new Error('Skiddle repeated a page')
      seenPages.add(pageIds)
      for (const e of results) {
        out.push({
          provider: 'skiddle', providerId: String(e.id),
          name: e.eventname, description: e.description || null,
          imageUrl: e.largeimageurl || e.imageurl || null,
          startsAt: eventStart(e),
          endsAt: eventEnd(e),
          isFree: e.MinPrice != null && e.MinPrice !== '' && parseFloat(e.MinPrice) === 0,
          minPrice: e.MinPrice ? parseFloat(e.MinPrice) : null,
          ticketUrl: e.link || null,
          category: e.EventCode || null,
          genre: e.genres?.[0]?.genrename || null,
          venueName: e.venue?.name || '',
          venueAddress: [e.venue?.address, e.venue?.town, e.venue?.postcode].filter(Boolean).join(', '),
          venueLat: e.venue?.latitude ? parseFloat(e.venue.latitude) : null,
          venueLng: e.venue?.longitude ? parseFloat(e.venue.longitude) : null,
          raw: e,
        })
      }
      if (results.length < 100) break
      if (out.length >= maxResults) break       // fast cap for Roulette
      offset += 100
      await sleep(300)
    } catch (err) {
      // Axios errors may include the key-bearing request URL: log only the status.
      logger.error('Skiddle request failed', err.response?.status || err.code || 'invalid response')
      if (strict) throw new Error('Skiddle request failed')
      break
    }
  }
  logger.info(`Skiddle: ${out.length} events`)
  return out.filter(e => e.startsAt)
}

function ukDate(raw, fallbackTime = '00:00') {
  if (!raw) return null
  const value = String(raw)
  // The API uses both date-only and timezone-free local date/time strings.
  // Explicit Z/offset values already describe an instant and are preserved.
  const local = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?)?$/)
  if (local) {
    const clock = local[2] || (/^\d{2}:\d{2}/.test(fallbackTime) ? fallbackTime.slice(0, 5) : '00:00')
    const utc = Date.parse(local[1] + 'T' + clock + ':00Z')
    if (Number.isNaN(utc)) return null
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utc))
    const localHour = Number(parts.find(p => p.type === 'hour').value)
    const offsetHours = (localHour - new Date(utc).getUTCHours() + 24) % 24
    return new Date(utc - offsetHours * 3600000)
  }
  const date = new Date(value)
  return Number.isNaN(+date) ? null : date
}

function eventStart(e) {
  const doors = e.openingtimes?.doorsopen || e.openingtimes?.start
  const day = String(e.startdate || '').slice(0, 10)
  // Skiddle's explicit doors time is the venue's local wall-clock time.
  // Some source ISO strings use +00:00 even during British Summer Time.
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && /^\d{2}:\d{2}/.test(doors || '')) return ukDate(day, doors)
  return ukDate(e.startdate, e.openingtimes?.doorsopen || e.openingtimes?.start)
}

function eventEnd(e) {
  if (!e.enddate) return null
  const close = e.openingtimes?.end || e.openingtimes?.doorsclose
  const day = String(e.enddate).slice(0, 10)
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && /^\d{2}:\d{2}/.test(close || '')) {
    let end = ukDate(day, close)
    const start = eventStart(e)
    if (start && end <= start && day === String(e.startdate).slice(0, 10)) {
      const nextDay = new Date(day + 'T12:00:00Z'); nextDay.setUTCDate(nextDay.getUTCDate() + 1)
      end = ukDate(fmt(nextDay), close)
    }
    return end
  }
  // A calendar date without an end time must not expire an event at midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(e.enddate))) return null
  return ukDate(e.enddate, e.openingtimes?.end)
}

function fmt(d) { return d.toISOString().split('T')[0] }

module.exports = { fetchEvents, eventStart, eventEnd }
