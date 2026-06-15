// src/services/planNight.js
// Builds an AI night plan: pull real venues/events for the city, give Gemini a
// shortlist, let it compose a themed itinerary that ONLY references real places.

const { query } = require('../db/pool')
const { generateJSON } = require('../clients/gemini')
const { travelBetween } = require('../clients/routes')
const { estimatePlanCost, budgetGuidance } = require('./costEstimate')
const { estimateBusy } = require('./busyEstimate')
const logger = require('../utils/logger')

// Surprise-me mode flavour text fed into the prompt
const MODE_HINTS = {
  chilled:   'a relaxed, low-key evening — cosy pubs, cafés, calm bars',
  chaos:     'a high-energy, wild night out — busy bars, clubs, live music, dancing',
  cheap:     'a budget-friendly night — cheap eats, happy hours, free entry where possible',
  date_night:'a romantic date night — nice restaurant, intimate bar, something memorable',
  hidden_gems:'off-the-beaten-path local favourites that tourists would miss',
  stag_hen:  'a big group celebration — lively bars, group-friendly spots, party atmosphere',
}

async function planNight({ city, vibe, mode, text, stops = 3, weather, home, budget, busyPref, categories = [], lat, lng }) {
  // 1. Pull venues for this city.
  const { rows: allVenues } = await query(
    `SELECT id, name, category_slug, rating, rating_count, price_level, address, lat, lng
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

  // If the user asked for specific categories, DROP anything that doesn't match
  // (so a "burgers" request can't return a cocktail bar). Keep a small relevant set.
  let relevant = scored
  if (wantCats.size) {
    const matching = scored.filter(v => wantCats.has(v.category_slug))
    // use matches if we have a reasonable number; otherwise fall back to top scored
    relevant = matching.length >= stops ? matching : scored.filter(v => v._score > 0)
  }

  // Hand Gemini a TIGHT, relevant shortlist (not 60 random venues).
  const venues = relevant.slice(0, 24)


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
  const now = new Date()
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
    return fallbackPlan(city, venues, vibe || mode)
  }

  // 5. Map venueIds back to real venue records (guard against hallucinated ids)
  const byId = Object.fromEntries(venues.map(v => [String(v.id), v]))
  const eventByVenue = {}
  for (const e of events) { if (!eventByVenue[e.venue_id]) eventByVenue[e.venue_id] = e }
  const stopsOut = (ai.stops || [])
    .map(s => {
      const v = byId[String(s.venueId)]
      if (!v) return null
      const busy = busyByVenue[v.id] || estimateBusy(v, { when: now, events })
      const ev = eventByVenue[v.id]
      return {
        ...v, order: s.order, label: s.label, why: s.why,
        busy,
        eventPrice: ev && !ev.is_free ? (ev.min_price || null) : (ev?.is_free ? 0 : null),
      }
    })
    .filter(Boolean)

  if (!stopsOut.length) return fallbackPlan(city, venues, vibe || mode)

  // Compute travel time between consecutive stops (best-effort; null if no key).
  const legs = []
  for (let i = 0; i < stopsOut.length - 1; i++) {
    const from = stopsOut[i], to = stopsOut[i + 1]
    let leg = null
    try {
      const t = await travelBetween({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng })
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
      const t = await travelBetween({ lat: last.lat, lng: last.lng }, { lat: home.lat, lng: home.lng })
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

  return {
    title: ai.title || 'Your night out',
    vibe: ai.vibe || '',
    tip: ai.tip || '',
    reasoning: ai.reasoning || null,
    cost,
    stops: stopsOut,
    weatherNote: weather?.planningHint?.note ? `Weather considered: ${weather.planningHint.note}.` : null,
    gettingHome,
    source: 'ai',
  }
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

module.exports = { planNight, MODE_HINTS }

function haversineKm(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a))*Math.cos(r(c))*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}
