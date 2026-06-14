const express = require('express')
const { CITIES } = require('../config')
const { parseIntent, missingInfo } = require('../services/parseIntent')
const { planNight } = require('../services/planNight')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// Resolve the planning city with clear priority + logging.
function resolveLocation({ lat, lng, selectedCity, promptCity }) {
  const log = { gpsCoords: null, selectedCity: selectedCity || null, promptCity: promptCity || null, finalCity: null, coordsUsed: null }

  // 1. GPS coordinates win for distance/weather, but we still need a city name for venue lookup.
  // 2-4. City name priority: prompt mention > selected city > fallback.
  let cityName = promptCity || selectedCity || 'Liverpool'
  log.finalCity = cityName

  // coordinates: prefer GPS, else city centre preset
  let useLat = lat, useLng = lng
  if (useLat == null || useLng == null) {
    const preset = CITIES[cityName.toLowerCase()]
    if (preset) { useLat = preset.lat; useLng = preset.lng }
  } else {
    log.gpsCoords = { lat, lng }
  }
  log.coordsUsed = { lat: useLat, lng: useLng }
  return { cityName, lat: useLat, lng: useLng, log }
}

// POST /concierge  { message, deviceId, selectedCity, lat, lng, context }
// context carries answers gathered so far: { timing, budget }
// Returns either { type:'follow_up', question, options, key } or { type:'plan', ... }
router.post('/', async (req, res, next) => {
  try {
    const { message, selectedCity, lat, lng, context = {} } = req.body || {}
    if (!message && !context.intent) return res.status(400).json({ error: 'message required' })

    // 1. Parse intent (merge with any prior context)
    const parsed = message ? parseIntent(message) : (context.intent || {})
    const intent = { ...parsed, ...stripNull(context.merge || {}) }
    // apply follow-up answers
    if (context.timing) intent.timing = context.timing
    if (context.budget) intent.budget = context.budget

    // 2. Resolve location
    const loc = resolveLocation({ lat, lng, selectedCity, promptCity: intent.cityMention })
    logger.info('[concierge] location', JSON.stringify(loc.log))
    logger.info('[concierge] intent', JSON.stringify({ categories: intent.categories, vibe: intent.vibe, budget: intent.budget, busyPref: intent.busyPref, timing: intent.timing }))

    // 3. Decide on a follow-up question (max 1-2 total across the convo)
    const asked = context.asked || []
    const missing = missingInfo(intent).filter(m => !asked.includes(m))
    if (missing.length && asked.length < 2) {
      const q = followUp(missing[0])
      return res.json({
        type: 'follow_up',
        question: q.question,
        options: q.options,
        key: q.key,
        // echo state so the client can send it back with the answer
        state: { intent, asked: [...asked, missing[0]], city: loc.cityName },
      })
    }

    // 4. Fetch live weather for the resolved location
    let weather = null
    try {
      weather = await getWeather(loc.lat, loc.lng)
      logger.info('[concierge] weather', JSON.stringify({ city: loc.cityName, temp: weather?.current?.temp, condition: weather?.current?.condition }))
    } catch (e) { logger.error('[concierge] weather failed:', e.message) }

    // 5. Build the plan with full intent
    const plan = await planNight({
      city: loc.cityName,
      text: intent.raw || message,
      vibe: intent.vibe,
      stops: 3,
      weather,
      budget: intent.budget ? { budget_level: intent.budget, budget_per_person: intent.budgetPerPerson } : null,
      busyPref: intent.busyPref,
      categories: intent.categories,
      lat: loc.lat, lng: loc.lng,
    })

    if (plan.error) return res.status(404).json({ type: 'error', message: plan.error === 'no_venues' ? `I don't have venues for ${loc.cityName} yet.` : 'Could not build a plan.' })

    res.json({
      type: 'plan',
      city: loc.cityName,
      summary: plan.vibe || plan.title,
      title: plan.title,
      weather_note: plan.weatherNote,
      reasoning: plan.reasoning,
      cost: plan.cost,
      stops: plan.stops,
      gettingHome: plan.gettingHome,
      tip: plan.tip,
    })
  } catch (err) { logger.error('[concierge] error:', err.message); next(err) }
})

function followUp(key) {
  if (key === 'timing') return { key: 'timing', question: "Nice. When are we thinking?", options: ['Tonight', 'Tomorrow', 'This weekend'] }
  if (key === 'budget') return { key: 'budget', question: "Sound. What's the budget like?", options: ['Cheap', 'Comfortable', 'Treat ourselves'] }
  return { key, question: 'Tell me a bit more?', options: [] }
}
function stripNull(o) { const r = {}; for (const k in o) if (o[k] != null) r[k] = o[k]; return r }

module.exports = router
