// src/services/searchResults.js
// Stage 2 of unified search: given a classified intent (from searchIntent.js),
// assemble a BLENDED, sectioned result set — all from the DB (no live Google/
// TripAdvisor/Skiddle calls; those populate the DB via sync). This is what
// turns "date night" into a plan + restaurants + events + hidden gems + bars,
// and "pizza" into a clean ranked list, all feeling effortless to the user.
//
// Returns: { sections: [ { key, title, icon, type, items:[...] } ], meta }

const { query } = require('../db/pool')
const { repairVenuePhotos } = require('../utils/helpers')
const logger = require('../utils/logger')

// Category group → the DB category_slug values that belong to it. Mirrors the
// roulette CATEGORY_GROUPS vocabulary so we read real rows.
const GROUP_SLUGS = {
  food: ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food', 'brunch', 'diner', 'dessert', 'street_food', 'food_market'],
  cafe: ['cafe', 'coffee_shop', 'bakery'],
  drinks: ['bar', 'pub', 'cocktail_bar', 'wine_bar', 'brewery', 'taproom'],
  nightlife: ['nightclub', 'night_club', 'club', 'dance_club'],
  tourist: ['attraction', 'tourist_attraction', 'landmark', 'historical_landmark', 'museum', 'gallery', 'art_gallery', 'historic_site', 'church', 'zoo', 'aquarium'],
  scenic: ['park', 'viewpoint', 'waterfront', 'garden', 'beach', 'trail', 'walking_route'],
}

const SECTION_META = {
  restaurants: { title: 'Restaurants', icon: '🍽' },
  cafes: { title: 'Cafés & Coffee', icon: '☕' },
  bars: { title: 'Bars & Cocktails', icon: '🍸' },
  nightlife: { title: 'Nightlife', icon: '🪩' },
  culture: { title: 'Culture & Landmarks', icon: '🏛' },
  outdoors: { title: 'Parks & Outdoors', icon: '🌳' },
  events: { title: 'Events', icon: '🎵' },
  hidden_gems: { title: 'Hidden Gems', icon: '💎' },
  places: { title: 'Places', icon: '📍' },
  top_places: { title: 'Top Rated', icon: '⭐' },
}

function parseTags(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') { try { const p = JSON.parse(val); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

// Quality-rank helper (same spirit as SappoScore quality bucket, condensed):
// rewards known-good, dampens thin-signal, neutral on missing data.
function qualityRank(v) {
  const rating = Number(v.rating) || 0
  const reviews = Number(v.rating_count) || 0
  if (!rating) return 0
  const confidence = reviews / (reviews + 20)
  return (rating - 3.4) * 22 * confidence + Math.min(reviews / 400, 6)
}

const VENUE_COLS = 'id,name,category_slug,lat,lng,address,city,rating,rating_count,price_level,cover_photo,photos,gem_tags,opening_hours,business_status,website'

// Fetch a section of venues for one or more category groups.
async function fetchVenueSection(groups, { city, limit = 8, gemsOnly = false, excludeIds = new Set() }) {
  const slugs = [...new Set(groups.flatMap(g => GROUP_SLUGS[g] || []))]
  if (!slugs.length) return []
  const params = [slugs]
  let where = `category_slug = ANY($1) AND business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'`
  if (city) { params.push(city); where += ` AND city = $${params.length}` }
  const { rows } = await query(
    `SELECT ${VENUE_COLS} FROM venues WHERE ${where} LIMIT 300`, params
  ).catch(e => { logger.error('[searchResults] venue section failed: ' + e.message); return { rows: [] } })

  let pool = rows.filter(v => !excludeIds.has(v.id))
  if (gemsOnly) pool = pool.filter(v => { const t = parseTags(v.gem_tags); return t.includes('hidden_gem') || t.includes('local_favourite') })

  return pool
    .map(v => ({ v, q: qualityRank(v) + (parseTags(v.gem_tags).includes('hidden_gem') ? 8 : 0) }))
    .sort((a, b) => b.q - a.q)
    .slice(0, limit)
    .map(({ v }) => { const { gem_tags, ...rest } = v; const out = repairVenuePhotos(rest); out.tags = parseTags(gem_tags); return out })
}

// Fetch upcoming events (optionally filtered by a genre/keyword).
async function fetchEventSection({ city, limit = 8, genre = null }) {
  const params = []
  let where = `e.status='active' AND e.starts_at >= now()`
  if (city) { params.push(city); where += ` AND v.city = $${params.length}` }
  if (genre) { params.push(`%${genre}%`); where += ` AND (e.genre ILIKE $${params.length} OR e.category ILIKE $${params.length} OR e.name ILIKE $${params.length})` }
  const { rows } = await query(
    `SELECT e.id,e.name,e.description,e.image_url,e.category,e.genre,e.starts_at,e.ends_at,e.is_free,e.min_price,e.ticket_url,
            v.name AS venue_name, v.id AS venue_id, v.lat, v.lng
       FROM events e LEFT JOIN venues v ON v.id = e.venue_id
      WHERE ${where}
      ORDER BY e.starts_at ASC
      LIMIT $${params.length + 1}`,
    [...params, limit]
  ).catch(e => { logger.error('[searchResults] event section failed: ' + e.message); return { rows: [] } })
  return rows
}

function section(key, type, items) {
  const meta = SECTION_META[key] || { title: key, icon: '📍' }
  return { key, title: meta.title, icon: meta.icon, type, items }
}

// Main entry: build blended sections for a classified intent.
// intent: output of classifyIntent(). ctx: { city, lat, lng }.
async function buildSearchResults(intent, ctx = {}) {
  const city = ctx.city || null
  const sections = []
  const meta = { intent: intent.intent, categories: intent.categories, vibe: intent.vibe }

  switch (intent.intent) {
    case 'place_category':
    case 'ranked_places': {
      const groups = intent.categories.length ? intent.categories : ['food']
      // Primary section for the requested category.
      const primaryKey = groups.includes('food') ? 'restaurants'
        : groups.includes('cafe') ? 'cafes'
        : groups.includes('drinks') ? 'bars'
        : groups.includes('nightlife') ? 'nightlife'
        : groups.includes('tourist') ? 'culture'
        : groups.includes('scenic') ? 'outdoors' : 'places'
      const main = await fetchVenueSection(groups, { city, limit: intent.intent === 'ranked_places' ? 12 : 10 })
      sections.push(section(intent.intent === 'ranked_places' ? 'top_places' : primaryKey, 'venues', main))
      // A hidden-gems section of the same category (skip ones already shown).
      const shown = new Set(main.map(v => v.id))
      const gems = await fetchVenueSection(groups, { city, limit: 5, gemsOnly: true, excludeIds: shown })
      if (gems.length) sections.push(section('hidden_gems', 'venues', gems))
      break
    }

    case 'events': {
      const evs = await fetchEventSection({ city, limit: 12 })
      sections.push(section('events', 'events', evs))
      // Plus a few good bars/nightlife to round out a night.
      const bars = await fetchVenueSection(['drinks', 'nightlife'], { city, limit: 6 })
      if (bars.length) sections.push(section('bars', 'venues', bars))
      break
    }

    case 'itinerary': {
      // The plan itself is assembled by the caller (it owns planNight); here we
      // provide the supporting blended sections around it.
      const food = await fetchVenueSection(['food'], { city, limit: 6 })
      sections.push(section('restaurants', 'venues', food))
      const bars = await fetchVenueSection(['drinks'], { city, limit: 6 })
      if (bars.length) sections.push(section('bars', 'venues', bars))
      const evs = await fetchEventSection({ city, limit: 6 })
      if (evs.length) sections.push(section('events', 'events', evs))
      const gems = await fetchVenueSection(['food', 'drinks'], { city, limit: 5, gemsOnly: true })
      if (gems.length) sections.push(section('hidden_gems', 'venues', gems))
      break
    }

    case 'mixed_discovery': {
      // A bit of everything — the "things to do" blend.
      const food = await fetchVenueSection(['food'], { city, limit: 6 })
      sections.push(section('restaurants', 'venues', food))
      const culture = await fetchVenueSection(['tourist'], { city, limit: 6 })
      if (culture.length) sections.push(section('culture', 'venues', culture))
      const evs = await fetchEventSection({ city, limit: 6 })
      if (evs.length) sections.push(section('events', 'events', evs))
      const outdoors = await fetchVenueSection(['scenic'], { city, limit: 5 })
      if (outdoors.length) sections.push(section('outdoors', 'venues', outdoors))
      const gems = await fetchVenueSection(['food', 'drinks', 'tourist'], { city, limit: 6, gemsOnly: true })
      if (gems.length) sections.push(section('hidden_gems', 'venues', gems))
      break
    }

    default:
      // surprise / venue_lookup / empty are handled by the caller, not here.
      break
  }

  return { sections, meta }
}

module.exports = { buildSearchResults, fetchVenueSection, fetchEventSection }
