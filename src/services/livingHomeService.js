const { query } = require('../db/pool')
const { distanceMeters, repairVenuePhotos } = require('../utils/helpers')
const { apiHours, evaluateOpeningHours, isTimeAppropriate } = require('./openingHours')

const HOME_GROUPS = [
  { key: 'perfect_match', label: 'Perfect match', categories: ['restaurant', 'bar', 'pub', 'cafe', 'bakery', 'brewery'], intent: 'best' },
  { key: 'food', label: 'Food', categories: ['restaurant', 'cafe', 'bakery', 'food', 'market'], intent: 'food' },
  { key: 'live_tonight', label: 'Live tonight', categories: ['bar', 'pub', 'nightclub', 'theatre', 'music_venue', 'restaurant'], intent: 'live' },
  { key: 'hidden_gem', label: 'Hidden gem', categories: [], intent: 'hidden' },
  { key: 'parks_walks', label: 'Fancy a walk?', categories: ['park', 'garden', 'attraction', 'historic', 'landmark', 'outdoor'], intent: 'walk' },
]

function numeric(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function categoryMatches(venue, categories) {
  if (!categories?.length) return true
  const category = String(venue.category_slug || '').toLowerCase()
  return categories.some(target => category === target || category.includes(target))
}

function isWalkPlace(venue) {
  return categoryMatches(venue, HOME_GROUPS.find(group => group.key === 'parks_walks').categories)
}

function availabilityForHome(venue, city, now) {
  const hours = apiHours(venue.opening_hours, { city })
  const evaluated = evaluateOpeningHours(venue.opening_hours, now, { city, durationMinutes: 45 })
  // Parks and landmarks often lack structured hours. Do not claim they are open,
  // but keep them available as daylight walk ideas when they are not marked closed.
  if (isWalkPlace(venue)) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: hours.timezone, hour: '2-digit', hourCycle: 'h23' }).format(now))
    return { eligible: hour >= 8 && hour < 20, status: hour >= 8 && hour < 20 ? 'daylight_walk' : 'after_dark', hours }
  }
  const eligible = hours.isOpenNow === true || (evaluated.eligible && isTimeAppropriate(venue, now, { city }))
  return { eligible, status: evaluated.status, hours }
}

function enrichVenue(venue, { city, lat, lng, now }) {
  const distanceMetersFromUser = Number.isFinite(lat) && Number.isFinite(lng) && venue.lat != null && venue.lng != null
    ? Math.round(distanceMeters(lat, lng, Number(venue.lat), Number(venue.lng)))
    : null
  const availability = availabilityForHome(venue, city, now)
  return repairVenuePhotos({
    ...venue,
    distance_meters: distanceMetersFromUser,
    walking_time_minutes: distanceMetersFromUser == null ? null : Math.max(1, Math.round(distanceMetersFromUser / 80)),
    ...availability.hours,
    homeAvailability: availability.status,
    homeEligible: availability.eligible,
  })
}

function score(venue, intent) {
  let value = numeric(venue.rating) * 10 + Math.min(numeric(venue.rating_count), 750) / 120
  if (venue.homeEligible) value += 15
  if (venue.distance_meters != null) value += Math.max(0, 14 - venue.distance_meters / 250)
  if (venue.event_id) value += 30
  if (intent === 'food' && /restaurant|cafe|bakery|food|market/.test(venue.category_slug || '')) value += 14
  if (intent === 'walk' && isWalkPlace(venue)) value += 20
  if (intent === 'hidden') {
    const reviews = numeric(venue.rating_count)
    if (numeric(venue.rating) >= 4.4 && reviews > 0 && reviews <= 250) value += 25
    else value -= 25
  }
  return value
}

function choose(candidates, group, used) {
  const filtered = candidates
    .filter(venue => !used.has(String(venue.id)))
    .filter(venue => categoryMatches(venue, group.categories))
    .filter(venue => group.intent === 'live' ? Boolean(venue.event_id) : venue.homeEligible)
    .filter(venue => group.intent !== 'hidden' || (numeric(venue.rating) >= 4.4 && numeric(venue.rating_count) > 0 && numeric(venue.rating_count) <= 250))
    .sort((a, b) => score(b, group.intent) - score(a, group.intent))
  const choice = filtered[0] || null
  if (choice) used.add(String(choice.id))
  return choice
}

function bubbleReason(group, venue) {
  if (group.key === 'live_tonight') return venue.event_name ? venue.event_name : 'Something good is on tonight.'
  if (group.key === 'parks_walks') return venue.walking_time_minutes ? `${venue.walking_time_minutes} min walk from you.` : 'A good excuse to get outside.'
  if (group.key === 'hidden_gem') return 'Highly rated, with a quieter local following.'
  if (group.key === 'food') return venue.isOpenNow ? 'Open now and ready when you are.' : 'A good food stop nearby.'
  return venue.isOpenNow ? 'Open now and looking like your kind of place.' : 'A strong fit for your evening.'
}

async function buildLivingHome({ city, lat = null, lng = null, now = new Date(), limit = 160 } = {}) {
  if (!city) return { error: 'city_required' }
  const { rows } = await query(
    `SELECT v.id,v.name,v.category_slug,v.lat,v.lng,v.address,v.city,v.rating,v.rating_count,
            v.price_level,v.opening_hours,v.business_status,v.photos,v.cover_photo,v.gem_tags,
            e.id AS event_id,e.name AS event_name,e.starts_at AS event_starts_at,e.image_url AS event_image_url
       FROM venues v
       LEFT JOIN LATERAL (
         SELECT id,name,starts_at,image_url FROM events
         WHERE venue_id=v.id AND status='active' AND starts_at >= now() - interval '2 hours'
         ORDER BY starts_at ASC LIMIT 1
       ) e ON true
      WHERE v.city=$1 AND v.business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'
      ORDER BY v.rating DESC NULLS LAST, v.rating_count DESC NULLS LAST
      LIMIT $2`,
    [city, Math.min(Math.max(Number(limit) || 160, 20), 300)]
  )

  const candidates = rows.map(venue => enrichVenue(venue, { city, lat: Number(lat), lng: Number(lng), now }))
  const used = new Set()
  const groups = HOME_GROUPS.map(group => {
    const venue = choose(candidates, group, used)
    return venue ? {
      key: group.key,
      label: group.label,
      venue,
      reason: bubbleReason(group, venue),
      event: venue.event_id ? { id: venue.event_id, name: venue.event_name, startsAt: venue.event_starts_at, imageUrl: venue.event_image_url } : null,
    } : null
  }).filter(Boolean)

  return {
    city,
    generatedAt: now.toISOString(),
    groups,
    more: candidates.filter(venue => !used.has(String(venue.id)) && venue.homeEligible)
      .sort((a, b) => score(b, 'best') - score(a, 'best'))
      .slice(0, 12),
  }
}

module.exports = { HOME_GROUPS, buildLivingHome, availabilityForHome, bubbleReason }
