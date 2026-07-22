const { CITIES } = require('../config')
const { query } = require('../db/pool')
const { getWeather } = require('../clients/weather')
const { gatherCandidates, saveDiscoveredVenue } = require('./rouletteEngine')
const { getUserSignals } = require('./behaviorLearning')

const BROAD_CATEGORIES = [
  'restaurant', 'cafe', 'bakery', 'bar', 'pub', 'nightclub', 'music_venue',
  'attraction', 'museum', 'gallery', 'landmark', 'park', 'theatre', 'cinema',
]

const INTEREST_CATEGORIES = {
  food: ['restaurant', 'cafe', 'bakery'], drinks: ['bar', 'pub'], coffee: ['cafe'],
  music: ['music_venue', 'bar', 'pub'], culture: ['museum', 'gallery', 'landmark'],
  history: ['museum', 'landmark'], walk: ['park', 'attraction'], outdoors: ['park', 'attraction'],
  family: ['attraction', 'museum', 'park'], nightlife: ['bar', 'pub', 'nightclub', 'music_venue'],
}

function categoriesFor(intent) {
  const out = new Set()
  for (const interest of intent.interests || []) {
    const mapped = INTEREST_CATEGORIES[interest] || [interest]
    mapped.forEach(cat => out.add(cat))
  }
  return out.size ? [...out] : BROAD_CATEGORIES
}

function candidateId(kind, id) {
  return `${kind}:${String(id)}`
}

function venueCandidate(v) {
  const externalId = v.provider_id || v.google_place_id || null
  const id = v.id != null ? v.id : externalId
  if (id == null) return null
  return {
    candidateId: candidateId('venue', id),
    type: 'venue',
    venueId: v.id != null ? Number(v.id) : null,
    externalId,
    source: v._src === 'google' ? 'google_places' : 'sappo_database',
    name: v.name,
    category: v.category_slug || 'other',
    lat: Number(v.lat), lng: Number(v.lng), address: v.address || null,
    rating: v.rating == null ? null : Number(v.rating),
    ratingCount: v.rating_count == null ? null : Number(v.rating_count),
    priceLevel: v.price_level == null ? null : Number(v.price_level),
    openingHours: v.opening_hours || null,
    businessStatus: v.business_status || null,
    coverPhoto: v.cover_photo || v.photos?.[0]?.url || v.photos?.[0] || null,
    googlePlaceId: externalId,
    updatedAt: v.updated_at || null,
    raw: v,
  }
}

function eventCandidate(e) {
  if (e.id == null) return null
  return {
    candidateId: candidateId('event', e.id),
    type: 'event',
    eventId: e.id,
    source: e.provider || (e._src === 'db' ? 'sappo_database' : 'event_provider'),
    name: e.name,
    category: e.category || e.genre || 'event',
    lat: e.lat == null ? null : Number(e.lat),
    lng: e.lng == null ? null : Number(e.lng),
    address: e.address || null,
    venueName: e.venue_name || null,
    startsAt: e.starts_at,
    endsAt: e.ends_at || null,
    isFree: !!e.is_free,
    minPrice: e.min_price == null ? null : Number(e.min_price),
    ticketUrl: e.ticket_url || null,
    coverPhoto: e.image_url || null,
    raw: e,
  }
}

function cityCoordinates(intent) {
  if (intent.location.lat != null && intent.location.lng != null) return intent.location
  const key = String(intent.location.city || '').toLowerCase().replace(/\s+/g, '')
  const preset = CITIES[key] || CITIES.liverpool
  return { ...intent.location, lat: preset.lat, lng: preset.lng, city: intent.location.city || preset.name }
}

async function recentHistory(intent, dbQuery = query) {
  const params = []
  let owner = null
  if (intent.userId) { params.push(intent.userId); owner = `user_id=$1` }
  else if (intent.deviceId) { params.push(intent.deviceId); owner = `device_id=$1` }
  if (!owner) return []
  try {
    const { rows } = await dbQuery(
      `SELECT venue_id,event_id,item_type,item_name,action,category_slug,created_at
       FROM user_interactions WHERE ${owner}
       ORDER BY created_at DESC LIMIT 100`,
      params
    )
    return rows
  } catch { return [] }
}

async function gatherRecommendationContext(intent, deps = {}) {
  const location = cityCoordinates(intent)
  const gather = deps.gatherCandidates || gatherCandidates
  const weatherFn = deps.getWeather || getWeather
  const signalsFn = deps.getUserSignals || getUserSignals
  const historyFn = deps.recentHistory || recentHistory
  const cats = categoriesFor(intent)

  const [candidateData, weather, userSignals, history] = await Promise.all([
    Promise.resolve().then(() => gather({ lat: location.lat, lng: location.lng, cityName: location.city, cats, radiusMiles: intent.radiusMiles || 6 })),
    Promise.resolve().then(() => weatherFn(location.lat, location.lng)).catch(() => null),
    Promise.resolve().then(() => signalsFn({ userId: intent.userId, deviceId: intent.deviceId })).catch(() => ({ categoryBoost: {} })),
    Promise.resolve().then(() => historyFn(intent)).catch(() => []),
  ])

  const venues = (candidateData.venues || []).map(venueCandidate).filter(Boolean)
  const events = (candidateData.events || []).map(eventCandidate).filter(Boolean)
  return {
    intent: { ...intent, location },
    weather,
    userSignals,
    history,
    venues,
    events,
    providerAudit: candidateData.audit || {},
    gatheredAt: new Date().toISOString(),
  }
}

async function ensureInternalVenueId(candidate, deps = {}) {
  if (candidate?.venueId) return candidate.venueId
  if (!candidate || candidate.type !== 'venue') return null
  const save = deps.saveDiscoveredVenue || saveDiscoveredVenue
  return save(candidate.raw, candidate.raw?.city || deps.city || null)
}

module.exports = {
  gatherRecommendationContext,
  ensureInternalVenueId,
  categoriesFor,
  venueCandidate,
  eventCandidate,
}
