const express = require('express')
const { CITIES } = require('../config')
const { extractState, mergeState, emptyState } = require('../services/conversationBrain')
const { planNight } = require('../services/planNight')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// ── Required fields to make a good plan ──
// We need: a location, a rough activity preference, and ideally budget + timing.
// But we HARD-CAP at 2 questions, then plan regardless.
function missingRequired(state) {
  const missing = []
  // location is resolved separately (city always available via selected city), so not asked
  if (!state.categories?.length && !state.vibe) missing.push('activity')
  if (!state.budget && !state.budgetPerPerson) missing.push('budget')
  if (!state.timing) missing.push('timing')
  return missing
}

const QUESTIONS = {
  activity: { key: 'activity', q: "What are you in the mood for — food, drinks, live music, something else?", options: ['Food', 'Drinks', 'Live music', 'A bit of everything'] },
  budget:   { key: 'budget',   q: "What's the budget like?", options: ['Cheap', 'Comfortable', 'Treat ourselves'] },
  timing:   { key: 'timing',   q: "When are you thinking?", options: ['Tonight', 'Tomorrow', 'This weekend'] },
}

// Map a tapped/typed answer onto state, given which field we asked about.
function applyAnswer(state, askedKey, answer) {
  const a = (answer || '').toLowerCase()
  if (askedKey === 'budget') {
    state.budget = /cheap|skint|budget/.test(a) ? 'cheap' : /treat|fancy|posh|splurge/.test(a) ? 'premium' : 'moderate'
  } else if (askedKey === 'timing') {
    state.timing = /weekend|saturday|sunday|friday/.test(a) ? 'weekend' : /tomorrow/.test(a) ? 'tomorrow' : 'tonight'
  } else if (askedKey === 'activity') {
    const map = { food: 'restaurant', drinks: 'bar', 'live music': 'music_venue', music: 'music_venue', comedy: 'comedy', pub: 'pub', club: 'nightclub' }
    for (const [word, cat] of Object.entries(map)) if (a.includes(word)) state.categories = Array.from(new Set([...(state.categories || []), cat]))
    if (a.includes('everything') || a.includes('surprise')) state.vibe = state.vibe || 'chilled'
  }
  return state
}

function resolveLocation({ lat, lng, selectedCity, promptCity }) {
  const log = { gpsCoords: null, selectedCity: selectedCity || null, promptCity: promptCity || null, finalCity: null, coordsUsed: null }
  let cityName = promptCity || selectedCity || 'Liverpool'
  log.finalCity = cityName
  let useLat = lat, useLng = lng
  if (useLat == null || useLng == null) {
    const preset = CITIES[(cityName || '').toLowerCase()]
    if (preset) { useLat = preset.lat; useLng = preset.lng }
  } else { log.gpsCoords = { lat, lng } }
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

async function buildPlan(loc, state, weather, ack, res) {
  const plan = await planNight({
    city: loc.cityName,
    text: state._lastMessage || '',
    vibe: state.vibe,
    stops: 3,
    weather,
    budget: (state.budget || state.budgetPerPerson) ? { budget_level: state.budget, budget_per_person: state.budgetPerPerson } : null,
    busyPref: state.busyPref,
    categories: state.categories || [],
    lat: loc.lat, lng: loc.lng,
  })
  if (plan.error) {
    return res.json({ type: 'plan_error', message: plan.error === 'no_venues' ? `I haven't got ${loc.cityName} covered yet — try Liverpool or Manchester?` : "Couldn't pull that together — try again?", state })
  }
  return res.json({
    type: 'plan',
    city: loc.cityName,
    ack: ack || null,
    summary: plan.vibe || plan.title,
    title: plan.title,
    weather_note: plan.weatherNote,
    reasoning: plan.reasoning,
    cost: plan.cost,
    stops: plan.stops,
    gettingHome: plan.gettingHome,
    tip: plan.tip,
    state,
  })
}

// POST /concierge
// Body: { message, state?, askedKey?, askedKeys?, selectedCity, lat, lng }
//   state: the conversation_state echoed back from the previous turn
//   askedKey: which field we asked about last turn (so we can map the answer)
//   askedKeys: list of fields already asked (to enforce never-ask-twice + cap)
router.post('/', async (req, res, next) => {
  try {
    const { message, state: prevState, askedKey, askedKeys = [], selectedCity, lat, lng } = req.body || {}
    if (!message) return res.status(400).json({ error: 'message required' })

    let state = mergeState(emptyState(), prevState || {})
    state._lastMessage = message

    // 1. If this message is an answer to a question we asked, map it directly.
    if (askedKey) applyAnswer(state, askedKey, message)

    // 2. Extract structured info from the message (Gemini + keyword fallback).
    const loc0 = resolveLocation({ lat, lng, selectedCity, promptCity: state.cityMention })
    const { extracted, ack } = await extractState(message, state, loc0.cityName)
    state = mergeState(state, extracted)

    // 3. Resolve location with any newly-mentioned city.
    const loc = resolveLocation({ lat, lng, selectedCity, promptCity: state.cityMention })
    state.city = loc.cityName
    logger.info('[concierge] location', JSON.stringify(loc.log))
    logger.info('[concierge] state', JSON.stringify(slim(state)))

    // 4. Decide deterministically: ask or plan.
    const missing = missingRequired(state).filter(k => !askedKeys.includes(k))
    const canAskMore = askedKeys.length < 2

    logger.info('[concierge] decision', JSON.stringify({ missing, askedKeys, canAskMore }))

    if (missing.length && canAskMore) {
      const ask = QUESTIONS[missing[0]]
      return res.json({
        type: 'reply',
        action: 'ask',
        reply: ack ? `${ack} ${ask.q}` : ask.q,
        options: ask.options,
        askedKey: ask.key,
        askedKeys: [...askedKeys, ask.key],
        state,
      })
    }

    // 5. Enough info (or hit the cap) → plan now.
    const weather = await fetchWeather(loc)
    return await buildPlan(loc, state, weather, ack, res)
  } catch (err) { logger.error('[concierge] error:', err.message); next(err) }
})

function slim(s) {
  const o = {}
  for (const [k, v] of Object.entries(s || {})) {
    if (k.startsWith('_')) continue
    if (v == null) continue
    if (Array.isArray(v) && !v.length) continue
    o[k] = v
  }
  return o
}

module.exports = router
