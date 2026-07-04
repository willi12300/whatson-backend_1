// src/services/searchSuggestions.js
// Stage 3 of unified search: when the search bar is EMPTY, show contextual
// suggestion chips based on weather + time of day + local events + location.
// Each chip is just a label + a query string that feeds back into smart-search
// when tapped — so the whole thing stays one simple search experience.
//
// Everything is DB/first-party: weather from the weather client, time from
// timeContext, event availability from the DB. No per-suggestion API calls.

const { getTimeContext } = require('./timeContext')
const { query } = require('../db/pool')
const logger = require('../utils/logger')

// A chip: { label, query, icon }. `query` is what gets sent to smart-search.
function chip(label, q, icon) { return { label, query: q, icon: icon || null } }

// Does the city have upcoming events (so "live music tonight" isn't a dead end)?
async function cityHasEvents(city) {
  if (!city) return false
  try {
    const { rows } = await query(
      `SELECT 1 FROM events e JOIN venues v ON v.id = e.venue_id
        WHERE v.city = $1 AND e.status='active' AND e.starts_at >= now()
          AND e.starts_at <= now() + interval '3 days' LIMIT 1`,
      [city]
    )
    return rows.length > 0
  } catch (e) { logger.warn('[suggestions] event check failed: ' + e.message); return false }
}

// Build contextual suggestion chips. ctx: { city, lat, lng, weather, date }.
// weather is optional (pass the already-fetched object to avoid a second call).
async function buildSuggestions(ctx = {}) {
  const { city = null, lat = null, lng = null, weather = null } = ctx
  const now = ctx.date || new Date()

  // Time + daylight context (reuses the astronomical model).
  const tz = (lng != null) ? Math.round(lng / 15) : undefined
  const time = getTimeContext(now, lat ?? 53.4, lng ?? -2.98, tz)
  const day = now.getDay()            // 0 Sun … 6 Sat
  const isWeekend = day === 5 || day === 6 || day === 0
  const isFriday = day === 5

  // Weather read (optional).
  const temp = weather?.current?.temp ?? null
  const cond = (weather?.current?.condition || '').toLowerCase()
  const isWet = weather?.planningHint?.mode === 'indoor' ||
    (Array.isArray(weather?.hourly) && weather.hourly.slice(0, 4).some(h => h.indoor || (h.rainChance != null && h.rainChance >= 50)))
  const isWarmClear = typeof temp === 'number' && temp >= 18 && /clear|sun|fair/.test(cond)
  const isCold = typeof temp === 'number' && temp <= 7

  const chips = []
  const hasEvents = await cityHasEvents(city)

  // ── Weather-led (strongest signal) ──
  if (isWet) {
    chips.push(chip('Cosy cafés', 'cosy cafes', '☕'))
    chips.push(chip('Museums & galleries', 'museums', '🏛'))
    chips.push(chip('Indoor things to do', 'things to do', '🌂'))
  } else if (isWarmClear) {
    chips.push(chip('Parks & gardens', 'parks', '🌳'))
    chips.push(chip('Beer gardens', 'beer gardens', '🍺'))
    chips.push(chip('Walking routes', 'walks', '🚶'))
  } else if (isCold) {
    chips.push(chip('Cosy pubs', 'cosy pubs', '🔥'))
    chips.push(chip('Warm cafés', 'cafes', '☕'))
  }

  // ── Time-of-day led ──
  if (time.eveningness >= 0.6) {
    // Evening / night
    if (hasEvents) chips.push(chip('Live music tonight', 'live music tonight', '🎵'))
    chips.push(chip('Rooftop bars', 'rooftop bars', '🍸'))
    if (isFriday || isWeekend) chips.push(chip('Date night ideas', 'date night', '❤️'))
    chips.push(chip('Cocktail bars', 'cocktails', '🍹'))
  } else if (time.daypart === 'morning') {
    chips.push(chip('Breakfast & brunch', 'brunch', '🥐'))
    chips.push(chip('Great coffee', 'coffee', '☕'))
  } else {
    // Daytime / afternoon
    chips.push(chip('Lunch spots', 'lunch', '🍽'))
    if (!isWet) chips.push(chip('Things to do nearby', 'things to do', '✨'))
    chips.push(chip('Hidden gems', 'hidden gems', '💎'))
  }

  // ── Weekend / event flavour ──
  if (isWeekend && hasEvents && !chips.some(c => c.query.includes('live music'))) {
    chips.push(chip("What's on this weekend", 'whats on', '📅'))
  }

  // De-dupe by query, cap at a tidy number for the UI.
  const seen = new Set()
  const deduped = []
  for (const c of chips) {
    if (seen.has(c.query)) continue
    seen.add(c.query)
    deduped.push(c)
    if (deduped.length >= 6) break
  }

  return {
    context: {
      daypart: time.daypart,
      eveningness: Math.round(time.eveningness * 100) / 100,
      weather: temp != null ? { temp, condition: weather?.current?.condition || null, wet: isWet } : null,
      isWeekend,
    },
    suggestions: deduped,
  }
}

module.exports = { buildSuggestions }
