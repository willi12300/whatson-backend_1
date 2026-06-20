// src/services/suggestionMode.js
// Suggestion Mode — curated, intent-aware recommendations.
// Key product rule: specific asks get specific results; broad asks get a useful spread.
// Discovery rule: SAPPO should surface nearby independent/highly-rated places, not just
// the same obvious city-centre venues with the most reviews.

const { nearbySearch, ATTRACTION_CATS } = require('./nearbySearch')
const { detectSearchIntent, getIntentRule, filterByDecisionRule } = require('./decisionRules')
const logger = require('../utils/logger')
const google = require('../clients/google')
const { getUserSignals, getVenueSignalMap, venueLearningScore, recordShownBatch } = require('./behaviorLearning')

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
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() }

const CHAIN_PATTERNS = [
  'starbucks','costa','caffe nero','pret','mcdonald','kfc','burger king','subway','greggs',
  'wetherspoon','slug and lettuce','revolution','all bar one','the ivy','turtle bay',
  'nando','pizza express','zizzi','wagamama','five guys','miller and carter','brewdog',
  'premier inn','travelodge','novotel','holiday inn','ibis','hilton','marriott','malmaison'
]
function isLikelyChain(name = '') {
  const n = norm(name)
  return CHAIN_PATTERNS.some(x => n.includes(x))
}
function discoveryScore(card = {}) {
  const rating = Number(card.rating || 0)
  const count = Number(card.rating_count || card.ratingCount || 0)
  let score = 0
  if (rating >= 4.7 && count >= 10 && count <= 600) score += 25
  else if (rating >= 4.5 && count >= 10 && count <= 1000) score += 20
  else if (rating >= 4.3 && count >= 10 && count <= 1500) score += 12
  if (!isLikelyChain(card.title || card.name)) score += 12
  else score -= 12
  if (count > 5000) score -= 15
  else if (count > 2500) score -= 10
  else if (count > 1200) score -= 5
  const d = Number(card.distance_meters || 0)
  if (d && d < 800) score += 12
  else if (d && d < 1500) score += 7
  else if (d && d > 3500) score -= 7
  return score
}
function googleToNearbyCard(v, lat, lng) {
  const m = haversineM(lat, lng, v.lat, v.lng)
  return {
    id: null,
    provider_id: v.providerId || v.googlePlaceId || null,
    title: v.name,
    category: v.primaryType || v.category || (v.types || [])[0] || 'place',
    category_slug: v.primaryType || v.category || (v.types || [])[0] || 'place',
    distance_meters: m == null ? null : Math.round(m),
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
    map_url: v.googleMapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name}, ${v.address || ''}`)}`,
  }
}
function dedupeCards(cards = []) {
  const seen = new Set()
  const out = []
  for (const c of cards) {
    const key = c.id ? `id:${c.id}` : `${norm(c.title)}|${Number(c.lat || 0).toFixed(3)}|${Number(c.lng || 0).toFixed(3)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}
function sortForDiscovery(cards = []) {
  return [...cards].sort((a, b) => {
    const da = Number(a.distance_meters || 999999)
    const db = Number(b.distance_meters || 999999)
    const sa = discoveryScore(a) + ((a.rating || 0) * 3) - Math.min(da / 250, 18)
    const sb = discoveryScore(b) + ((b.rating || 0) * 3) - Math.min(db / 250, 18)
    return sb - sa
  })
}
function splitHidden(cards = []) {
  const hidden = cards.filter(c => {
    const count = Number(c.rating_count || 0)
    const rating = Number(c.rating || 0)
    return rating >= 4.3 && count >= 5 && count <= 1500 && !isLikelyChain(c.title)
  })
  return sortForDiscovery(hidden)
}

function randomSeed() {
  // Rotates softly each request. We keep relevance, but avoid the exact same order every time.
  return Math.random()
}
function jitter(score, amount = 4) {
  return score + ((randomSeed() - 0.5) * amount)
}
function shuffleTop(items = [], topN = 10) {
  const head = items.slice(0, topN).map(x => ({ x, r: Math.random() })).sort((a,b) => a.r-b.r).map(o => o.x)
  return [...head, ...items.slice(topN)]
}
function qualityScore(card = {}) {
  const rating = Number(card.rating || 0)
  const count = Number(card.rating_count || card.ratingCount || 0)
  const reviewConfidence = Math.min(Math.log10(Math.max(count, 1)) / 4, 1) // caps huge review count influence
  return (rating * 12) + (reviewConfidence * 12)
}
function distanceScore(card = {}) {
  const d = Number(card.distance_meters || 999999)
  if (!Number.isFinite(d)) return 0
  if (d <= 500) return 35
  if (d <= 1000) return 28
  if (d <= 2000) return 18
  if (d <= 3500) return 10
  return 2
}
function provenFavouriteScore(card = {}, intentName = '') {
  const rating = Number(card.rating || 0)
  const count = Number(card.rating_count || 0)
  const name = norm(card.title || card.name)
  let s = qualityScore(card) + distanceScore(card) * 0.35 + Number(card._learningBoost || 0)
  // Known genuinely-good big parks/landmarks should still appear sometimes.
  if (['green_space', 'walking', 'attractions'].includes(intentName)) {
    if (['sefton park','calderstones park','princes park','otterspool promenade','stanley park'].some(k => name.includes(k))) s += 18
  }
  if (rating >= 4.4 && count >= 400) s += 12
  if (count > 10000) s -= 4 // don't let massive review count dominate
  return jitter(s, 8)
}
function localDiscoveryScore(card = {}) {
  return jitter(discoveryScore(card) + qualityScore(card) * 0.7 + distanceScore(card) * 0.7 + Number(card._learningBoost || 0), 10)
}
function closestScore(card = {}) {
  return jitter(distanceScore(card) + qualityScore(card) * 0.35 + discoveryScore(card) * 0.25 + Number(card._learningBoost || 0), 6)
}
function addUnique(out, used, items, n) {
  for (const c of items) {
    const key = c.id ? `id:${c.id}` : `${norm(c.title || c.name)}|${Number(c.lat || 0).toFixed(3)}|${Number(c.lng || 0).toFixed(3)}`
    if (used.has(key)) continue
    used.add(key); out.push(c)
    if (out.length >= n) break
  }
}
function mixedRecommendationSet(cards = [], intentName = '', limit = 12) {
  const unique = dedupeCards(cards).filter(Boolean)
  if (!unique.length) return []

  const proven = shuffleTop([...unique].sort((a,b) => provenFavouriteScore(b, intentName) - provenFavouriteScore(a, intentName)), 8)
  const discovery = shuffleTop([...unique].sort((a,b) => localDiscoveryScore(b) - localDiscoveryScore(a)), 12)
  const close = shuffleTop([...unique].sort((a,b) => closestScore(b) - closestScore(a)), 8)
  const wildcard = shuffleTop([...unique].sort((a,b) => sortForDiscovery([a,b])[0] === a ? -1 : 1), 20)

  // Controlled variety. Not random rubbish: every bucket is already filtered and relevant.
  const quotas = ['green_space','walking','attractions','museum','historical'].includes(intentName)
    ? { proven: Math.ceil(limit * 0.35), discovery: Math.ceil(limit * 0.30), close: Math.ceil(limit * 0.25), wildcard: limit }
    : { proven: Math.ceil(limit * 0.25), discovery: Math.ceil(limit * 0.40), close: Math.ceil(limit * 0.25), wildcard: limit }

  const out = [], used = new Set()
  addUnique(out, used, proven, Math.min(limit, quotas.proven))
  addUnique(out, used, discovery, Math.min(limit, out.length + quotas.discovery))
  addUnique(out, used, close, Math.min(limit, out.length + quotas.close))
  addUnique(out, used, wildcard, limit)

  // Final small shuffle of lower positions keeps the first few strong, but avoids identical rows.
  if (out.length > 4) {
    const first = out.slice(0, 3)
    const rest = shuffleTop(out.slice(3), 9)
    return [...first, ...rest].slice(0, limit)
  }
  return out.slice(0, limit)
}

function queryHints(intentName, raw = '') {
  const q = norm(raw)
  if (intentName === 'food') {
    if (q.includes('breakfast')) return ['breakfast near me', 'brunch near me', 'independent breakfast cafe', 'best breakfast cafe nearby']
    if (q.includes('brunch')) return ['brunch near me', 'breakfast and brunch cafe', 'independent brunch nearby']
    if (q.includes('coffee') || q.includes('cafe')) return ['independent coffee shop near me', 'cafe near me', 'best coffee nearby']
    if (q.includes('lunch')) return ['lunch near me', 'independent lunch spot nearby', 'cafe lunch near me']
    return ['food near me', 'independent restaurant nearby', 'local places to eat']
  }
  if (intentName === 'drinks') return ['cocktail bars near me', 'pubs near me', 'independent bars nearby', 'best local pubs']
  if (intentName === 'events') return []
  if (intentName === 'green_space') {
    if (q.includes('lake') || q.includes('water')) return ['parks with lake near me', 'green space lake nearby', 'waterside park near me']
    return ['parks near me', 'gardens near me', 'green spaces nearby', 'quiet park nearby']
  }
  if (intentName === 'walking') return ['scenic walks near me', 'walking trails nearby', 'promenade walk nearby', 'parks for walking']
  if (intentName === 'museum') return ['museums near me', 'galleries near me', 'exhibitions nearby']
  if (intentName === 'historical') return ['historic places near me', 'heritage sites nearby', 'landmarks near me']
  if (intentName === 'attractions') return ['things to do near me', 'attractions near me', 'places to visit nearby']
  return []
}

async function attachLearning(cards = [], { userId = null, deviceId = null } = {}) {
  if (!cards.length) return cards
  const ids = cards.map(c => c.venueId || c.venue_id || (c.type === 'venue' ? c.id : null)).filter(Boolean)
  const [signalMap, userSignals] = await Promise.all([
    getVenueSignalMap(ids),
    getUserSignals({ userId, deviceId }),
  ])
  return cards.map(c => {
    const vid = Number(c.venueId || c.venue_id || (c.type === 'venue' ? c.id : null))
    const boost = venueLearningScore(c, signalMap.get(vid), userSignals)
    return { ...c, _learningBoost: boost }
  })
}

function flattenSectionCards(sections = []) {
  return sections.flatMap(s => (s.cards || []).map(c => ({ ...c, _section: s.id })))
}

async function liveGoogleDiscovery({ lat, lng, cityName, rule, searchIntent, queryText, max = 24 }) {
  const out = []
  const seen = new Set()
  const radius = rule?.radius || 4000
  const hints = queryHints(searchIntent, queryText)
  for (const textQuery of hints.slice(0, 4)) {
    // We intentionally use text search because it surfaces more map-like local results
    // than nearby type search alone.
    const batch = await google.searchTextPlaces(textQuery, lat, lng, radius, { timeoutMs: 4500, maxResultCount: 15 })
    for (const v of batch) {
      const key = v.providerId || `${norm(v.name)}|${Number(v.lat || 0).toFixed(3)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(v)
      if (out.length >= max) break
    }
    if (out.length >= max) break
  }
  if (out.length < 8 && rule?.googleTypes?.length) {
    const live = await google.fetchVenues(lat, lng, radius, { types: rule.googleTypes, parallel: true, timeoutMs: 3500 })
    for (const v of live) {
      const key = v.providerId || `${norm(v.name)}|${Number(v.lat || 0).toFixed(3)}`
      if (seen.has(key)) continue
      seen.add(key); out.push(v)
      if (out.length >= max) break
    }
  }
  const strictLive = filterByDecisionRule(out.map(v => ({
    ...v,
    title: v.name,
    category: v.primaryType || (v.types || [])[0],
    category_slug: v.primaryType || (v.types || [])[0],
    google_types: v.types || [],
  })), rule)
  const cards = strictLive.map(v => googleToNearbyCard(v, lat, lng))

  // Fire-and-forget save/enrich discovered Google places so SAPPO gets smarter.
  try {
    const { saveDiscoveredVenue } = require('./rouletteEngine')
    for (const c of cards.slice(0, 20)) {
      saveDiscoveredVenue({
        name: c.title, category_slug: c.category, lat: c.lat, lng: c.lng,
        address: c.address, rating: c.rating, rating_count: c.rating_count,
        price_level: c.price_level, provider_id: c.googlePlaceId,
        cover_photo: c.cover_photo, photos: c.cover_photo ? [c.cover_photo] : [],
        _src: 'google_text_discovery',
      }, cityName).catch(() => {})
    }
  } catch {}

  return cards
}

// Build the multi-section suggestion response.
async function buildSuggestions({ lat, lng, cityName, weather, events = [], boosts = null, intent = null, queryText = '', debug = false, userId = null, deviceId = null }) {
  const haveGPS = lat != null && lng != null
  const sections = []
  const searchIntent = intent?.searchIntent || detectSearchIntent(queryText || intent?.raw || '', intent || {})
  const rule = getIntentRule(searchIntent)

  // STRICT QUERY MODE: if the user asks for a specific thing, only return that thing.
  // Event intent must NEVER fall back to parks/food/nearby venue buckets.
  if (searchIntent === 'events') {
    const eventCards = (events || []).slice(0, 12).map(eventToCard)
    if (eventCards.length) {
      sections.push({
        id: 'events', title: rule?.sectionTitle || 'Events Near You', icon: '🎟️',
        subtitle: rule?.sectionSubtitle || 'Live events and things happening soon',
        cards: eventCards,
      })
    }
    logger.info('[suggest] strict events: ' + JSON.stringify({ sections: sections.map(s => `${s.id}(${s.cards.length})`) }))
    recordShownBatch({ userId, deviceId, context: 'ai', city: cityName, items: flattenSectionCards(sections) }).catch(() => {})
    return sections
  }

  // For food/drinks we also add a second hidden-gem/independent section so the results
  // do not become the same famous venues every time.
  if (haveGPS && rule) {
    const cats = (rule.allowedCategories || []).filter(c => !['garden', 'nature_reserve', 'walking_trail', 'trail', 'historic_site'].includes(c))
    const out = await nearbySearch({
      lat, lng,
      categories: cats.length ? cats : [],
      radius: rule.radius || 5000,
      limit: 18,
      city: cityName,
      excludeLodging: true,
      intent: searchIntent,
      strict: true,
      debug,
    })
    let dbCards = (out.results || []).map(toCard)
    let liveCards = []
    try { liveCards = await liveGoogleDiscovery({ lat, lng, cityName, rule, searchIntent, queryText: queryText || intent?.raw || '' }) }
    catch (e) { logger.error('[suggest] google discovery failed:', e.message) }

    let allCards = dedupeCards([...liveCards, ...dbCards])
      .filter(c => !c.distance_meters || c.distance_meters <= (rule.radius || 5000))
    allCards = await attachLearning(allCards, { userId, deviceId })

    const mixed = mixedRecommendationSet(allCards, searchIntent, 12)
    const hidden = splitHidden(allCards).filter(h => !mixed.slice(0, 6).some(m => norm(m.title) === norm(h.title))).slice(0, 8)

    if (mixed.length) {
      sections.push({
        id: searchIntent,
        title: rule.sectionTitle || (searchIntent === 'food' ? 'Food Near You' : searchIntent === 'drinks' ? 'Drinks Near You' : rule.label),
        icon: searchIntent === 'food' ? '🍳' : (searchIntent === 'drinks' ? '🍸' : (searchIntent === 'green_space' || searchIntent === 'walking' ? '🌳' : (searchIntent === 'museum' ? '🏛️' : '📍'))),
        subtitle: rule.sectionSubtitle || `Relevant ${rule.label} close to you`,
        cards: mixed,
        debug: out.debug,
      })
    }

    // Food and drinks get an extra discovery carousel so independent spots do not get buried.
    if (['food', 'drinks'].includes(searchIntent) && hidden.length) {
      sections.push({
        id: `${searchIntent}_hidden`,
        title: searchIntent === 'food' ? 'Independent Gems Nearby' : 'Hidden Drink Spots',
        icon: '💎',
        subtitle: 'High quality, less obvious, more local',
        cards: mixedRecommendationSet(hidden, searchIntent, 8),
      })
    }
    logger.info('[suggest] strict discovery: ' + JSON.stringify({ intent: searchIntent, sections: sections.map(s => `${s.id}(${s.cards.length})`) }))
    recordShownBatch({ userId, deviceId, context: 'ai', city: cityName, items: flattenSectionCards(sections) }).catch(() => {})
    return sections
  }

  // BROAD DISCOVERY MODE — only for broad asks like "what's good nearby", "surprise me", "plan my day".
  if (haveGPS) {
    const food = await nearbySearch({
      lat, lng, categories: ['restaurant', 'cafe', 'bar', 'pub'],
      radius: 2500, limit: 10, city: cityName, excludeLodging: true,
    })
    if (food.results?.length) {
      sections.push({
        id: 'nearby', title: 'Great Nearby Places', icon: '📍',
        subtitle: 'Good food & drink close to you',
        cards: mixedRecommendationSet(await attachLearning(food.results.map(toCard), { userId, deviceId }), 'food', 8),
      })
    }

    const attr = await nearbySearch({
      lat, lng, categories: ATTRACTION_CATS,
      radius: 5000, limit: 10, city: cityName,
    })
    if (attr.results?.length) {
      sections.push({
        id: 'attractions', title: 'Things to See', icon: '🎟️',
        subtitle: 'Attractions, museums & landmarks nearby',
        cards: mixedRecommendationSet(await attachLearning(attr.results.map(toCard), { userId, deviceId }), 'attractions', 8),
      })
    }

    const gems = await nearbySearch({
      lat, lng, categories: ['restaurant', 'cafe', 'bar', 'gallery', 'attraction', 'park'],
      radius: 3500, limit: 30, city: cityName, excludeLodging: true,
    })
    const hidden = splitHidden(await attachLearning((gems.results || []).map(toCard), { userId, deviceId })).slice(0, 8)
    if (hidden.length) {
      sections.push({
        id: 'hidden', title: 'Hidden Gems', icon: '💎',
        subtitle: 'Local favourites the crowds miss',
        cards: hidden,
      })
    }
  }

  if (events.length) {
    sections.push({
      id: 'events', title: 'Events On', icon: '🎤',
      subtitle: 'What’s happening around now',
      cards: events.slice(0, 8).map(eventToCard),
    })
  }

  logger.info('[suggest] sections: ' + sections.map(s => `${s.id}(${s.cards.length})`).join(', '))
  recordShownBatch({ userId, deviceId, context: 'ai', city: cityName, items: flattenSectionCards(sections) }).catch(() => {})
  return sections
}

function toCard(r) {
  return {
    type: 'venue',
    id: r.id,
    title: r.title,
    category: r.category,
    distance_text: r.distance_text,
    distance_meters: r.distance_meters,
    walking_time: r.walking_time_estimate || r.walking_time,
    rating: r.rating,
    rating_count: r.rating_count,
    price_level: r.price_level,
    open_now: r.open_now,
    address: r.address,
    lat: r.lat, lng: r.lng,
    cover_photo: r.cover_photo,
    source: r.source || 'Sappo',
    googlePlaceId: r.googlePlaceId || r.provider_id || null,
    map_url: r.google_maps_url || r.map_url,
    discovery_score: r.discovery_score,
    is_independent: r.is_independent,
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
