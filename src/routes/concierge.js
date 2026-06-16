const express = require('express')
const { CITIES } = require('../config')
const { chatText, buildItinerary } = require('../clients/gemini')
const { parseIntent } = require('../services/parseIntent')
const { planNight } = require('../services/planNight')
const { getWeather } = require('../clients/weather')
const { query } = require('../db/pool')
const { findPlace, reverseGeocode } = require('../clients/google')
const { getProfile, plannerBoosts } = require('../services/travelProfile')
const logger = require('../utils/logger')
const router = express.Router()

// Hard safety rail: never ask more than this many questions before planning.
const MAX_QUESTIONS = 3

// Find the nearest known PRESET city (fallback only, when geocoding is unavailable).
function nearestCity(lat, lng) {
  if (lat == null || lng == null) return null
  const R = 6371, r = x => x * Math.PI / 180
  let best = null
  for (const [key, c] of Object.entries(CITIES)) {
    const dLat = r(c.lat - lat), dLng = r(c.lng - lng)
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(lat)) * Math.cos(r(c.lat)) * Math.sin(dLng / 2) ** 2
    const distKm = 2 * R * Math.asin(Math.sqrt(h))
    if (!best || distKm < best.distKm) best = { key, name: c.name, lat: c.lat, lng: c.lng, distKm }
  }
  return best
}

// GLOBAL location resolution. Works anywhere in the world.
// Priority:
// 1. User explicitly said where they are in chat (promptCity) — always wins.
// 2. Real GPS → reverse-geocode to the ACTUAL city/town (any city on earth).
// 3. selectedCity (app setting) fallback.
// 4. Liverpool last resort.
async function resolveLocation({ lat, lng, selectedCity, promptCity }) {
  let cityName, country = null, useLat = lat, useLng = lng

  if (promptCity) {
    cityName = promptCity
  } else if (lat != null && lng != null) {
    // Real reverse-geocode — identifies the true city anywhere in the world.
    const geo = await reverseGeocode(lat, lng)
    if (geo?.city) {
      cityName = geo.city
      country = geo.country
    } else {
      // geocoding failed — fall back to nearest known preset, else selectedCity
      const near = nearestCity(lat, lng)
      cityName = (near && near.distKm <= 60) ? near.name : (selectedCity || 'Liverpool')
    }
  } else {
    cityName = selectedCity || 'Liverpool'
  }

  // No GPS → use the chosen preset city's centre (if known) for weather/distance.
  if (useLat == null || useLng == null) {
    const preset = CITIES[(cityName || '').toLowerCase().replace(/\s+/g, '')]
    if (preset) { useLat = preset.lat; useLng = preset.lng }
  }
  return { cityName, country, lat: useLat, lng: useLng }
}

const SYSTEM = `You are Sappo — a warm, switched-on local guide who helps travellers and visitors make the most of a place. Someone's arrived in a city (or has a few hours, a day, a weekend) and doesn't know what to do. Your job is to understand what they're after and build them a brilliant day or outing.

You talk like a real person — friendly, natural, a little personality, short messages like a mate who knows the city. NOT a corporate bot, NOT a form.

How you work:
- Open warm: figure out their situation — how long they've got, where, and what they're into (history, food, music, views, culture, hidden gems, or just "surprise me").
- React to what they actually say. If they've got one day, think about fitting things into a day. If they've a few hours before a train, keep it tight and close.
- Ask only what you genuinely need — usually just what they're into and how long they've got. One light question at a time. Never interrogate.
- The moment you've got enough to make a cracking plan, make it. Don't over-ask.

You are a TRAVEL COMPANION. Your job is to create experiences and help people discover a place — not to list venues. Think itinerary: a few great stops that flow well, fit their time, and make the most of where they are.

Reply in natural plain text — just talk to them like a friend. Don't use JSON, don't use bullet lists, just chat.

VERY IMPORTANT — how to trigger a plan:
- While you're still chatting, gathering info, or just being friendly, reply normally with NO marker.
- ONLY when you genuinely have enough to build them a great plan (you know roughly what they want and where), end your message with the exact marker [[PLAN]] on the end.
- The [[PLAN]] marker is the ONLY thing that builds a plan. If you don't add it, you just keep chatting.
- Do NOT add [[PLAN]] for small talk, greetings, jokes, or when they're still deciding. If someone says "what's up" or "talk to me" or changes their mind, just chat back warmly — no marker.
- CRUCIAL: When you add [[PLAN]], your message must be a SHORT, warm hand-off ONLY — do NOT name specific venues, places, or describe the itinerary in your text. The actual plan (with the real venues) is built and shown separately as a card right after. If you name places in your text they'll clash with the card. Just say something like "Love it — give me two secs to sort you a cracker." then [[PLAN]].
- Example (still chatting, no venues decided yet): "Ooh nice, three of you! Bowling then drinks sounds class. Whereabouts are you — town centre?"
- Example (ready — short hand-off, NO venue names): "Perfect, leave it with me — sorting you something brilliant now. [[PLAN]]"`

// POST /concierge  { message, history?, selectedCity, lat, lng }
//   history: full prior thread [{ role:'user'|'sappo', text }]
router.post('/', async (req, res, next) => {
  try {
    const { message, history = [], selectedCity, lat, lng, deviceId } = req.body || {}
    if (!message) return res.status(400).json({ error: 'message required' })

    // Load the traveller profile (by user if logged in, else device) for personalisation.
    let profileKey = req.userId ? { userId: req.userId } : (deviceId ? { deviceId } : null)
    let boosts = null
    if (profileKey) {
      try {
        const profile = await getProfile(profileKey)
        boosts = plannerBoosts(profile)
      } catch (e) { logger.error('[concierge] profile load failed:', e.message) }
    }

    // Resolve the user's location ONCE, up front. If GPS is present, we already
    // know the city — Gemini must NOT ask "where are you?" for nearby requests.
    const userLoc = await resolveLocation({ lat, lng, selectedCity, promptCity: null })
    const hasGPS = (lat != null && lng != null)
    logger.info('[concierge] location', JSON.stringify({
      gpsReceived: hasGPS, gps: hasGPS ? `${lat.toFixed(4)},${lng.toFixed(4)}` : null,
      selectedCity: selectedCity || null, resolvedCity: userLoc.cityName, country: userLoc.country || null,
    }))

    // Build a location-aware system prompt so Gemini behaves like it knows where they are.
    const locPrompt = hasGPS
      ? `\n\nLOCATION: The user's live GPS puts them in ${userLoc.country ? userLoc.cityName + ', ' + userLoc.country : userLoc.cityName}. You ALREADY KNOW where they are — do NOT ask "where are you?" or "what city are you in?". For "nearby" requests, use their location directly. You can say things like "I've found some great spots near you".`
      : `\n\nLOCATION: We don't have the user's GPS. If they ask for nearby places, ask where they're planning from.`
    const dynamicSystem = SYSTEM + locPrompt

    // Build the full conversation for Gemini (full history = memory = no loops).
    const thread = [...history, { role: 'user', text: message }]
    const geminiHistory = thread.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      text: m.text,
    }))
    const sappoTurns = history.filter(m => m.role === 'sappo').length

    // Decide if the user EXPLICITLY wants the plan now (direct request only).
    const userWantsPlanNow = /\b(make the plan|build the plan|plan it|sort it|do it now|just pick|surprise me|go on then|let'?s go)\b/i.test(message)

    // Let Gemini just TALK — plain text. It decides when it's ready to plan by ending
    // its message with the marker [[PLAN]] (we strip it before showing the user).
    const reply = await chatText(dynamicSystem, geminiHistory, { temperature: 1.0 })

    // If Gemini is down, fall back gracefully.
    if (!reply) {
      logger.warn('[concierge] Gemini unavailable — fallback path')
      const intent = mergeIntent(thread, {})
      const userGaveSomething = intent.categories.length || intent.vibe || intent.cityMention ||
        (message && message.trim().length > 3 && !/^(yo|hi|hey|hello|sup|alright|hiya|yo!)\W*$/i.test(message.trim()))
      if (!userGaveSomething) {
        return res.json({ type: 'reply', say: "Hey! Where are you and what are you into — food, history, music, views, hidden gems?", geminiDown: true })
      }
      return await makePlan(res, { selectedCity, lat, lng, intent, sayBefore: "Right, let me sort you something…", geminiDown: true, thread, boosts })
    }

    // GEMINI decides when to plan, by ending with [[PLAN]]. This is the only reliable
    // signal because Gemini is the one actually having the conversation.
    const geminiWantsPlan = /\[\[PLAN\]\]/i.test(reply)
    const cleanReply = reply.replace(/\[\[PLAN\]\]/ig, '').trim()
    const ready = geminiWantsPlan || userWantsPlanNow


    if (!ready) {
      // Keep the conversation flowing — just return Gemini's natural reply.
      return res.json({ type: 'reply', say: cleanReply })
    }

    // Time to plan.
    const known = mergeIntent(thread, {})
    // If Gemini's hand-off text is long/descriptive (likely naming venues that would
    // clash with the card), replace it with a clean short hand-off line.
    const handoff = (cleanReply && cleanReply.length <= 140 && cleanReply.split(/\s+/).length <= 26)
      ? cleanReply
      : "Love it — give me two secs to sort you something cracking…"
    return await makePlan(res, { selectedCity, lat, lng, intent: known, sayBefore: handoff, thread, boosts })
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

async function makePlan(res, { selectedCity, lat, lng, intent, sayBefore, geminiDown, thread, boosts }) {
  const loc = await resolveLocation({ lat, lng, selectedCity, promptCity: intent.cityMention })
  logger.info('[concierge] planning (hybrid)', JSON.stringify({
    city: loc.cityName,
    gpsReceived: (lat != null && lng != null),
    gps: (lat != null && lng != null) ? `${lat.toFixed(3)},${lng.toFixed(3)}` : null,
    selectedCity: selectedCity || null,
    categories: intent.categories,
  }))

  let weather = null
  try { weather = await getWeather(loc.lat, loc.lng) } catch (e) { logger.error('[concierge] weather skipped:', e.message) }

  // 1. Fetch a relevant shortlist of VERIFIED venues from our DB to offer Gemini.
  let dbVenues = []
  try {
    // Pull a category-DIVERSE shortlist (not 40 hotels) so Gemini has real food/drink/music options.
    const wantCats = (intent.categories && intent.categories.length)
      ? intent.categories
      : ['restaurant', 'bar', 'pub', 'cafe', 'music_venue', 'attraction', 'museum', 'landmark', 'gallery', 'park']
    const { rows } = await query(
      `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng
       FROM venues
       WHERE city = $1 AND name IS NOT NULL
         AND category_slug = ANY($2)
         AND category_slug NOT IN ('lodging','hotel')
       ORDER BY (COALESCE(rating,0) * LEAST(COALESCE(rating_count,0),500)) DESC
       LIMIT 50`,
      [loc.cityName, wantCats]
    )
    dbVenues = rows
    // if that came back thin, broaden (but still skip hotels)
    if (dbVenues.length < 8) {
      const { rows: more } = await query(
        `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng
         FROM venues WHERE city = $1 AND name IS NOT NULL
           AND category_slug NOT IN ('lodging','hotel')
         ORDER BY (COALESCE(rating,0) * LEAST(COALESCE(rating_count,0),500)) DESC
         LIMIT 40`,
        [loc.cityName]
      )
      dbVenues = more
    }
  } catch (e) { logger.error('[concierge] venue fetch failed:', e.message) }

  // 1b. PROXIMITY: when we have the user's GPS, rank the shortlist by distance so
  // "nearby" genuinely means nearby (not a great place 5 miles away).
  if (lat != null && lng != null && dbVenues.length) {
    dbVenues = dbVenues.map(v => {
      const km = haversineKm(lat, lng, v.lat, v.lng)
      return { ...v, _distKm: km }
    })
  }

  // 1c. PERSONALISATION: re-rank using the traveller profile boosts + proximity.
  if (dbVenues.length) {
    dbVenues = dbVenues
      .map(v => {
        let s = (v.rating || 0) * Math.min(v.rating_count || 0, 500)
        if (boosts?.categoryBoost) {
          s += (boosts.categoryBoost[v.category_slug] || 0) * 1000
          if (boosts.preferCheap && v.price_level && v.price_level <= 2) s += 2000
          if (boosts.preferCheap && v.price_level >= 3) s -= 1500
        }
        // proximity weighting (spec: nearby means nearby)
        if (v._distKm != null) {
          if (v._distKm < 0.3) s += 8000
          else if (v._distKm < 0.8) s += 5000
          else if (v._distKm < 1.5) s += 2500
          else if (v._distKm > 3) s -= 3000
        }
        return { ...v, _pscore: s }
      })
      .sort((a, b) => b._pscore - a._pscore)
  }

  // 2. Ask Gemini to build a hybrid itinerary (prefer DB venues, fill gaps with real places).
  const conversation = (thread || []).slice(-12)
  const prefNote = buildPrefNote(boosts)
  // Current local time for the city (so Gemini suggests time-appropriate places).
  const localTime = cityLocalTime(loc.cityName)
  const cityLabel = loc.country ? `${loc.cityName}, ${loc.country}` : loc.cityName
  const itin = geminiDown ? null : await buildItinerary(SYSTEM, conversation, dbVenues, { weather, prefNote, localTime, cityLabel })

  // 3. If the hybrid build worked, enrich each stop with verified data, coords, photo + map link.
  if (itin && Array.isArray(itin.stops) && itin.stops.length) {
    const byId = Object.fromEntries(dbVenues.map(v => [String(v.id), v]))
    const seen = new Set()
    const rawStops = itin.stops.filter(s => {
      const name = (s.dbId != null ? byId[String(s.dbId).replace(/\D/g, '')]?.name : null) || s.name
      if (!name || seen.has(name.toLowerCase())) return false
      seen.add(name.toLowerCase()); return true
    })

    // Build each stop; geocode the "Sappo pick" ones to get real coordinates + a photo.
    const stops = await Promise.all(rawStops.map(async (s, i) => {
      const db = s.dbId != null ? byId[String(s.dbId).replace(/\D/g, '')] : null
      let name = db?.name || s.name
      let address = db?.address || s.address || null
      let lat = db?.lat ?? null, lng = db?.lng ?? null
      let rating = db?.rating ?? null
      let photoUrl = null

      // For Sappo picks (no DB coords), look the place up so it can be pinned on the map.
      if ((lat == null || lng == null)) {
        const found = await findPlace(`${name}, ${address || loc.cityName}`)
        if (found) {
          lat = found.lat; lng = found.lng
          address = found.address || address
          rating = rating ?? found.rating
          photoUrl = found.photoUrl
          if (found.name) name = found.name
        }
      }

      const mapQuery = encodeURIComponent(`${name}${address ? ', ' + address : ', ' + loc.cityName}`)
      return {
        order: i + 1, name, why: s.why || '', address,
        category_slug: db?.category_slug || s.category || 'other',
        rating, lat, lng, photoUrl,
        verified: !!db,
        mapUrl: `https://www.google.com/maps/search/?api=1&query=${mapQuery}`,
      }
    }))

    // Walking time + distance between consecutive stops (best-effort).
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1]
      if (a.lat != null && b.lat != null) {
        const km = haversineKm(a.lat, a.lng, b.lat, b.lng)
        if (km != null) {
          const mins = Math.max(1, Math.round((km / 5) * 60)) // ~5km/h walking
          stops[i].toNext = { km: Math.round(km * 10) / 10, walkMins: mins }
        }
      }
    }

    if (stops.length) {
      // Map centre = average of stop coords
      const pts = stops.filter(s => s.lat != null)
      const centre = pts.length
        ? { lat: pts.reduce((a, s) => a + s.lat, 0) / pts.length, lng: pts.reduce((a, s) => a + s.lng, 0) / pts.length }
        : { lat: loc.lat, lng: loc.lng }
      return res.json({
        type: 'plan',
        say: sayBefore || "Here's what I'm thinking…",
        city: loc.cityName,
        title: itin.title || `A day in ${loc.cityName}`,
        summary: itin.summary || '',
        reasoning: itin.reasoning || null,
        tip: itin.tip || null,
        stops,
        mapCentre: centre,
        weather_note: weather?.current ? `${weather.current.temp}°C, ${weather.current.condition}${weather.planningHint?.note ? ' · ' + weather.planningHint.note : ''}` : null,
        weather: weather ? { temp: weather.current?.temp, condition: weather.current?.condition, icon: weather.current?.icon } : null,
        geminiDown: geminiDown || false,
      })
    }
  }

  // 4. Fallback to the database-only planner if the hybrid build failed.
  const plan = await planNight({
    city: loc.cityName, text: intent.raw || '', vibe: intent.vibe, stops: 3, weather,
    budget: intent.budget ? { budget_level: intent.budget } : null,
    categories: intent.categories || [], lat: loc.lat, lng: loc.lng,
  })
  if (plan.error) {
    return res.json({ type: 'reply', say: `I haven't got ${loc.cityName} fully covered yet — want to try Liverpool or Manchester?` })
  }
  // add map links to the fallback stops too
  const stops = (plan.stops || []).map(s => ({
    ...s,
    mapUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${s.name}, ${s.address || loc.cityName}`)}`,
    verified: true,
  }))
  return res.json({
    type: 'plan', say: sayBefore || "Here's what I'm thinking…", city: loc.cityName,
    title: plan.title, summary: plan.vibe, reasoning: plan.reasoning, cost: plan.cost,
    stops, gettingHome: plan.gettingHome, tip: plan.tip,
    weather_note: plan.weatherNote, geminiDown: geminiDown || false,
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

function haversineKm(a, b, c, d) {
  if ([a, b, c, d].some(x => x == null)) return null
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Turn profile boosts into a short natural note for Gemini (gentle personalisation).
function buildPrefNote(boosts) {
  if (!boosts) return ''
  const bits = []
  if (boosts.preferHidden) bits.push('they love hidden gems and local spots over obvious tourist traps')
  if (boosts.preferCheap) bits.push('they prefer good value / cheaper options')
  if (boosts.preferQuiet) bits.push('they prefer quieter places over busy crowds')
  if (boosts.preferLessWalking) bits.push('keep walking distances short')
  // top boosted categories
  const top = Object.entries(boosts.categoryBoost || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0])
  if (top.length) bits.push('they tend to enjoy: ' + top.join(', '))
  if (!bits.length) return ''
  return `\nThis traveller's known preferences (personalise gently, don't mention these notes): ${bits.join('; ')}.`
}

// Rough local time string for a city, using its timezone (for time-appropriate planning).
function cityLocalTime(cityName) {
  const TZ = {
    'Liverpool': 'Europe/London', 'Manchester': 'Europe/London', 'London': 'Europe/London',
    'Birmingham': 'Europe/London', 'Leeds': 'Europe/London', 'Glasgow': 'Europe/London',
    'Bristol': 'Europe/London', 'Edinburgh': 'Europe/London', 'Dublin': 'Europe/Dublin',
    'New York': 'America/New_York', 'Los Angeles': 'America/Los_Angeles',
    'Berlin': 'Europe/Berlin', 'Amsterdam': 'Europe/Amsterdam', 'Barcelona': 'Europe/Madrid',
    'Paris': 'Europe/Paris', 'Sydney': 'Australia/Sydney',
  }
  const tz = TZ[cityName] || 'Europe/London'
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', weekday: 'short', timeZone: tz }).format(new Date())
  } catch { return null }
}
