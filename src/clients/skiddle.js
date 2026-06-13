// src/clients/skiddle.js
// Skiddle events API — UK gigs, club nights, comedy.

const axios = require('axios')
const { config } = require('../config')
const { sleep } = require('../utils/helpers')
const logger = require('../utils/logger')

const URL = 'https://www.skiddle.com/api/v1/events/'

function fmtDate(d) {
  return d.toISOString().split('T')[0]
}

async function fetchEvents(lat, lng, radiusMiles = 5, daysAhead = 30) {
  if (!config.skiddle.key) {
    logger.warn('Skiddle key missing — skipping Skiddle')
    return []
  }

  const today = new Date()
  const future = new Date(today)
  future.setDate(future.getDate() + daysAhead)
  const dateRange = `${fmtDate(today)}:${fmtDate(future)}`

  const out = []
  let offset = 0

  while (true) {
    try {
      const res = await axios.get(URL, {
        params: {
          api_key: config.skiddle.key,
          latitude: lat,
          longitude: lng,
          radius: radiusMiles,
          limit: 100,
          offset,
          daterange: dateRange,
          description: 1,
        },
        timeout: 15000,
      })

      const results = res.data.results || []
      if (results.length === 0) break

      for (const e of results) {
        out.push({
          provider: 'skiddle',
          providerId: String(e.id),
          name: e.eventname,
          description: e.description || null,
          imageUrl: e.largeimageurl || e.imageurl || null,
          startsAt: e.startdate ? new Date(e.startdate) : null,
          endsAt: e.enddate ? new Date(e.enddate) : null,
          isFree: parseFloat(e.entryprice || e.MinPrice || '0') === 0,
          minPrice: e.MinPrice ? parseFloat(e.MinPrice) : null,
          ticketUrl: e.link || null,
          category: e.EventCode || null,
          genre: e.genres?.[0]?.genrename || null,
          venueName: e.venue?.name || '',
          venueAddress: [e.venue?.address, e.venue?.town, e.venue?.postcode]
            .filter(Boolean)
            .join(', '),
          venueLat: e.venue?.latitude ? parseFloat(e.venue.latitude) : null,
          venueLng: e.venue?.longitude ? parseFloat(e.venue.longitude) : null,
          raw: e,
        })
      }

      if (results.length < 100) break
      offset += 100
      await sleep(300)
    } catch (err) {
      logger.error('Skiddle fetch failed:', err.response?.data || err.message)
      break
    }
  }

  logger.info(`Skiddle: ${out.length} events`)
  return out.filter((e) => e.startsAt) // drop events with no start time
}

module.exports = { fetchEvents }
