// src/services/suggestionMode.js
// Suggestion Mode — instead of one fixed itinerary, return a curated SPREAD of
// options (nearby places, hidden gems, attractions, events) as tappable cards,
// so the user can build their own day. Guidance without taking away choice.

const { nearbySearch, ATTRACTION_CATS } = require('./nearbySearch')
const logger = require('../utils/logger')

// Build the multi-section suggestion response.
// { lat, lng, cityName, weather, events, boosts }
async function buildSuggestions({ lat, lng, cityName, weather, events = [], boosts = null }) {
  const haveGPS = lat != null && lng != null
  const sections = []

  // A) GREAT NEARBY PLACES — food & drink, proximity-first
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

    // B) ATTRACTIONS / THINGS TO SEE
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

    // C) HIDDEN GEMS — quality but lesser-known (lower review counts, high rating)
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

  // D) EVENTS — from whatever events were passed in (Skiddle/Ticketmaster/Eventbrite)
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
