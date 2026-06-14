// src/services/generateMission.js
// Uses Gemini to compose a real-world mission from REAL venues in the database.
// Guard: only real venue IDs make it into the saved mission (no hallucinated places).

const { query } = require('../db/pool')
const { generateJSON } = require('../clients/gemini')
const logger = require('../utils/logger')

const DURATION_HINT = {
  quick: '1-2 hours, 3 stops',
  half_day: 'half a day, 4-5 stops',
  full_day: 'a full day, 5-6 stops',
  evening: 'an evening out, 3-4 stops',
}

async function generateMission({ city, theme, duration = 'half_day', group_type, interests = [] }) {
  // 1. Pull a shortlist of real venues, biased toward the theme/interests via category
  const { rows: venues } = await query(
    `SELECT id, name, category_slug, rating, address, lat, lng
     FROM venues
     WHERE city = $1 AND name IS NOT NULL
     ORDER BY (COALESCE(rating,0) * LEAST(COALESCE(rating_count,0),500)) DESC
     LIMIT 70`,
    [city]
  )
  if (venues.length < 3) return { error: 'not_enough_data', message: `Not enough places in ${city} to build a mission yet.` }

  const venueList = venues.map(v => `${v.id}|${v.name}|${v.category_slug}|${v.address || ''}`).join('\n')
  const durHint = DURATION_HINT[duration] || duration

  const prompt = `You are Sappo, creating a real-world adventure "mission" in ${city}.
Theme: ${theme || 'general exploration'}
Group: ${group_type || 'anyone'}
Interests: ${interests.join(', ') || 'a bit of everything'}
Length: ${durHint}

Build a themed mission using ONLY venues from this list (use their exact id):
${venueList}

A mission is a guided sequence of real stops. For each stop give a fun task and an optional photo idea.

Respond with JSON only:
{
  "title": "catchy mission name",
  "description": "1-2 sentence overview of the adventure",
  "category": "e.g. music, food, history, nightlife",
  "difficulty": "easy | medium | hard",
  "estimated_duration": "human readable e.g. '3-4 hours'",
  "reward_xp": 200,
  "badge_name": "name of the badge earned (e.g. 'Beatles Explorer')",
  "stops": [
    {
      "venueId": "<id from list>",
      "order": 1,
      "task": "what to do at this stop (one fun sentence)",
      "photo_prompt": "optional photo/selfie idea, or null",
      "estimated_time": "e.g. '30 min'"
    }
  ]
}
Rules: only use venueIds from the list. Order stops as a sensible route. Make tasks fun and specific to each place. Pick a number of stops matching the length.`

  const ai = await generateJSON(prompt, { temperature: 0.85 })
  if (!ai || !ai.stops?.length) return { error: 'generation_failed', message: 'Could not generate a mission, try again.' }

  // 2. Map venueIds to real venues, drop any hallucinated ones
  const byId = Object.fromEntries(venues.map(v => [String(v.id), v]))
  const validStops = ai.stops
    .map((s, i) => {
      const v = byId[String(s.venueId)]
      if (!v) return null
      return {
        venue: v, order: s.order || i + 1,
        task: s.task || `Visit ${v.name}`,
        photo_prompt: s.photo_prompt || null,
        estimated_time: s.estimated_time || null,
      }
    })
    .filter(Boolean)

  if (validStops.length < 2) return { error: 'not_enough_data', message: 'Not enough real places matched to build this mission.' }

  // 3. Persist mission + stops
  const badgeKey = (ai.badge_name || ai.title || 'explorer').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)
  const m = await query(
    `INSERT INTO missions (city, title, description, category, theme, difficulty, estimated_duration, reward_xp, badge_name, badge_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [city, ai.title, ai.description || null, ai.category || null, theme || null,
     ai.difficulty || 'easy', ai.estimated_duration || durHint, ai.reward_xp || 200,
     ai.badge_name || 'Explorer', badgeKey]
  )
  const missionId = m.rows[0].id

  for (const s of validStops) {
    await query(
      `INSERT INTO mission_stops (mission_id, venue_id, stop_order, title, task, photo_prompt, estimated_time, lat, lng)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [missionId, s.venue.id, s.order, s.venue.name, s.task, s.photo_prompt, s.estimated_time, s.venue.lat, s.venue.lng]
    )
  }

  logger.info(`Generated mission "${ai.title}" (${validStops.length} stops) for ${city}`)
  return getMission(missionId)
}

// Fetch a full mission with its stops
async function getMission(id) {
  const m = await query(`SELECT * FROM missions WHERE id=$1`, [id])
  if (!m.rows.length) return null
  const stops = await query(
    `SELECT ms.*, v.cover_photo, v.category_slug, v.rating
     FROM mission_stops ms LEFT JOIN venues v ON v.id = ms.venue_id
     WHERE ms.mission_id=$1 ORDER BY ms.stop_order ASC`, [id]
  )
  return { ...m.rows[0], stops: stops.rows }
}

module.exports = { generateMission, getMission }
