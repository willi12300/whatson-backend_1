const express = require('express')
const { CITIES } = require('../config')
const { parseIntent, missingInfo } = require('../services/parseIntent')
const { runConversation } = require('../services/conversationBrain')
const { planNight } = require('../services/planNight')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// Resolve the planning city with clear priority + logging.
function resolveLocation({ lat, lng, selectedCity, promptCity }) {
  const log = { gpsCoords: null, selectedCity: selectedCity || null, promptCity: promptCity || null, finalCity: null, coordsUsed: null }
  let cityName = promptCity || selectedCity || 'Liverpool'
  log.finalCity = cityName
  let useLat = lat, useLng = lng
  if (useLat == null || useLng == null) {
    const preset = CITIES[(cityName || '').toLowerCase()]
    if (preset) { useLat = preset.lat; useLng = preset.lng }
  } else {
    log.gpsCoords = { lat, lng }
  }
  log.coordsUsed = { lat: useLat, lng: useLng }
  return { cityName, lat: useLat, lng: useLng, log }
}

async function fetchWeather(loc) {
  try {
    const w = await getWeather(loc.lat, loc.lng)
    logger.info('[concierge] weather', JSON.stringify({ city: loc.cityName, temp: w?.current?.temp, condition: w?.current?.condition }))
    return w
  } catch (e) { logger.error('[concierge] weather failed:', e.message); return null }
}

async function buildPlan(loc, intent, weather, res) {
  const plan = await planNight({
    city: loc.cityName,
    text: intent.raw,
    vibe: intent.vibe,
    stops: 3,
    weather,
    budget: (intent.budget || intent.budgetPerPerson) ? { budget_level: intent.budget, budget_per_person: intent.budgetPerPerson } : null,
    busyPref: intent.busyPref,
    categories: intent.categories || [],
    lat: loc.lat, lng: loc.lng,
  })
  if (plan.error) {
    return res.json({ type: 'plan_error', message: plan.error === 'no_venues' ? `I haven't got ${loc.cityName} covered just yet — try Liverpool or Manchester?` : "Couldn't pull that together — try again?" })
  }
  return res.json({
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
}

// POST /concierge
// Body: { message, history?, selectedCity, lat, lng, context? }
//   history: [{ role:'user'|'sappo', text }]  (full thread so far, optional)
// Returns: { type:'reply', reply, action:'ask'|'planning', options[], state } then plan,
//          OR legacy { type:'follow_up'|'plan' }
router.post('/', async (req, res, next) => {
  try {
    const { message, history = [], selectedCity, lat, lng, context = {} } = req.body || {}
    if (!message && !history.length) return res.status(400).json({ error: 'message required' })

    // Build full thread (append the new message if not already in history)
    const thread = [...history]
    if (message) thread.push({ role: 'user', text: message })

    // Resolve location early (need city for the brain + weather)
    const quickHint = parseIntent(message || thread[thread.length - 1]?.text || '')
    const loc = resolveLocation({ lat, lng, selectedCity, promptCity: quickHint.cityMention })
    logger.info('[concierge] location', JSON.stringify(loc.log))

    const weather = await fetchWeather(loc)
    const weatherNote = weather?.current ? `${weather.current.temp}°C, ${weather.current.condition}${weather.planningHint?.note ? ' — ' + weather.planningHint.note : ''}` : null

    // How many questions has Sappo already asked in this thread?
    const askedCount = thread.filter(m => m.role === 'sappo').length

    // Let Gemini run the conversation
    const brain = await runConversation(
      thread.map(m => ({ role: m.role, text: m.text })),
      { city: loc.cityName, weatherNote, askedCount }
    )

    if (brain) {
      logger.info('[concierge] brain', JSON.stringify({ action: brain.action, reply: brain.reply }))
      // Re-resolve city if Gemini picked up a city mention the keyword parser missed
      if (brain.intent?.cityMention && brain.intent.cityMention !== loc.cityName) {
        const loc2 = resolveLocation({ lat, lng, selectedCity, promptCity: brain.intent.cityMention })
        loc.cityName = loc2.cityName; loc.lat = loc2.lat; loc.lng = loc2.lng
        logger.info('[concierge] city override →', loc.cityName)
      }

      if (brain.action === 'ask' && askedCount < 1) {
        return res.json({
          type: 'reply',
          reply: brain.reply,
          action: 'ask',
          options: brain.options || [],
        })
      }
      // action === 'plan' (or we've already asked once — just plan now)
      if (brain.action === 'ask' && askedCount >= 1) {
        logger.info('[concierge] question cap hit — planning anyway')
      }
      // action === 'plan': say the natural line, then build the plan in the same response
      const planRes = await (async () => {
        const w = weather || await fetchWeather(loc)
        return buildPlan(loc, brain.intent, w, res)
      })()
      return planRes
    }

    // ── Fallback: Gemini unavailable. Use the old keyword flow so it still works. ──
    logger.warn('[concierge] using keyword fallback')
    const intent = quickHint
    if (context.timing) intent.timing = context.timing
    if (context.budget) intent.budget = context.budget
    const asked = context.asked || []
    const missing = missingInfo(intent).filter(m => !asked.includes(m))
    if (missing.length && asked.length < 1) {
      const q = followUp(missing[0])
      return res.json({ type: 'follow_up', question: q.question, options: q.options, key: q.key, state: { intent, asked: [...asked, missing[0]], city: loc.cityName } })
    }
    return buildPlan(loc, intent, weather, res)
  } catch (err) { logger.error('[concierge] error:', err.message); next(err) }
})

function followUp(key) {
  if (key === 'timing') return { key: 'timing', question: "Nice one. When are you thinking — tonight, or another day?", options: ['Tonight', 'Tomorrow', 'This weekend'] }
  if (key === 'budget') return { key: 'budget', question: "Got it. Rough budget per person?", options: ['Cheap', 'Comfortable', 'Treat ourselves'] }
  return { key, question: 'Tell me a bit more?', options: [] }
}

module.exports = router
