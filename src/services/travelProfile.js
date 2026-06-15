// src/services/travelProfile.js
// The Sappo traveller personality system: stores archetype scores per user/device,
// updates them from action signals, and derives a friendly "Sappo Style" label.

const { query } = require('../db/pool')
const logger = require('../utils/logger')

const ARCHETYPES = [
  { key: 'explorer',   col: 'explorer_score',   label: 'Explorer' },
  { key: 'foodie',     col: 'foodie_score',     label: 'Foodie' },
  { key: 'night_owl',  col: 'night_owl_score',  label: 'Night Owl' },
  { key: 'culture',    col: 'culture_score',    label: 'Culture Seeker' },
  { key: 'nature',     col: 'nature_score',     label: 'Nature Lover' },
  { key: 'chill',      col: 'chill_score',      label: 'Chill Seeker' },
  { key: 'adventurer', col: 'adventurer_score', label: 'Adventurer' },
  { key: 'romantic',   col: 'romantic_score',   label: 'Romantic' },
  { key: 'family',     col: 'family_score',     label: 'Family Friendly' },
  { key: 'budget',     col: 'budget_score',     label: 'Budget Hunter' },
]
const SCORE_COLS = ARCHETYPES.map(a => a.col)
const TOLERANCE_COLS = ['walking_tolerance', 'crowd_tolerance', 'price_sensitivity']

// Signal definitions: action → score/tolerance deltas.
const SIGNALS = {
  save_restaurant:        { foodie: 3 },
  complete_food_trail:    { foodie: 10 },
  save_hidden_gem:        { explorer: 5 },
  complete_history_trail: { culture: 10 },
  checkin_nightlife:      { night_owl: 5 },
  choose_scenic:          { nature: 5 },
  save_attraction:        { explorer: 3, culture: 2 },
  save_museum:            { culture: 4 },
  save_park:              { nature: 4 },
  complete_plan:          { explorer: 2 },
  // feedback signals
  feedback_loved:         { /* reinforced dynamically from plan categories */ },
  feedback_too_expensive: { budget: 8, _tol: { price_sensitivity: 5 } },
  feedback_too_much_walking: { _tol: { walking_tolerance: -5 } },
  feedback_too_busy:      { _tol: { crowd_tolerance: -5 } },
  feedback_too_far:       { _tol: { walking_tolerance: -3 } },
  date_night:             { romantic: 4 },
  family_plan:            { family: 4 },
  budget_request:         { budget: 3 },
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

// Get a profile (creating one if needed). key = { userId } or { deviceId }.
async function getProfile({ userId, deviceId }) {
  if (!userId && !deviceId) return null
  let row
  if (userId) {
    const r = await query('SELECT * FROM user_travel_profile WHERE user_id=$1', [userId])
    row = r.rows[0]
    if (!row) {
      const ins = await query('INSERT INTO user_travel_profile (user_id) VALUES ($1) RETURNING *', [userId])
      row = ins.rows[0]
    }
  } else {
    const r = await query('SELECT * FROM user_travel_profile WHERE device_id=$1 AND user_id IS NULL', [deviceId])
    row = r.rows[0]
    if (!row) {
      const ins = await query('INSERT INTO user_travel_profile (device_id) VALUES ($1) RETURNING *', [deviceId])
      row = ins.rows[0]
    }
  }
  return row
}

// Apply a named signal (optionally with plan categories for feedback reinforcement).
async function applySignal({ userId, deviceId }, signalName, { categories = [] } = {}) {
  const def = SIGNALS[signalName]
  if (!def) { logger.warn('[profile] unknown signal: ' + signalName); return null }
  const profile = await getProfile({ userId, deviceId })
  if (!profile) return null

  const scoreDeltas = {}
  const tolDeltas = {}
  for (const [k, v] of Object.entries(def)) {
    if (k === '_tol') { Object.assign(tolDeltas, v); continue }
    scoreDeltas[k] = (scoreDeltas[k] || 0) + v
  }

  // "loved it" reinforces archetypes implied by the plan's categories
  if (signalName === 'feedback_loved') {
    for (const c of categories) {
      const arche = CATEGORY_TO_ARCHETYPE[c]
      if (arche) scoreDeltas[arche] = (scoreDeltas[arche] || 0) + 3
    }
  }

  // build the UPDATE
  const sets = []
  const vals = []
  let i = 1
  for (const a of ARCHETYPES) {
    if (scoreDeltas[a.key]) { sets.push(`${a.col} = ${a.col} + $${i++}`); vals.push(scoreDeltas[a.key]) }
  }
  for (const t of TOLERANCE_COLS) {
    if (tolDeltas[t]) { sets.push(`${t} = GREATEST(0, LEAST(100, ${t} + $${i++}))`); vals.push(tolDeltas[t]) }
  }
  if (!sets.length) return profile
  sets.push('last_updated = now()')
  vals.push(profile.id)
  const out = await query(`UPDATE user_travel_profile SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals)
  return out.rows[0]
}

// Map venue categories → archetype (used for "loved it" reinforcement + planner boosts).
const CATEGORY_TO_ARCHETYPE = {
  restaurant: 'foodie', cafe: 'foodie',
  bar: 'night_owl', pub: 'night_owl', nightclub: 'night_owl', music_venue: 'night_owl',
  museum: 'culture', gallery: 'culture', landmark: 'culture',
  park: 'nature', attraction: 'explorer',
}

// Derive the friendly "Sappo Style" from a profile row.
function deriveStyle(profile) {
  if (!profile) return null
  const scored = ARCHETYPES
    .map(a => ({ ...a, score: profile[a.col] || 0 }))
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)

  if (!scored.length) {
    return { label: 'New Explorer', top: [], likes: [], avoids: [], blurb: "Sappo's still getting to know your style — plan a few days and it'll learn what you love." }
  }

  const top = scored.slice(0, 2)
  const label = top.map(t => t.label).join('-')

  // build likes/avoids from the top archetypes + tolerances
  const likesMap = {
    explorer: 'hidden gems', foodie: 'local food', night_owl: 'bars & live music',
    culture: 'history & culture', nature: 'scenic spots & nature', chill: 'relaxed vibes',
    adventurer: 'active adventures', romantic: 'romantic settings', family: 'family-friendly spots',
    budget: 'great-value finds',
  }
  const likes = top.map(t => likesMap[t.key]).filter(Boolean)
  const avoids = []
  if ((profile.budget_score || 0) >= 8 || (profile.price_sensitivity || 50) >= 65) avoids.push('expensive tourist traps')
  if ((profile.walking_tolerance || 50) <= 35) avoids.push('lots of walking')
  if ((profile.crowd_tolerance || 50) <= 35) avoids.push('busy crowds')

  return {
    label,
    top: top.map(t => ({ key: t.key, label: t.label, score: t.score })),
    likes,
    avoids,
    blurb: 'Sappo learns what kind of experiences you enjoy so it can plan better days.',
  }
}

// Produce category boosts for the planner based on the profile (small, gentle nudges).
function plannerBoosts(profile) {
  if (!profile) return { categoryBoost: {}, preferCheap: false, preferQuiet: false, preferLessWalking: false }
  const categoryBoost = {}
  const total = ARCHETYPES.reduce((s, a) => s + (profile[a.col] || 0), 0)
  if (total > 0) {
    // For each archetype with weight, boost its categories proportionally (capped).
    for (const a of ARCHETYPES) {
      const w = profile[a.col] || 0
      if (!w) continue
      const cats = ARCHETYPE_CATEGORIES[a.key] || []
      const boost = Math.min(15, Math.round((w / total) * 40))
      for (const c of cats) categoryBoost[c] = (categoryBoost[c] || 0) + boost
    }
  }
  return {
    categoryBoost,
    preferHidden: (profile.explorer_score || 0) >= 10,
    preferCheap: (profile.budget_score || 0) >= 8 || (profile.price_sensitivity || 50) >= 65,
    preferQuiet: (profile.crowd_tolerance || 50) <= 35,
    preferLessWalking: (profile.walking_tolerance || 50) <= 35,
  }
}

const ARCHETYPE_CATEGORIES = {
  explorer: ['attraction', 'landmark'],
  foodie: ['restaurant', 'cafe'],
  night_owl: ['bar', 'pub', 'nightclub', 'music_venue'],
  culture: ['museum', 'gallery', 'landmark'],
  nature: ['park', 'attraction'],
  chill: ['cafe', 'park'],
  adventurer: ['attraction'],
  romantic: ['restaurant', 'bar'],
  family: ['attraction', 'park'],
  budget: [],
}

module.exports = { getProfile, applySignal, deriveStyle, plannerBoosts, ARCHETYPES, SIGNALS, CATEGORY_TO_ARCHETYPE }
