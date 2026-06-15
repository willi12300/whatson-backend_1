const express = require('express')
const { CITIES } = require('../config')
const { chatJSON } = require('../clients/gemini')
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

const SYSTEM = `You are Sappo — a warm, funny, switched-on local mate who helps people plan real days and nights out. You are NOT a corporate chatbot and NOT a form. You text like a real friend: relaxed, natural, a bit of personality, short messages.

Your goal: have a quick, easy chat to understand what they fancy, then plan a great outing. Talk like a human — react to what they actually say, joke a little, keep it flowing. NEVER repeat a question you've already asked. NEVER ask more than a couple of things before just cracking on with a plan. If you've basically got the gist (roughly what they want + where), stop asking and make the plan — people hate being interrogated.

Each turn, reply ONLY with JSON in this shape:
{
  "say": "your natural, human reply to them — like a text from a mate",
  "ready_to_plan": true or false,
  "extracted": {
    "categories": [],   // any of: restaurant, cafe, bar, pub, nightclub, music_venue, comedy
    "vibe": null,       // chilled | chaos | cheap | date_night | hidden_gems | stag_hen | null
    "budget": null,     // cheap | moderate | premium | null
    "timing": null,     // tonight | tomorrow | weekend | null
    "cityMention": null // a city if they name one
  }
}

Set "ready_to_plan" to true as soon as you have a rough sense of what they want — don't wait for every detail. When ready_to_plan is true, your "say" should be something like "Love it, give me two secs to sort this…". Keep "say" warm and human every single time.`

// POST /concierge  { message, history?, selectedCity, lat, lng }
//   history: full prior thread [{ role:'user'|'sappo', text }]
router.post('/', async (req, res, next) => {
  try {
    const { message, history = [], selectedCity, lat, lng } = req.body || {}
    if (!message) return res.status(400).json({ error: 'message required' })

    // Build the full conversation for Gemini (this is the memory that stops loops).
    const thread = [...history, { role: 'user', text: message }]
    const geminiHistory = thread.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: m.text,
    }))

    // How many times has Sappo already replied? (used for the safety rail)
    const sappoTurns = history.filter(m => m.role === 'sappo').length

    // Let Gemini run the conversation with full context.
    let brain = await chatJSON(SYSTEM, geminiHistory, { temperature: 0.95 })
    const geminiWorking = !!(brain && brain.say)

    // Fallback if Gemini is unavailable: have a basic scripted chat, don't just dump a plan.
    if (!geminiWorking) {
      logger.warn('[concierge] Gemini unavailable — using scripted fallback')
      const intent = parseIntent(message)
      const hasEnough = (intent.categories?.length || intent.vibe)
      // First, gather a little before planning — don't plan from "yo".
      if (!hasEnough && sappoTurns < 1) {
        return res.json({
          type: 'reply',
          say: "Hey! What are you in the mood for — food, drinks, a night out, something chilled?",
          geminiDown: true,
        })
      }
      if (!hasEnough && sappoTurns < 2) {
        return res.json({
          type: 'reply',
          say: "Nice — and roughly what budget are we working with? Cheap and cheerful, comfortable, or treat yourselves?",
          geminiDown: true,
        })
      }
      return await makePlan(res, { selectedCity, lat, lng, intent: mergeIntent(thread, {}), sayBefore: "Right, let me sort you something…", geminiDown: true })
    }

    // SAFETY RAIL: if we've already asked enough, force a plan regardless.
    const forcePlan = sappoTurns >= MAX_QUESTIONS
    const ready = brain.ready_to_plan === true || forcePlan

    if (!ready) {
      // Still chatting — return Sappo's natural reply, no plan yet.
      return res.json({ type: 'reply', say: brain.say })
    }

    // Ready to plan — merge everything Gemini extracted across the convo.
    const intent = mergeIntent(thread, brain.extracted)
    return await makePlan(res, { selectedCity, lat, lng, intent, sayBefore: brain.say })
  } catch (err) { logger.error('[concierge] error:', err.message); next(err) }
})

// Pull intent from the whole conversation (Gemini's extract + keyword backup).
function mergeIntent(thread, extracted = {}) {
  const merged = { categories: [], vibe: null, budget: null, timing: null, cityMention: null, raw: '' }
  // keyword-parse every user message as a backstop
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
  merged.vibe = extracted.vibe || merged.vibe
  merged.budget = extracted.budget || merged.budget
  merged.timing = extracted.timing || merged.timing
  merged.cityMention = extracted.cityMention || merged.cityMention
  return merged
}

async function makePlan(res, { selectedCity, lat, lng, intent, sayBefore, geminiDown }) {
  const loc = resolveLocation({ lat, lng, selectedCity, promptCity: intent.cityMention })
  logger.info('[concierge] planning', JSON.stringify({ city: loc.cityName, categories: intent.categories, vibe: intent.vibe, budget: intent.budget, timing: intent.timing }))

  let weather = null
  try { weather = await getWeather(loc.lat, loc.lng) } catch (e) { logger.error('[concierge] weather skipped:', e.message) }

  const plan = await planNight({
    city: loc.cityName,
    text: intent.raw,
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
    const out = await chatJSON(
      'You are a test. Reply ONLY with JSON: {"say":"a friendly hello","ready_to_plan":false,"extracted":{}}',
      [{ role: 'user', text: 'say hi' }],
      { temperature: 0.5 }
    )
    if (out && out.say) {
      return res.json({ gemini: 'WORKING ✓', reply: out.say, keyPresent: !!process.env.GEMINI_API_KEY })
    }
    return res.json({ gemini: 'NOT WORKING ✗', reply: null, keyPresent: !!process.env.GEMINI_API_KEY, hint: 'Gemini returned nothing — likely missing/invalid GEMINI_API_KEY or model name rejected. Check Railway logs for "Gemini chat failed".' })
  } catch (e) {
    return res.json({ gemini: 'ERROR ✗', error: e.message, keyPresent: !!process.env.GEMINI_API_KEY })
  }
})

module.exports = router
