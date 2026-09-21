// src/services/planNight.js
// Builds an AI night plan: pull real venues/events for the city, give Gemini a
// shortlist, let it compose a themed itinerary that ONLY references real places.

const { query } = require('../db/pool')
const { generateJSON } = require('../clients/gemini')
const { getTravel } = require('./travelProvider')
const { estimatePlanCost, budgetGuidance } = require('./costEstimate')
const { estimateBusy } = require('./busyEstimate')
const { filterCandidatesForPlan, estimateItinerarySchedule, isTimeAppropriate, apiHours } = require('./openingHours')
const logger = require('../utils/logger')
const { buildTemplateExperience } = require('./experienceTemplateEngine')

// Surprise-me mode flavour text fed into the prompt
const MODE_HINTS = {
  chilled:   'a relaxed, low-key evening — cosy pubs, cafés, calm bars',
  chaos:     'a high-energy, wild night out — busy bars, clubs, live music, dancing',
  cheap:     'a budget-friendly night — cheap eats, happy hours, free entry where possible',
  date_night:'a romantic date night — nice restaurant, intimate bar, something memorable',
  hidden_gems:'off-the-beaten-path local favourites that tourists would miss',
  stag_hen:  'a big group celebration — lively bars, group-friendly spots, party atmosphere',
}

// Compatibility entry point for existing concierge and smart-search callers.
// It deliberately delegates to the template engine: venue selection is now
// deterministic and time-aware before Gemini is asked to explain it.
async function planNight({ city, vibe, mode, text, stops = 3, weather, home, budget, busyPref, categories = [], lat, lng, audience, availableMinutes, energy, walkingPreference }) {
  return buildTemplateExperience({ city, vibe, mode, text, weather, budget, categories, lat, lng, audience, availableMinutes, energy, walkingPreference, now: new Date() })
}

// Retained temporarily as a reference during rollout; no route calls it.
async function legacyPlanNight({ city, vibe, mode, text, stops = 3, weather, home, budget, busyPref, categories = [], lat, lng }) {
  const now = new Date()
  // 1. Pull venues for this city.
  const { rows: allVenues } = await query(
    `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng, opening_hours
     FROM venues
     WHERE city = $1 AND name IS NOT NULL
     ORDER BY (COALESCE(rating,0) * LEAST(COALESCE(rating_count,0),500)) DESC
     LIMIT 200`,
    [city]
  )
  if (!allVenues.length) return { error: 'no_venues' }

  const wantCats = new Set(categories || [])
  const kw = (text || '').toLowerCase()

  // Score each venue for relevance to what the user ACTUALLY asked for.
  const scored = allVenues.map(v => {
    let score = 0
    const reasons = []
    // CATEGORY: strong signal both ways
    if (wantCats.size) {
      if (wantCats.has(v.category_slug)) { score += 60; reasons.push('matches what you asked for') }
      else { score -= 40 }   // strong penalty for wrong category — keeps the plan on-topic
    }
    // KEYWORD: venue name contains a word from the request (e.g. "burger" → "Burger & Beyond")
    const nameWords = (v.name || '').toLowerCase()
    const reqWords = kw.match(/[a-z]{4,}/g) || []
    const stop = new Set(['some','good','want','place','night','nice','really','something','tonight','today','with','near','from','that','this','plan'])
    for (const w of reqWords) { if (!stop.has(w) && nameWords.includes(w)) { score += 25; reasons.push('name fits the request') } }
    // QUALITY
    score += Math.min((v.rating || 0) * 3, 15)
    score += Math.min((v.rating_count || 0) / 250, 5)
    // BUDGET
    if (budget?.budget_level === 'cheap') {
      if (v.price_level && v.price_level <= 2) { score += 10; reasons.push('budget-friendly') }
      else if (v.price_level >= 3) score -= 12
    }
    if (budget?.budget_level === 'premium' && v.price_level >= 3) { score += 8; reasons.push('upmarket') }
    // DISTANCE
    if (lat != null && lng != null && v.lat != null) {
      const d = haversineKm(lat, lng, v.lat, v.lng)
      if (d <= 1.5) { score += 10; reasons.push('close by') }
      else if (d <= 4) score += 5
      else if (d > 12) score -= 10
    }
    // small jitter for variety among near-ties (much smaller than before)
    score += Math.random() * 3
    return { ...v, _score: score, _reasons: reasons }
  }).sort((a, b) => b._score - a._score)

  // Hard gate: unknown or closed venues never reach Gemini's shortlist.
  const timeEligible = filterCandidatesForPlan(scored, { city, stops, startAt: now })

  // If the user asked for specific categories, DROP anything that doesn't match
  // (so a "burgers" request can't return a cocktail bar). Keep a small relevant set.
  let relevant = timeEligible
  if (wantCats.size) {
    const matching = timeEligible.filter(v => wantCats.has(v.category_slug))
    // use matches if we have a reasonable number; otherwise fall back to top scored
    relevant = matching.length >= stops ? matching : timeEligible.filter(v => v._score > 0)
  }

  // Hand Gemini a TIGHT, relevant shortlist (not 60 random venues).
  const venues = relevant.slice(0, 24)
  if (!venues.length) {
    return { error: 'no_open_venues', message: `Most suitable places in ${city} are closed for the planned visit window. Try a later time, a wider area, or ask for bars and dessert spots.` }
  }


  // 2. Pull a few upcoming events too
  const { rows: events } = await query(
    `SELECT e.id, e.name, e.starts_at, e.is_free, e.min_price, v.name AS venue_name, e.venue_id
     FROM events e JOIN venues v ON v.id = e.venue_id
     WHERE v.city = $1 AND e.status='active' AND e.starts_at >= now()
     ORDER BY e.starts_at ASC LIMIT 20`,
    [city]
  )

  // 3. Build the prompt
  // Precompute busy estimates for each venue (legal heuristics)
  const busyByVenue = {}
  for (const v of venues) busyByVenue[v.id] = estimateBusy(v, { when: now, events })

  const venueList = venues.map(v => {
    const b = busyByVenue[v.id]
    return `${v.id}|${v.name}|${v.category_slug}|rating:${v.rating || '?'}|price:${v.price_level ?? '?'}|busy:${b.level}`
  }).join('\n')
  const eventList = events.map(e =>
    `${e.id}|${e.name}|@${e.venue_name}|${new Date(e.starts_at).toLocaleString()}|${e.is_free ? 'free' : '£' + (e.min_price || '?')}`
  ).join('\n')

  const intent = text?.trim()
    ? `The user said: "${text.trim()}"`
    : mode
      ? `The user wants ${MODE_HINTS[mode] || mode}.`
      : vibe
        ? `The user wants a ${vibe} night.`
        : 'The user wants a fun night out.'

  // Tell the AI which venue categories the user actually asked for
  let catBlock = ''
  if (categories && categories.length) {
    const labels = { restaurant: 'food/restaurants', cafe: 'cafés', bar: 'bars/cocktails', pub: 'pubs', nightclub: 'clubs', music_venue: 'live music/karaoke', comedy: 'comedy' }
    catBlock = `\nThe user specifically wants: ${categories.map(c => labels[c] || c).join(', ')}. Make sure the plan includes these where possible.`
  }

  // Weather guidance — silently bias the plan based on conditions
  let weatherBlock = ''
  if (weather?.planningHint) {
    const h = weather.planningHint
    if (h.mode === 'indoor') {
      weatherBlock = `\nWEATHER: ${h.temp}°C, ${h.condition}. Because of the weather, PREFER indoor venues — pubs, restaurants, bars, covered markets, museums, live music venues. Avoid parks, viewpoints, beer gardens and exposed outdoor spots.`
    } else if (h.mode === 'outdoor') {
      weatherBlock = `\nWEATHER: ${h.temp}°C, ${h.condition}. The weather is lovely — feel free to include outdoor spots like parks, viewpoints, beer gardens or outdoor food markets where they fit.`
    } else {
      weatherBlock = `\nWEATHER: ${h.temp}°C, ${h.condition}. Mix indoor and outdoor as suits the night.`
    }
  }

  // Budget guidance
  const bg = budgetGuidance(budget || {})
  const budgetBlock = bg.text ? `\nBUDGET: ${bg.text}` : ''

  // If budget-conscious, surface active offers so the AI can prefer them
  let offersBlock = ''
  if (budget?.budget_level === 'cheap' || budget?.budget_per_person) {
    try {
      const { rows: offers } = await query(
        `SELECT o.venue_id, o.title, o.estimated_value FROM offers o JOIN venues v ON v.id=o.venue_id
         WHERE v.city=$1 AND o.active=TRUE AND (o.ends_at IS NULL OR o.ends_at>=now()) LIMIT 30`, [city]
      )
      if (offers.length) {
        offersBlock = `\nACTIVE OFFERS (prefer these venues to save money): ` +
          offers.map(o => `venue ${o.venue_id}: ${o.title}${o.estimated_value ? ' (' + o.estimated_value + ')' : ''}`).join('; ')
      }
    } catch (e) { /* offers optional */ }
  }

  // Busy preference guidance
  let busyBlock = ''
  if (busyPref === 'avoid') busyBlock = `\nCROWDS: The user wants to AVOID packed places. Prefer venues marked busy:quiet or busy:moderate. Avoid busy:very_busy unless there's a strong reason.`
  else if (busyPref === 'lively') busyBlock = `\nCROWDS: The user wants somewhere LIVELY. Lean towards busy:busy or busy:very_busy venues with energy.`

  const prompt = `You are Sappo, an AI that plans real nights out in ${city}.
${intent}${catBlock}${weatherBlock}${budgetBlock}${offersBlock}${busyBlock}

Build a ${stops}-stop night itinerary using ONLY venues from this list (use their exact id).
Each venue line shows: id|name|category|rating|price(1-4, ?=unknown)|busy(quiet/moderate/busy/very_busy).
VENUES:
${venueList}

UPCOMING EVENTS (optional to include, use exact id):
${eventList || '(none)'}

Respond with JSON only in this exact shape:
{
  "title": "short catchy name for the night",
  "vibe": "one-line description of the vibe",
  "stops": [
    { "venueId": "<id from list>", "order": 1, "label": "First stop", "why": "one short sentence why this place fits" }
  ],
  "reasoning": "one or two sentences explaining your choices like a concierge would, e.g. mention budget kept low, avoided busy spots, included a free stop",
  "tip": "one short insider tip for the night"
}
Rules: pick ${stops} stops, order them as a sensible night progression (e.g. food/drinks first, livelier later). Only use venueIds that appear in the list. Respect the budget and crowd preferences above. Keep text punchy and fun. Try to keep consecutive stops reasonably close together so people aren't crossing the whole city between each one.`

  // 4. Ask Gemini
  const ai = await generateJSON(prompt, { temperature: mode === 'chaos' ? 1.0 : 0.9 })
  if (!ai || !ai.stops) {
    logger.warn('Gemini returned no plan; using fallback')
    return safeFallbackPlan(city, venues, vibe || mode, { startAt: now, origin: lat != null && lng != null ? { lat, lng } : null })
  }

  // 5. Map venueIds back to real venue records (guard hallucinated AND duplicate ids)
  const byId = Object.fromEntries(venues.map(v => [String(v.id), v]))
  const eventByVenue = {}
  for (const e of events) { if (!eventByVenue[e.venue_id]) eventByVenue[e.venue_id] = e }

  const usedIds = new Set()
  const buildStop = (v, order, label, why) => {
    const busy = busyByVenue[v.id] || estimateBusy(v, { when: now, events })
    const ev = eventByVenue[v.id]
    return {
      ...v, order, label, why,
      busy,
      eventPrice: ev && !ev.is_free ? (ev.min_price || null) : (ev?.is_free ? 0 : null),
    }
  }

  const stopsOut = []
  for (const s of (ai.stops || [])) {
    const v = byId[String(s.venueId)]
    if (!v) continue                          // hallucinated id
    if (usedIds.has(String(v.id))) continue   // DUPLICATE — skip (was the Blackstock×2 bug)
    usedIds.add(String(v.id))
    stopsOut.push(buildStop(v, stopsOut.length + 1, s.label, s.why))
  }
  // Backfill with DISTINCT venues if we ended up short.
  if (stopsOut.length < stops) {
    for (const v of venues) {
      if (stopsOut.length >= stops) break
      if (usedIds.has(String(v.id))) continue
      usedIds.add(String(v.id))
      stopsOut.push(buildStop(v, stopsOut.length + 1, stopsOut.length === 0 ? 'First up' : 'Then', 'A solid pick for what you asked for.'))
    }
  }

  if (!stopsOut.length) return safeFallbackPlan(city, venues, vibe || mode, { startAt: now, origin: lat != null && lng != null ? { lat, lng } : null })

  // Gemini's order is only a draft. Validate the full sequence at each stop's
  // estimated arrival and replace anything that closes before the visit ends.
  const timeSafeStops = []
  const timeSafeIds = new Set()
  for (const candidate of [...stopsOut, ...venues]) {
    if (!candidate || timeSafeIds.has(String(candidate.id))) continue
    const proposed = { ...candidate, order: timeSafeStops.length + 1 }
    const schedule = estimateItinerarySchedule([...timeSafeStops, proposed], { startAt: now, origin: lat != null && lng != null ? { lat, lng } : null, city })
    if (!schedule[schedule.length - 1].availability.eligible || !isTimeAppropriate(proposed, new Date(schedule[schedule.length - 1].estimatedArrivalAt), { city })) continue
    timeSafeStops.push(proposed)
    timeSafeIds.add(String(candidate.id))
    if (timeSafeStops.length >= stops) break
  }
  stopsOut.splice(0, stopsOut.length, ...timeSafeStops)
  if (!stopsOut.length) return { error: 'no_open_venues', message: `Most suitable places in ${city} are closed for the planned visit window.` }

  const scheduledStops = estimateItinerarySchedule(stopsOut, { startAt: now, origin: lat != null && lng != null ? { lat, lng } : null, city })
  for (let i = 0; i < stopsOut.length; i++) {
    stopsOut[i].arrival = { ...scheduledStops[i].availability, estimatedArrivalAt: scheduledStops[i].estimatedArrivalAt, estimatedArrivalTime: scheduledStops[i].estimatedArrivalTime, transportMode: 'walking' }
    Object.assign(stopsOut[i], apiHours(stopsOut[i].opening_hours, { city }))
  }

  // Compute travel time between consecutive stops (best-effort; null if no key).
  const legs = []
  for (let i = 0; i < stopsOut.length - 1; i++) {
    const from = stopsOut[i], to = stopsOut[i + 1]
    let leg = null
    try {
      const t = await getTravel({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
      if (t) leg = t
    } catch (e) { /* ignore, leave null */ }
    legs.push(leg)
    stopsOut[i].travelToNext = leg
  }

  // "Getting home" — if the user gave a home location, compute the journey from the last stop.
  let gettingHome = null
  if (home?.lat != null && home?.lng != null && stopsOut.length) {
    const last = stopsOut[stopsOut.length - 1]
    try {
      const t = await getTravel({ lat: last.lat, lng: last.lng }, { lat: home.lat, lng: home.lng })
      if (t) gettingHome = { from: last.name, travel: t, homeLabel: home.label || 'home' }
    } catch (e) { /* ignore */ }
  }

  // Estimate per-person cost (transport: rough taxi share if legs exist)
  let transportPerPerson = 0
  for (const leg of legs) {
    if (leg?.driving?.distanceMeters) {
      // very rough UK taxi: £3 base + £1.50/km, split 2 ways
      transportPerPerson += (3 + (leg.driving.distanceMeters / 1000) * 1.5) / 2
    }
  }
  const cost = estimatePlanCost(stopsOut, { transportPerPerson: Math.round(transportPerPerson) })

  // Human-readable travel summary — so the plan can TALK about getting around,
  // not just carry silent leg data. Uses the primary mode of each leg.
  const travelSummary = buildTravelSummary(stopsOut, gettingHome)

  return {
    title: ai.title || 'Your night out',
    vibe: ai.vibe || '',
    tip: ai.tip || '',
    reasoning: ai.reasoning || null,
    cost,
    stops: stopsOut,
    travelSummary,
    weatherNote: weather?.planningHint?.note ? `Weather considered: ${weather.planningHint.note}.` : null,
    gettingHome,
    source: 'ai',
  }
}

// Turn the computed legs into one short, natural sentence about getting around.
// e.g. "It's a short walk between the first two, then about a 12-min taxi to
// the last — and roughly 20 mins home." Rail legs are called out as trains.
function buildTravelSummary(stops, gettingHome) {
  const legs = stops.map(s => s.travelToNext).filter(Boolean)
  if (!legs.length && !gettingHome) return null

  const phraseFor = (leg) => {
    if (!leg) return null
    const mode = leg.primary || 'driving'
    const info = leg[mode]
    if (!info) return null
    const t = info.durationText || null
    if (mode === 'walking') return t ? `a ${t} walk` : 'a short walk'
    if (mode === 'cycling') return t ? `a ${t} cycle` : 'a short cycle'
    if (mode === 'transit') {
      const rail = info.looksLikeRail
      return t ? `about ${t} by ${rail ? 'train' : 'public transport'}` : (rail ? 'a short train hop' : 'a short transit ride')
    }
    return t ? `about a ${t} taxi` : 'a short taxi'
  }

  const parts = legs.map(phraseFor).filter(Boolean)
  let sentence = ''
  if (parts.length === 1) sentence = `Getting between them is ${parts[0]}.`
  else if (parts.length === 2) sentence = `It's ${parts[0]} to the second stop, then ${parts[1]} to the last.`
  else if (parts.length > 2) sentence = `Hops between stops: ${parts.join(', then ')}.`

  if (gettingHome?.travel) {
    const homePhrase = phraseFor(gettingHome.travel)
    if (homePhrase) sentence += `${sentence ? ' ' : ''}Then ${homePhrase} back to ${gettingHome.homeLabel || 'home'}.`
  }
  return sentence || null
}

// Deterministic fallback if Gemini is unavailable
function fallbackPlan(city, venues, vibe) {
  const pick = (cats) => venues.find(v => cats.includes(v.category_slug))
  const stops = []
  const a = pick(['cafe', 'pub']); if (a) stops.push({ ...a, order: 1, label: 'First stop', why: 'A solid place to start.' })
  const b = pick(['restaurant', 'bar']); if (b) stops.push({ ...b, order: 2, label: 'Dinner & drinks', why: 'Great food and atmosphere.' })
  const c = pick(['nightclub', 'music_venue', 'bar']); if (c) stops.push({ ...c, order: 3, label: 'Night out', why: 'End the night with energy.' })
  return { title: `A night in ${city}`, vibe: vibe || 'A classic night out', tip: 'Arrive early to beat the queues.', stops, source: 'fallback' }
}

function safeFallbackPlan(city, venues, vibe, { startAt, origin } = {}) {
  const draft = fallbackPlan(city, venues, vibe)
  const safe = []
  for (const candidate of draft.stops) {
    const schedule = estimateItinerarySchedule([...safe, candidate], { startAt: startAt || new Date(), origin: origin || null, city })
    if (schedule[schedule.length - 1].availability.eligible && isTimeAppropriate(candidate, new Date(schedule[schedule.length - 1].estimatedArrivalAt), { city })) safe.push(candidate)
  }
  draft.stops = safe.map((stop, index) => {
    const schedule = estimateItinerarySchedule(safe.slice(0, index + 1), { startAt: startAt || new Date(), origin: origin || null, city })
    const current = schedule[schedule.length - 1]
    return { ...stop, ...apiHours(stop.opening_hours, { city }), arrival: { ...current.availability, estimatedArrivalAt: current.estimatedArrivalAt, estimatedArrivalTime: current.estimatedArrivalTime, transportMode: 'walking' } }
  })
  return draft
}

module.exports = { planNight, MODE_HINTS }

function haversineKm(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a))*Math.cos(r(c))*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}
