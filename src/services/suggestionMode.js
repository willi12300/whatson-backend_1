// src/services/suggestionMode.js
// Suggestion Mode — instead of one fixed itinerary, return a curated SPREAD of
// options (nearby places, hidden gems, attractions, events) as tappable cards,
// so the user can build their own day. Guidance without taking away choice.

const { nearbySearch, ATTRACTION_CATS } = require('./nearbySearch')
const { detectSearchIntent, getIntentRule } = require('./decisionRules')
const logger = require('../utils/logger')
const google = require('../clients/google')
const { filterByDecisionRule } = require('./decisionRules')


function haversineM(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some(x => x == null)) return null
  const R = 6371000, r = x => x * Math.PI / 180
  const dLat = r(bLat - aLat), dLng = r(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
function walkText(m) {
  if (m == null) return null
  const mins = Math.max(1, Math.round((m / 1000 / 5) * 60))
  return `${mins} min walk`
}
function googleToNearbyCard(v, lat, lng) {
  const m = haversineM(lat, lng, v.lat, v.lng)
  return {
    id: null,
    provider_id: v.providerId || v.googlePlaceId || null,
    title: v.name,
    category: v.primaryType || v.category || (v.types || [])[0] || 'place',
    distance_text: m == null ? null : (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`),
    walking_time_estimate: walkText(m),
    rating: v.rating || null,
    rating_count: v.ratingCount || v.userRatingCount || null,
    price_level: v.priceLevel || null,
    open_now: v.openingHours?.openNow ?? null,
    address: v.address || null,
    lat: v.lat,
    lng: v.lng,
    cover_photo: Array.isArray(v.photos) ? (v.photos[0]?.url || v.photos[0]) : null,
    source: 'Google',
    googlePlaceId: v.providerId || v.googlePlaceId || null,
    google_types: v.types || [],
    map_url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name}, ${v.address || ''}`)}`,
  }
}

// Build the multi-section suggestion response.
// { lat, lng, cityName, weather, events, boosts }
async function buildSuggestions({ lat, lng, cityName, weather, events = [], boosts = null, intent = null, queryText = '', debug = false }) {
  const haveGPS = lat != null && lng != null
  const sections = []
  const searchIntent = intent?.searchIntent || detectSearchIntent(queryText || intent?.raw || '', intent || {})
  const rule = getIntentRule(searchIntent)

  // STRICT QUERY MODE — if the user asks for a specific thing (parks, museums, trails, food, etc.)
  // only return that thing. Do not mix in generic food/drinks/hidden gems.
  if (haveGPS && rule) {
    const cats = (rule.allowedCategories || []).filter(c => !['garden', 'nature_reserve', 'walking_trail', 'trail', 'historic_site'].includes(c))
    const out = await nearbySearch({
      lat, lng,
      categories: cats.length ? cats : [],
      radius: rule.radius || 5000,
      limit: 12,
      city: cityName,
      excludeLodging: true,
      intent: searchIntent,
      strict: true,
      debug,
    })
    let cards = (out.results || []).map(toCard)

    // If DB is thin, top up with live Google Places using the intent's allowed types.
    // These live results are still hard-filtered before showing.
    if (cards.length < 6 && rule.googleTypes?.length) {
      try {
        const live = await google.fetchVenues(lat, lng, rule.radius || 5000, {
          types: rule.googleTypes,
          parallel: true,
          timeoutMs: 3000,
        })
        const strictLive = filterByDecisionRule(live.map(v => ({
          ...v,
          title: v.name,
          category: v.primaryType || (v.types || [])[0],
          category_slug: v.primaryType || (v.types || [])[0],
          google_types: v.types || [],
        })), rule)
        const liveCards = strictLive.map(v => googleToNearbyCard(v, lat, lng))
        const seen = new Set(cards.map(c => `${(c.title || '').toLowerCase()}|${c.lat?.toFixed?.(3)}`))
        for (const c of liveCards) {
          const key = `${(c.title || '').toLowerCase()}|${c.lat?.toFixed?.(3)}`
          if (!seen.has(key)) { seen.add(key); cards.push(c) }
        }
        // Fire-and-forget save/enrich of newly discovered Google places.
        try {
          const { saveDiscoveredVenue } = require('./rouletteEngine')
          for (const c of liveCards.slice(0, 12)) {
            saveDiscoveredVenue({
              name: c.title, category_slug: c.category, lat: c.lat, lng: c.lng,
              address: c.address, rating: c.rating, rating_count: c.rating_count,
              price_level: c.price_level, provider_id: c.googlePlaceId,
              cover_photo: c.cover_photo, photos: c.cover_photo ? [c.cover_photo] : [],
              _src: 'google',
            }, cityName).catch(() => {})
          }
        } catch {}
      } catch (e) { logger.error('[suggest] strict google top-up failed:', e.message) }
    }

    if (cards.length) {
      sections.push({
        id: searchIntent,
        title: rule.sectionTitle || rule.label,
        icon: searchIntent === 'green_space' || searchIntent === 'walking' ? '🌳' : (searchIntent === 'museum' ? '🏛️' : '📍'),
        subtitle: rule.sectionSubtitle || `Relevant ${rule.label} close to you`,
        cards: cards.slice(0, 12),
        debug: out.debug,
      })
    }
    logger.info('[suggest] strict intent: ' + JSON.stringify({ intent: searchIntent, sections: sections.map(s => `${s.id}(${s.cards.length})`) }))
    return sections
  }

  // BROAD DISCOVERY MODE — only for broad asks like "what's good nearby", "surprise me", "plan my day".
  if (haveGPS) {
    const food = await nearbySearch({
      lat, lng, categories: ['restaurant', 'cafe', 'bar', 'pub'],
      radius: 2000, limit: 6, city: cityName, excludeLodging: true,
    })
    if (food.results?.length) {
      sections.push({
        id: 'nearby', title: 'Great Nearby Places', icon: '📍',
        subtitle: 'Good food & drink close to you',
        cards: food.results.map(toCard),
      })
    }

    const attr = await nearbySearch({
      lat, lng, categories: ATTRACTION_CATS,
      radius: 4000, limit: 6, city: cityName,
    })
    if (attr.results?.length) {
      sections.push({
        id: 'attractions', title: 'Things to See', icon: '🎟️',
        subtitle: 'Attractions, museums & landmarks nearby',
        cards: attr.results.map(toCard),
      })
    }

    const gems = await nearbySearch({
      lat, lng, categories: ['restaurant', 'cafe', 'bar', 'gallery', 'attraction'],
      radius: 2500, limit: 20, city: cityName, excludeLodging: true,
    })
    const hidden = (gems.results || [])
      .filter(c => c.rating >= 4.3 && (c.rating_count || 0) < 800)
      .slice(0, 6)
    if (hidden.length) {
      sections.push({
        id: 'hidden', title: 'Hidden Gems', icon: '💎',
        subtitle: 'Local favourites the crowds miss',
        cards: hidden.map(toCard),
      })
    }
  }

  if (events.length) {
    sections.push({
      id: 'events', title: 'Events On', icon: '🎤',
      subtitle: 'Whats happening around now',
      cards: events.slice(0, 8).map(eventToCard),
    })
  }

  logger.info('[suggest] sections: ' + sections.map(s => `${s.id}(${s.cards.length})`).join(', '))
  return sections
}

function toCard(r) {
  return {
    type: 'venue',
    id: r.id,
    title: r.title,
    category: r.category,
    distance_text: r.distance_text,
    walking_time: r.walking_time_estimate,
    rating: r.rating,
    price_level: r.price_level,
    open_now: r.open_now,
    address: r.address,
    lat: r.lat, lng: r.lng,
    cover_photo: r.cover_photo,
    source: r.source || 'Sappo',
    map_url: r.google_maps_url,
  }
}

function eventToCard(e) {
  return {
    type: 'event',
    id: e.id,
    title: e.name,
    when: e.starts_at,
    venue: e.venue_name,
    price: e.is_free ? 'Free' : (e.min_price ? `from £${e.min_price}` : null),
    source: e.source || 'Event',
    url: e.url || null,
  }
}

module.exports = { buildSuggestions }
