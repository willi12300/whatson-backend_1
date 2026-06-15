const express = require('express')
const { CITIES } = require('../config')
const { chatText } = require('../clients/gemini')
const { parseIntent } = require('../services/parseIntent')
const { planNight } = require('../services/planNight')
const { getWeather } = require('../clients/weather')
const logger = require('../utils/logger')
const router = express.Router()

// Hard safety rail: never ask more than this many questions before planning.
const MAX_QUESTIONS = 3

function resolveLocation({ lat, lng, selectedCity, promptCity }) {
  let cityName = promptCity || selectedCity || 'Liverpool'
  let useLat = lat, useLng = lng
  if (useLat == null || useLng == null) {
    const preset = CITIES[(cityName || '').toLowerCase()]
    if (preset) { useLat = preset.lat; useLng = preset.lng }
  }
  return { cityName, lat: useLat, lng: useLng }
}

const SYSTEM = `You are Sappo — a warm, switched-on local guide who helps travellers and visitors make the most of a place. Someone's arrived in a city (or has a few hours, a day, a weekend) and doesn't know what to do. Your job is to understand what they're after and build them a brilliant day or outing.

You talk like a real person — friendly, natural, a little personality, short messages like a mate who knows the city. NOT a corporate bot, NOT a form.

How you work:
- Open warm: figure out their situation — how long they've got, where, and what they're into (history, food, music, views, culture, hidden gems, or just "surprise me").
- React to what they actually say. If they've got one day, think about fitting things into a day. If they've a few hours before a train, keep it tight and close.
- Ask only what you genuinely need — usually just what they're into and how long they've got. One light question at a time. Never interrogate.
- The moment you've got enough to make a cracking plan, make it. Don't over-ask.

You are a TRAVEL COMPANION. Your job is to create experiences and help people discover a place — not to list venues. Think itinerary: a few great stops that flow well, fit their time, and make the most of where they are.

Reply in natural plain text — just talk to them like a friend. Don't use JSON, don't use bullet lists, just chat.`

// POST /concierge  { message, history?, selectedCity, lat, lng }
//   history: full prior thread [{ role:'user'|'sappo', text }]
router.post('/', async (req, res, next) => {
  try {
    const { message, history = [], selectedCity, lat, lng } = req.body || {}
    if (!message) return res.status(400).json({ error: 'message required' })

    // Build the full conversation for Gemini (full history = memory = no loops).
    const thread = [...history, { role: 'user', text: message }]
    const geminiHistory = thread.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: m.text,
    }))
    const sappoTurns = history.filter(m => m.role === 'sappo').length

    // Decide if the user clearly wants the plan NOW (so we don't keep chatting).
    const userWantsPlanNow = /\b(plan|sort|go on then|do it|let'?s go|build it|make it|surprise me|just pick|whatever)\b/i.test(message)

    // Let Gemini just TALK — plain text, no JSON straitjacket (this is what stops the loop).
    const reply = await chatText(SYSTEM, geminiHistory, { temperature: 1.0 })

    // If Gemini is down, fall back gracefully — advance using what the USER said,
    // not a turn counter (which can be stuck at 0 if history isn't arriving).
    if (!reply) {
      logger.warn('[concierge] Gemini unavailable — fallback path')
      const intent = mergeIntent(thread, {})
      const userGaveSomething = intent.categories.length || intent.vibe || intent.cityMention ||
        (message && message.trim().length > 3 && !/^(yo|hi|hey|hello|sup|alright|hiya|yo!)\W*$/i.test(message.trim()))
      if (!userGaveSomething) {
        return res.json({ type: 'reply', say: "Hey! Where are you and what are you into — food, history, music, views, hidden gems?", geminiDown: true })
      }
      // They've told us something — make the plan rather than asking again.
      return await makePlan(res, { selectedCity, lat, lng, intent, sayBefore: "Right, let me sort you something…", geminiDown: true })
    }

    // Decide whether it's time to build the plan. Robust triggers:
    //  - the user explicitly asked, OR
    //  - we know enough (they've named an interest/category/vibe) AND we've had a little chat, OR
    //  - we've gone back and forth enough times (hard cap), OR
    //  - Gemini clearly signals it's about to plan.
    const known = mergeIntent(thread, {})
    const weKnowEnough = !!(known.categories.length || known.vibe || known.raw.length > 25)
    const geminiSignalsReady = /(give me|let me (sort|put|build|pull)|on it|sorting (this|that)|here'?s (what|the)|i'?ll (sort|put|build))/i.test(reply)
    const enoughChat = sappoTurns >= MAX_QUESTIONS
    const ready = userWantsPlanNow || geminiSignalsReady || enoughChat || (weKnowEnough && sappoTurns >= 1)

    if (!ready) {
      // Keep the conversation flowing — just return Gemini's natural reply.
      return res.json({ type: 'reply', say: reply })
    }

    // Time to plan.
    return await makePlan(res, { selectedCity, lat, lng, intent: known, sayBefore: reply })
  } catch (err) { logger.error('[concierge] error:', err.message); next(err) }
})

// Pull intent from the whole conversation (lightweight keyword parse — no JSON needed).
function mergeIntent(thread, extracted = {}) {
  const merged = { categories: [], vibe: null, budget: null, timing: null, cityMention: null, keywords: [], raw: '' }
  for (const m of thread) {
    if (m.role !== 'user') continue
    const p = parseIntent(m.text)
    if (p.categories?.length) merged.categories = Array.from(new Set([...merged.categories, ...p.categories]))
    merged.vibe = merged.vibe || p.vibe
    merged.budget = merged.budget || p.budget
    merged.timing = merged.timing || p.timing
    merged.cityMention = merged.cityMention || p.cityMention
    merged.raw = merged.raw ? merged.raw + ' ' + m.text : m.text
  }
  // Gemini's extraction wins where present
  if (extracted.categories?.length) merged.categories = Array.from(new Set([...merged.categories, ...extracted.categories]))
  if (extracted.keywords?.length) merged.keywords = Array.from(new Set([...merged.keywords, ...extracted.keywords]))
  merged.keywords = merged.raw ? (merged.raw.match(/[a-z]{4,}/gi) || []) : []
  return merged
}

async function makePlan(res, { selectedCity, lat, lng, intent, sayBefore, geminiDown }) {
  const loc = resolveLocation({ lat, lng, selectedCity, promptCity: intent.cityMention })
  logger.info('[concierge] planning', JSON.stringify({ city: loc.cityName, categories: intent.categories, keywords: intent.keywords, vibe: intent.vibe, budget: intent.budget }))

  let weather = null
  try { weather = await getWeather(loc.lat, loc.lng) } catch (e) { logger.error('[concierge] weather skipped:', e.message) }

  // The planner keyword-matches venue names against the user's actual words.
  const planText = intent.raw || ''

  const plan = await planNight({
    city: loc.cityName,
    text: planText,
    vibe: intent.vibe,
    stops: 3,
    weather,
    budget: intent.budget ? { budget_level: intent.budget } : null,
    categories: intent.categories || [],
    lat: loc.lat, lng: loc.lng,
  })

  if (plan.error) {
    return res.json({ type: 'reply', say: `I haven't got ${loc.cityName} fully covered yet — want to try Liverpool or Manchester?` })
  }

  return res.json({
    type: 'plan',
    say: sayBefore || "Here's what I'm thinking…",
    city: loc.cityName,
    title: plan.title,
    summary: plan.vibe,
    reasoning: plan.reasoning,
    cost: plan.cost,
    stops: plan.stops,
    gettingHome: plan.gettingHome,
    tip: plan.tip,
    weather_note: plan.weatherNote,
    geminiDown: geminiDown || false,
  })
}

// GET /concierge/test-gemini — quick health check you can hit in a browser.
// Tells you if Gemini is actually responding on this server.
router.get('/test-gemini', async (req, res) => {
  try {
    const out = await chatText(
      'You are Sappo. Reply in one short friendly sentence.',
      [{ role: 'user', text: 'say hi' }],
      { temperature: 0.5 }
    )
    if (out) {
      return res.json({ gemini: 'WORKING ✓', reply: out, keyPresent: !!process.env.GEMINI_API_KEY })
    }
    return res.json({ gemini: 'NOT WORKING ✗', reply: null, keyPresent: !!process.env.GEMINI_API_KEY, hint: 'Gemini returned nothing — likely missing/invalid GEMINI_API_KEY. Check Railway logs for "Gemini text failed".' })
  } catch (e) {
    return res.json({ gemini: 'ERROR ✗', error: e.message, keyPresent: !!process.env.GEMINI_API_KEY })
  }
})

module.exports = router
