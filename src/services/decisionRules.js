// src/services/decisionRules.js
// SAPPO decision rules: classify user intent and apply hard filters BEFORE scoring.
// This prevents queries like "parks near me" returning cafés/bars just because they are nearby.

const NORMALISE = s => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/&/g, 'and').replace(/[^a-z0-9\s_/-]/g, ' ').replace(/\s+/g, ' ').trim()

const CATEGORY_ALIASES = {
  tourist_attraction: 'attraction',
  point_of_interest: 'attraction',
  establishment: 'other',
  food: 'restaurant',
  meal_takeaway: 'restaurant',
  meal_delivery: 'restaurant',
  bakery: 'cafe',
  art_gallery: 'gallery',
  historical_landmark: 'landmark',
  church: 'landmark',
  park: 'park',
  garden: 'park',
  night_club: 'nightclub',
  movie_theater: 'cinema',
  cinema: 'cinema',
}

function normCat(cat) {
  const c = NORMALISE(cat).replace(/[\s-]+/g, '_')
  return CATEGORY_ALIASES[c] || c
}

const INTENT_RULES = {
  green_space: {
    label: 'parks and green spaces',
    sectionTitle: 'Parks Near You',
    sectionSubtitle: 'Green spaces, gardens and walks close by',
    allowedCategories: ['park', 'garden', 'nature_reserve', 'walking_trail', 'trail', 'viewpoint', 'landmark', 'attraction'],
    allowedTypes: ['park', 'tourist_attraction', 'point_of_interest', 'natural_feature'],
    requiredAnyKeywords: ['park', 'garden', 'gardens', 'green', 'green space', 'green spaces', 'trail', 'walk', 'walking', 'woods', 'woodland', 'nature', 'reserve', 'viewpoint', 'promenade', 'beach', 'common', 'meadow', 'lake', 'lakes', 'pond', 'water', 'waterfront', 'reservoir'],
    blockedCategories: ['restaurant', 'cafe', 'bar', 'pub', 'nightclub', 'hotel', 'lodging', 'club', 'event', 'shopping'],
    blockedKeywords: ['coffee', 'cafe', 'bar', 'pub', 'restaurant', 'hotel', 'club', 'nightclub', 'bingo', 'casino', 'karaoke', 'grill', 'kitchen'],
    googleTypes: ['park', 'tourist_attraction'],
    radius: 6000,
  },
  walking: {
    label: 'walks and trails',
    sectionTitle: 'Walks Near You',
    sectionSubtitle: 'Trails, parks and scenic walking spots nearby',
    allowedCategories: ['park', 'garden', 'nature_reserve', 'walking_trail', 'trail', 'viewpoint', 'landmark', 'attraction'],
    allowedTypes: ['park', 'tourist_attraction', 'point_of_interest'],
    requiredAnyKeywords: ['walk', 'walking', 'trail', 'route', 'path', 'promenade', 'park', 'garden', 'woods', 'nature', 'viewpoint', 'waterfront', 'dock', 'beach', 'lake', 'lakes', 'pond', 'water', 'reservoir'],
    blockedCategories: ['restaurant', 'cafe', 'bar', 'pub', 'nightclub', 'hotel', 'lodging', 'event'],
    blockedKeywords: ['coffee', 'cafe', 'bar', 'pub', 'restaurant', 'hotel', 'club', 'nightclub'],
    googleTypes: ['park', 'tourist_attraction'],
    radius: 8000,
  },
  museum: {
    label: 'museums',
    sectionTitle: 'Museums Near You',
    sectionSubtitle: 'Museums, exhibitions and galleries nearby',
    allowedCategories: ['museum', 'gallery', 'art_gallery', 'attraction', 'landmark'],
    allowedTypes: ['museum', 'art_gallery', 'tourist_attraction'],
    requiredAnyKeywords: ['museum', 'gallery', 'exhibition', 'exhibit', 'art', 'heritage', 'history'],
    blockedCategories: ['restaurant', 'cafe', 'bar', 'pub', 'nightclub', 'hotel', 'lodging', 'park'],
    blockedKeywords: ['coffee', 'bar', 'pub', 'restaurant', 'hotel', 'club', 'nightclub'],
    googleTypes: ['museum', 'art_gallery', 'tourist_attraction'],
    radius: 6000,
  },
  historical: {
    label: 'historical places',
    sectionTitle: 'Historical Spots Near You',
    sectionSubtitle: 'Heritage, landmarks and culture close by',
    allowedCategories: ['museum', 'gallery', 'landmark', 'attraction', 'church', 'historic_site'],
    allowedTypes: ['museum', 'tourist_attraction', 'church', 'point_of_interest'],
    requiredAnyKeywords: ['historic', 'historical', 'history', 'heritage', 'monument', 'memorial', 'cathedral', 'church', 'castle', 'dock', 'maritime', 'beatles', 'landmark'],
    blockedCategories: ['restaurant', 'cafe', 'bar', 'pub', 'nightclub', 'hotel', 'lodging'],
    blockedKeywords: ['coffee', 'bar', 'pub', 'restaurant', 'hotel', 'club', 'nightclub'],
    googleTypes: ['museum', 'tourist_attraction', 'church'],
    radius: 7000,
  },
  food: {
    label: 'food',
    sectionTitle: 'Food Near You',
    sectionSubtitle: 'Restaurants, cafés and places to eat nearby',
    allowedCategories: ['restaurant', 'cafe', 'bakery', 'meal_takeaway'],
    allowedTypes: ['restaurant', 'cafe', 'bakery', 'meal_takeaway'],
    requiredAnyKeywords: ['restaurant', 'food', 'eat', 'dinner', 'lunch', 'breakfast', 'brunch', 'cafe', 'coffee', 'bakery', 'pizza', 'burger', 'kitchen', 'grill'],
    blockedCategories: ['hotel', 'lodging', 'nightclub', 'museum', 'park', 'event'],
    blockedKeywords: ['hotel', 'hostel', 'travelodge', 'premier inn', 'aparthotel', 'guest house'],
    googleTypes: ['restaurant', 'cafe', 'bakery', 'meal_takeaway'],
    radius: 3000,
  },
  drinks: {
    label: 'drinks',
    sectionTitle: 'Drinks Near You',
    sectionSubtitle: 'Bars, pubs and cocktail spots nearby',
    allowedCategories: ['bar', 'pub', 'nightclub'],
    allowedTypes: ['bar', 'pub', 'night_club'],
    requiredAnyKeywords: ['bar', 'pub', 'drinks', 'cocktail', 'beer', 'wine', 'ale', 'taproom', 'club'],
    blockedCategories: ['hotel', 'lodging', 'restaurant', 'cafe', 'park', 'museum'],
    blockedKeywords: ['hotel', 'hostel', 'coffee shop', 'museum', 'park'],
    googleTypes: ['bar', 'night_club'],
    radius: 3000,
  },
  attractions: {
    label: 'attractions',
    sectionTitle: 'Attractions Near You',
    sectionSubtitle: 'Things to see and places worth visiting',
    allowedCategories: ['attraction', 'museum', 'gallery', 'landmark', 'park', 'cinema'],
    allowedTypes: ['tourist_attraction', 'museum', 'art_gallery', 'park', 'movie_theater'],
    blockedCategories: ['hotel', 'lodging', 'restaurant', 'cafe', 'bar', 'pub', 'nightclub'],
    blockedKeywords: ['hotel', 'hostel', 'coffee', 'bar', 'pub', 'restaurant'],
    googleTypes: ['tourist_attraction', 'museum', 'art_gallery', 'park', 'movie_theater'],
    radius: 7000,
  },
}

const INTENT_KEYWORDS = [
  { intent: 'walking', words: ['walking trail', 'walking trails', 'walks near', 'walk near', 'good walk', 'scenic walk', 'trail near', 'trails near', 'places to walk'] },
  { intent: 'green_space', words: ['park', 'parks', 'garden', 'gardens', 'green space', 'green spaces', 'nature reserve', 'woods', 'woodland', 'lake', 'lakes', 'pond', 'waterfront', 'greenery'] },
  { intent: 'museum', words: ['museum', 'museums', 'gallery', 'galleries', 'exhibition', 'exhibitions', 'art gallery'] },
  { intent: 'historical', words: ['historical', 'historic', 'history', 'heritage', 'monument', 'memorial', 'cathedral', 'church', 'landmark', 'sightseeing'] },
  { intent: 'drinks', words: ['bar', 'bars', 'pub', 'pubs', 'cocktail', 'cocktails', 'drinks', 'pint', 'beer', 'wine'] },
  { intent: 'food', words: ['food', 'restaurant', 'restaurants', 'eat', 'dinner', 'lunch', 'breakfast', 'brunch', 'cafe', 'coffee', 'bakery'] },
  { intent: 'attractions', words: ['attraction', 'attractions', 'things to do', 'places to see', 'tourist spot', 'tourist spots'] },
]

function detectSearchIntent(text = '', parsed = {}) {
  const raw = NORMALISE(text || parsed.raw || '')
  for (const row of INTENT_KEYWORDS) {
    if (row.words.some(w => raw.includes(NORMALISE(w)))) return row.intent
  }
  const cats = (parsed.categories || []).map(normCat)
  if (cats.includes('park')) return 'green_space'
  if (cats.includes('museum') || cats.includes('gallery')) return 'museum'
  if (cats.includes('landmark')) return 'historical'
  if (cats.some(c => ['restaurant', 'cafe'].includes(c))) return 'food'
  if (cats.some(c => ['bar', 'pub', 'nightclub'].includes(c))) return 'drinks'
  if (cats.some(c => ['attraction'].includes(c))) return 'attractions'
  return null
}

function getIntentRule(intent) {
  return intent ? INTENT_RULES[intent] || null : null
}

function categoriesForIntent(intent) {
  const rule = getIntentRule(intent)
  if (!rule) return []
  // Only return categories that actually exist in our DB category_slug world.
  return (rule.allowedCategories || []).filter(c => !['garden', 'nature_reserve', 'walking_trail', 'trail', 'historic_site'].includes(c)).map(normCat)
}

function itemText(item = {}) {
  const fields = [item.name, item.title, item.category, item.category_slug, item.address, item.description, item.type, item.venue, item.venue_name]
  if (Array.isArray(item.google_types)) fields.push(...item.google_types)
  if (Array.isArray(item.types)) fields.push(...item.types)
  if (Array.isArray(item.tags)) fields.push(...item.tags)
  return NORMALISE(fields.filter(Boolean).join(' '))
}

function matchesDecisionRule(item = {}, rule = null) {
  if (!rule) return { ok: true, reason: 'no_rule' }
  const cat = normCat(item.category_slug || item.category || item.type || '')
  const text = itemText(item)
  const types = [...(item.google_types || []), ...(item.types || [])].map(normCat)

  if (rule.blockedCategories?.some(c => cat === normCat(c) || types.includes(normCat(c)))) return { ok: false, reason: `blocked category: ${cat}` }
  const badWord = (rule.blockedKeywords || []).find(w => text.includes(NORMALISE(w)))
  if (badWord) return { ok: false, reason: `blocked keyword: ${badWord}` }

  const allowedCats = (rule.allowedCategories || []).map(normCat)
  const allowedTypes = (rule.allowedTypes || []).map(normCat)
  if (allowedCats.length || allowedTypes.length) {
    const catOk = allowedCats.includes(cat)
    const typeOk = types.some(t => allowedTypes.includes(t) || allowedCats.includes(t))
    const keywordOk = (rule.requiredAnyKeywords || []).some(w => text.includes(NORMALISE(w)))
    if (!catOk && !typeOk && !keywordOk) return { ok: false, reason: `not ${rule.label}` }
  }

  return { ok: true, reason: 'matched' }
}

function filterByDecisionRule(items = [], rule = null, opts = {}) {
  const rejected = []
  const kept = []
  for (const item of items || []) {
    const r = matchesDecisionRule(item, rule)
    if (r.ok) kept.push(item)
    else if (opts.debug) rejected.push({ name: item.name || item.title, category: item.category_slug || item.category || item.type, reason: r.reason })
  }
  return opts.debug ? { kept, rejected } : kept
}

module.exports = { INTENT_RULES, detectSearchIntent, getIntentRule, categoriesForIntent, matchesDecisionRule, filterByDecisionRule, normCat }
