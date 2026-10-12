const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()
const skiddle = require('../clients/skiddle')
const ticketmaster = require('../clients/ticketmaster')
const { upsertEvent } = require('../services/sync')
const { matchEventToVenue } = require('../services/matchEvents')
const logger = require('../utils/logger')

function typeWhere(type, idx) {
  const hay = `LOWER(COALESCE(e.category,'') || ' ' || COALESCE(e.genre,'') || ' ' || COALESCE(e.name,'') || ' ' || COALESCE(e.description,''))`
  const patterns = {
    music: ['music','concert','live','band','gig','festival','jazz','rock','pop','soul','indie','acoustic'],
    comedy: ['comedy','comedian','stand up','stand-up'],
    theatre: ['theatre','musical','play','drama','opera','ballet'],
    club: ['club','rave','dj','nightlife','dance','house','techno','dnb','drum and bass'],
    food: ['food','drink','brunch','bottomless','beer','wine','cocktail','market'],
    family: ['family','kids','children','child'],
  }
  const list = patterns[String(type || '').toLowerCase()]
  if (!list) return null
  return `(${list.map((_, i) => `${hay} LIKE $${idx + i}`).join(' OR ')})`
}

router.get('/', async (req, res, next) => {
  try {
    const { city, category, type, q, from, to, free, limit = 100 } = req.query
    const params = [], where = [`e.status='active'`]
    if (city) { params.push(city); where.push(`v.city=$${params.length}`) }
    if (category) { params.push(category); where.push(`LOWER(e.category)=LOWER($${params.length})`) }
    if (type && type !== 'all' && type !== 'free') {
      const patterns = {
        music: ['music','concert','live','band','gig','festival','jazz','rock','pop','soul','indie','acoustic'],
        comedy: ['comedy','comedian','stand up','stand-up'],
        theatre: ['theatre','musical','play','drama','opera','ballet'],
        club: ['club','rave','dj','nightlife','dance','house','techno','dnb','drum and bass'],
        food: ['food','drink','brunch','bottomless','beer','wine','cocktail','market'],
        family: ['family','kids','children','child'],
      }[String(type).toLowerCase()]
      if (patterns?.length) {
        const start = params.length + 1
        patterns.forEach(x => params.push(`%${x}%`))
        const hay = `LOWER(COALESCE(e.category,'') || ' ' || COALESCE(e.genre,'') || ' ' || COALESCE(e.name,'') || ' ' || COALESCE(e.description,''))`
        where.push(`(${patterns.map((_, i) => `${hay} LIKE $${start + i}`).join(' OR ')})`)
      }
    }
    if (free === 'true' || type === 'free') where.push(`(e.is_free=true OR COALESCE(e.min_price, 999999)=0 OR LOWER(e.name) LIKE '%free%')`)
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`LOWER(e.name || ' ' || COALESCE(e.description,'') || ' ' || COALESCE(e.category,'') || ' ' || COALESCE(e.genre,'')) LIKE $${params.length}`) }
    if (from) { params.push(from); where.push(`e.starts_at>=$${params.length}`) } else where.push(`e.starts_at>=now()`)
    if (to) { params.push(to); where.push(`e.starts_at<=$${params.length}`) }
    params.push(Math.min(parseInt(limit) || 100, 500))
    const { rows } = await query(`SELECT e.id,e.name,e.description,e.image_url,e.category,e.genre,e.starts_at,e.ends_at,e.is_free,e.min_price,e.ticket_url,v.id AS venue_id,v.name AS venue_name,v.lat,v.lng,v.address AS venue_address,v.cover_photo AS venue_photo FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE ${where.join(' AND ')} ORDER BY e.starts_at ASC LIMIT $${params.length}`, params)
    let events = rows

    // Live fallback: always call Skiddle + TM live when GPS is present and
    // DB has <3 events. Events MUST be real-time — no sync needed.
    const lat = req.query.lat ? parseFloat(req.query.lat) : null
    const lng = req.query.lng ? parseFloat(req.query.lng) : null
    const hasGPS = lat != null && !isNaN(lat) && lng != null && !isNaN(lng)

    if (hasGPS && events.length < 3) {
      try {
        const radiusMiles = Math.min(parseInt(req.query.radius || '30'), 60)
        const cityLabel = req.query.city || null
        logger.info('[events] DB:' + events.length + ' near ' + lat.toFixed(3) + ',' + lng.toFixed(3) + ' — live Skiddle+TM')
        const [sk, tm] = await Promise.all([
          skiddle.fetchEvents(lat, lng, radiusMiles, 30, { maxResults: 200, timeoutMs: 12000 }).catch(e => { logger.error('[events] skiddle:' + e.message); return [] }),
          ticketmaster.fetchEvents(lat, lng, radiusMiles, 30, { maxResults: 100, maxPages: 2, timeoutMs: 12000 }).catch(e => { logger.error('[events] tm:' + e.message); return [] }),
        ])
        const liveEvents = sk.concat(tm)
        logger.info('[events] live Skiddle:' + sk.length + ' TM:' + tm.length)

        // Save to DB in background so next request is faster
        if (liveEvents.length > 0) {
          Promise.all(liveEvents.map(async e => {
            try {
              const match = await matchEventToVenue(e, cityLabel)
              if (match.method === 'none') return
              await upsertEvent(e, match.venueId, match.confidence)
            } catch (_) {}
          })).catch(() => {})
        }

        // Normalise to same shape as DB rows
        const existingNames = new Set(events.map(e => (e.name || '').toLowerCase().trim()))
        const liveRows = liveEvents
          .filter(e => e.startsAt && new Date(e.startsAt) > new Date())
          .filter(e => !existingNames.has((e.name || '').toLowerCase().trim()))
          .sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))
          .slice(0, 40)
          .map(e => ({
            id: 'live_' + (e.providerId || (e.name || '').replace(/\s/g, '_')),
            name: e.name, description: e.description || null,
            image_url: e.imageUrl || null,
            category: e.category || null, genre: e.genre || null,
            starts_at: e.startsAt, ends_at: e.endsAt || null,
            is_free: e.isFree || false, min_price: e.minPrice || null,
            ticket_url: e.ticketUrl || null,
            venue_name: e.venueName || null,
            lat: e.venueLat || null, lng: e.venueLng || null,
            venue_address: e.venueAddress || null, venue_photo: null,
          }))

        events = events.concat(liveRows).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
        logger.info('[events] total returning: ' + events.length + ' (' + liveRows.length + ' live)')
      } catch (e) {
        logger.error('[events] live fallback error: ' + e.message)
      }
    }

    res.json({ count: events.length, events: events })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT e.*,v.name AS venue_name,v.lat,v.lng,v.address AS venue_address,v.cover_photo AS venue_photo FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE e.id=$1`, [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Event not found' })
    const sources = await query(`SELECT provider,provider_id FROM event_sources WHERE event_id=$1`, [req.params.id])
    res.json({ ...rows[0], sources: sources.rows })
  } catch (err) { next(err) }
})

module.exports = router
