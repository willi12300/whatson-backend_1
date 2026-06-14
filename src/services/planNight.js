// src/services/planNight.js
// Builds an AI night plan: pull real venues/events for the city, give Gemini a
// shortlist, let it compose a themed itinerary that ONLY references real places.

const { query } = require('../db/pool')
const { generateJSON } = require('../clients/gemini')
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

async function planNight({ city, vibe, mode, text, stops = 3, weather }) {
  // 1. Pull a shortlist of real venues for the city (cap to keep prompt small)
  const { rows: venues } = await query(
    `SELECT id, name, category_slug, rating, price_level, address
     FROM venues
     WHERE city = $1 AND name IS NOT NULL
     ORDER BY (COALESCE(rating,0) * LEAST(COALESCE(rating_count,0),500)) DESC
     LIMIT 60`,
    [city]
  )
  if (!venues.length) return { error: 'no_venues' }

  // 2. Pull a few upcoming events too
  const { rows: events } = await query(
    `SELECT e.id, e.name, e.starts_at, e.is_free, e.min_price, v.name AS venue_name
     FROM events e JOIN venues v ON v.id = e.venue_id
     WHERE v.city = $1 AND e.status='active' AND e.starts_at >= now()
     ORDER BY e.starts_at ASC LIMIT 20`,
    [city]
  )

  // 3. Build the prompt
  const venueList = venues.map(v =>
    `${v.id}|${v.name}|${v.category_slug}|rating:${v.rating || '?'}|price:${v.price_level ?? '?'}`
  ).join('\n')
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

  const prompt = `You are Sappo, an AI that plans real nights out in ${city}.
${intent}${weatherBlock}

Build a ${stops}-stop night itinerary using ONLY venues from this list (use their exact id):
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
  "tip": "one short insider tip for the night"
}
Rules: pick ${stops} stops, order them as a sensible night progression (e.g. food/drinks first, livelier later). Only use venueIds that appear in the list. Keep text punchy and fun.`

  // 4. Ask Gemini
  const ai = await generateJSON(prompt, { temperature: mode === 'chaos' ? 1.0 : 0.9 })
  if (!ai || !ai.stops) {
    logger.warn('Gemini returned no plan; using fallback')
    return fallbackPlan(city, venues, vibe || mode)
  }

  // 5. Map venueIds back to real venue records (guard against hallucinated ids)
  const byId = Object.fromEntries(venues.map(v => [String(v.id), v]))
  const stopsOut = (ai.stops || [])
    .map(s => {
      const v = byId[String(s.venueId)]
      if (!v) return null
      return { ...v, order: s.order, label: s.label, why: s.why }
    })
    .filter(Boolean)

  if (!stopsOut.length) return fallbackPlan(city, venues, vibe || mode)

  return {
    title: ai.title || 'Your night out',
    vibe: ai.vibe || '',
    tip: ai.tip || '',
    stops: stopsOut,
    weatherNote: weather?.planningHint?.note ? `Weather considered: ${weather.planningHint.note}.` : null,
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
