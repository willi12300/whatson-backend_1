const { config, CITIES } = require('../config')
const skiddle = require('../clients/skiddle')
const logger = require('../utils/logger')

// City browsing must refresh independently of GPS or the number of stored events.
// Share each refresh between visitors; never fan out provider requests per search.
function createEventRefresher({ fetchEvents, matchVenue, saveEvent, now = Date.now, hasKey = () => true, ttl = 3600000, retryDelay = 60000 }) {
  const states = new Map()
  function refresh(city) {
    if (!hasKey()) return { state: { status: 'unavailable', reason: 'provider_not_configured' }, promise: Promise.resolve() }
    let state = states.get(city.name)
    if (!state) { state = { status: 'idle', checkedAt: null, lastAttempt: null }; states.set(city.name, state) }
    if (state.promise) return { state, promise: state.promise }
    const age = now() - (state.lastAttempt ?? -Infinity)
    if ((state.status === 'ready' && age < ttl) || (state.status === 'error' && age < retryDelay)) return { state, promise: Promise.resolve() }
    state.status = 'refreshing'; state.lastAttempt = now(); state.fetched = 0; state.saved = 0; state.skipped = 0
    state.promise = (async () => {
      try {
        const start = new Date(now()).toISOString().slice(0, 10)
        const end = new Date(now() + 60 * 86400000).toISOString().slice(0, 10)
        // Explicit date order + all pages: no trending-results cap hides busy days.
        const events = await fetchEvents(city.lat, city.lng, city.radiusMiles, 60, { minDate: start, maxDate: end, strict: true })
        state.fetched = events.length
        const venueMatches = new Map()
        let cursor = 0
        const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
          while (cursor < events.length) {
            const e = events[cursor++]
            const key = [e.venueName, e.venueLat, e.venueLng, e.venueAddress].join('|')
            if (!venueMatches.has(key)) venueMatches.set(key, Promise.resolve().then(() => matchVenue(e, city.name)))
            const match = await venueMatches.get(key)
            if (match.method === 'none') { state.skipped++; continue }
            await saveEvent(e, match.venueId, match.confidence)
            state.saved++
          }
        }))
        if (workers.some(worker => worker.status === 'rejected')) throw new Error('Event import failed')
        state.status = 'ready'; state.checkedAt = new Date(now()).toISOString()
        logger.info(`[events] ${city.name}: refreshed ${state.saved}/${state.fetched} Skiddle events`)
      } catch (_) {
        // Leave previously stored events available and retry, rather than caching a partial success.
        state.status = 'error'
        logger.error(`[events] ${city.name}: refresh failed; retaining stored listings`)
      } finally { state.promise = null }
    })()
    return { state, promise: state.promise }
  }
  function status(city) {
    const state = states.get(city.name)
    return state ? { status: state.status, checked_at: state.checkedAt, fetched: state.fetched, saved: state.saved, skipped: state.skipped } : { status: 'idle' }
  }
  return { refresh, status }
}

const refresher = createEventRefresher({
  fetchEvents: skiddle.fetchEvents,
  matchVenue: (...args) => require('./matchEvents').matchEventToVenue(...args),
  saveEvent: (...args) => require('./sync').upsertEvent(...args),
  hasKey: () => Boolean(config.skiddle.key),
})
const watchedCities = new Set(['Liverpool'])

function cityPreset(name) {
  return Object.values(CITIES).find(city => city.name.toLowerCase() === String(name || '').toLowerCase())
}

async function ensureCityEvents(name, waitMs = 1200) {
  const city = cityPreset(name)
  if (!city) return { status: 'unsupported' }
  watchedCities.add(city.name)
  const { state, promise } = refresher.refresh(city)
  if (state.status === 'unavailable') return state
  let timer
  await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, waitMs) })])
  clearTimeout(timer)
  return refresher.status(city)
}

function startEventRefresh() {
  // Warm Liverpool after startup and keep requested cities fresh each hour.
  const warm = () => { for (const name of watchedCities) ensureCityEvents(name, 0).catch(() => {}) }
  const timer = setInterval(warm, 3600000); timer.unref()
  warm()
  return timer
}

module.exports = { createEventRefresher, ensureCityEvents, startEventRefresh }
