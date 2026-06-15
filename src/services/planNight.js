// src/services/planNight.js
// Builds an AI night plan: pull real venues/events for the city, give Gemini a
// shortlist, let it compose a themed itinerary that ONLY references real places.

const { query } = require('../db/pool')
const { generateJSON } = require('../clients/gemini')
const { scoreVenues, pickVaried } = require('./scoreVenues')
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

async function planNight({ city, vibe, mode, text, stops = 3, weather, home, budget, busyPref, categories = [], lat, lng, recentlyShownIds = [], debug = false }) {
  // 1. Fetch VERIFIED candidates for THIS CITY only (full fields for scoring).
  const { rows: allVenues } = await query(
    `SELECT id, name, category_slug, rating, rating_count, price_level, price_range,
            address, lat, lng, opening_hours, website, menu_url
     FROM venues
     WHERE city = $1 AND name IS NOT NULL
     ORDER BY (COALESCE(rating,0) * LEAST(COALESCE(rating_count,0),500)) DESC
     LIMIT 250`,
    [city]
  )
  if (!allVenues.length) return { error: 'no_venues' }

  // 2. Pull upcoming events (also city-scoped)
  const { rows: events } = await query(
    `SELECT e.id, e.name, e.starts_at, e.is_free, e.min_price, v.name AS venue_name, e.venue_id
     FROM events e JOIN venues v ON v.id = e.venue_id
     WHERE v.city = $1 AND e.status='active' AND e.starts_at >= now()
     ORDER BY e.starts_at ASC LIMIT 30`,
    [city]
  )

  // 3. SCORE + FILTER via the recommendation engine (backend decides, not Gemini).
  const now = new Date()
  const intentForScore = {
    categories, vibe: vibe || mode, budget: budget?.budget_level,
    budgetPerPerson: budget?.budget_per_person, busyPref, raw: text,
  }
  const { ranked, debug: scoreDebug } = scoreVenues(allVenues, intentForScore, {
    lat, lng, when: now, weather, events, recentlyShownIds: new Set(recentlyShownIds),
  })

  if (!ranked.length) return { error: 'no_matches', debug: debug ? scoreDebug : undefined }

  // 4. Pick a VARIED shortlist from the top matches (not always the same top N).
  const shortlist = pickVaried(ranked, 12)
  const venues = shortlist.map(s => s.venue)
  const reasonsById = Object.fromEntries(shortlist.map(s => [String(s.venue.id), s.reasons]))
  const scoreById = Object.fromEntries(shortlist.map(s => [String(s.venue.id), s.score]))
  const busyByVenue = {}
  for (const s of shortlist) busyByVenue[s.venue.id] = s.venue._busy || estimateBusy(s.venue, { when: now, events })

  // 5. Build the prompt — Gemini ONLY sees these verified, pre-scored candidates.
  const venueList = venues.map(v => {
    const b = busyByVenue[v.id]
    const dist = v._dist != null ? `${v._dist.toFixed(1)}km` : '?'
    const why = (reasonsById[String(v.id)] || []).join(', ')
    return `${v.id}|${v.name}|${v.category_slug}|rating:${v.rating || '?'}|price:${v.price_level ?? '?'}|busy:${b?.level || '?'}|${dist}|score:${scoreById[String(v.id)]}|reasons:${why}`
  }).join('\n')
  const eventList = events.slice(0, 15).map(e =>
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

  const prompt = `You are Sappo — a warm, switched-on local mate who plans real days and nights out in ${city}. You talk like a real person texting a friend: natural, a bit of personality, never corporate.
${intent}${catBlock}${weatherBlock}${budgetBlock}${offersBlock}${busyBlock}

CRITICAL: These are the ONLY venues you may use. They have already been verified, filtered to ${city}, and scored for THIS user's request. Do NOT invent venues or use any from memory. Pick the best ${stops} for a coherent outing using their exact id. Each line is:
id|name|category|rating|price(1-4)|busy|distance|score|reasons
(higher score = better match for this user. The reasons tell you WHY it fits.)
VENUES:
${venueList}

UPCOMING EVENTS (optional, use exact id):
${eventList || '(none)'}

Respond with JSON only in this exact shape:
{
  "title": "short catchy name for the outing",
  "vibe": "one short line in your natural voice on what kind of outing this is",
  "stops": [
    { "venueId": "<id from list>", "order": 1, "label": "First up", "why": "one short, specific, human reason this place fits what they asked for — draw on the reasons given" }
  ],
  "reasoning": "one or two sentences like a mate explaining the plan — mention the real things you balanced (budget, weather, kept it chilled, avoided busy spots). Specific, not generic.",
  "tip": "one genuinely useful insider tip"
}
Rules: pick exactly ${stops} stops from the list, ordered as a sensible progression (food/drinks first, livelier later). ONLY use venueIds that appear above — never anything else. Prefer higher-scored venues but build a coherent route. Respect budget and crowd preferences. Every bit of text must sound like a real warm person, never marketing copy. Keep consecutive stops reasonably close.`

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
      // build a concrete "why chosen" — Gemini's reason, backed by the engine's facts
      const engineReasons = reasonsById[String(v.id)] || []
      const why = s.why && s.why.length > 8 ? s.why : (engineReasons.length ? `Chosen because it ${engineReasons.slice(0, 3).join(', ')}.` : 'A solid match for what you asked for.')
      return {
        ...v, order: s.order, label: s.label, why,
        whyFactors: engineReasons,
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
    shownVenueIds: stopsOut.map(s => s.id),   // so the caller can avoid repeats next time
    debug: debug ? { intent: intentForScore, city, ...scoreDebug, shortlistSize: venues.length } : undefined,
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
