// src/services/searchIntent.js
// Stage 1 of unified search: classify a raw search query into an INTENT the
// rest of search can act on. Fast, rule-based, deterministic — reads no DB and
// makes no AI call, so common queries ("pizza", "live music") resolve
// instantly. Genuinely ambiguous queries are flagged (needsAI:true) so a later
// stage can send ONLY those to the AI. The user never sees any of this — it
// just makes search feel like it understands them.
//
// Intent types:
//   place_category   → browse a category of places (pizza, coffee, bars…)
//   events           → events search (live music, gigs, what's on)
//   ranked_places    → "best/top X" — same as category but sorted by quality
//   itinerary        → multi-part night/day out (date night, coffee then a walk)
//   mixed_discovery  → broad "things to do" — blended everything
//   surprise         → "I'm bored / surprise me" → hand to Sappo/roulette
//   venue_lookup     → looks like a specific place name (handled by /search)
//
// Output shape:
//   { intent, categories:[...], vibe, ranked, timeSensitive, needsAI, raw, cleaned }

// ── Category keyword → group slug (matches the DB's CATEGORY_GROUPS vocab) ──
const CATEGORY_KEYWORDS = {
  food: ['food', 'eat', 'eats', 'restaurant', 'restaurants', 'dinner', 'lunch', 'brunch', 'breakfast', 'pizza', 'burger', 'burgers', 'sushi', 'curry', 'indian', 'italian', 'chinese', 'thai', 'tapas', 'ramen', 'noodles', 'steak', 'seafood', 'vegan', 'vegetarian', 'bakery', 'dessert', 'desserts', 'kitchen', 'bistro', 'diner', 'takeaway', 'street food'],
  cafe: ['coffee', 'cafe', 'cafes', 'café', 'cafés', 'flat white', 'espresso', 'latte', 'tea room', 'tea rooms', 'brunch spot'],
  drinks: ['bar', 'bars', 'pub', 'pubs', 'cocktail', 'cocktails', 'wine', 'wine bar', 'beer', 'brewery', 'taproom', 'rooftop bar', 'rooftop bars', 'drinks', 'gin'],
  nightlife: ['club', 'clubs', 'nightclub', 'nightclubs', 'nightlife', 'clubbing', 'dance', 'rave'],
  tourist: ['museum', 'museums', 'gallery', 'galleries', 'landmark', 'landmarks', 'attraction', 'attractions', 'history', 'historic', 'culture', 'cultural', 'sightseeing', 'exhibition', 'cathedral', 'church'],
  scenic: ['park', 'parks', 'garden', 'gardens', 'walk', 'walks', 'walking', 'viewpoint', 'view', 'views', 'waterfront', 'beach', 'trail', 'outdoors', 'nature', 'scenic'],
}

// ── Event signals ──
const EVENT_KEYWORDS = ['live music', 'gig', 'gigs', 'concert', 'concerts', 'event', 'events', 'whats on', "what's on", 'what is on', 'live band', 'bands', 'dj', 'comedy', 'theatre', 'theater', 'show', 'shows', 'festival', 'gig tonight', 'performance', 'nightlife tonight']

// ── Itinerary signals (multi-part outings) ──
const ITINERARY_KEYWORDS = ['date night', 'night out', 'day out', 'plan', 'itinerary', 'evening out', 'day trip', 'perfect day', 'perfect evening', 'romantic evening']
// "X then Y" phrasing → multi-stop
const THEN_PATTERN = /\b(then|followed by|after that|and then)\b/i

// ── Surprise / no-idea signals ──
const SURPRISE_KEYWORDS = ['surprise me', "i'm bored", 'im bored', 'bored', 'anything', 'whatever', 'no idea', 'dunno', 'something fun', 'surprise', 'random', 'spontaneous']

// ── Broad discovery signals ──
const DISCOVERY_KEYWORDS = ['things to do', 'to do', 'what to do', 'stuff to do', 'activities', 'out out', 'go out', 'day out ideas', 'explore']

// ── "Best / top" → ranked ──
const RANKED_PATTERN = /\b(best|top|greatest|finest|highest rated|nicest|coolest|must visit|must see)\b/i

// ── Vibe words (colour results; don't change primary intent) ──
const VIBE_KEYWORDS = {
  romantic: ['romantic', 'date', 'intimate', 'cosy', 'cozy'],
  lively: ['lively', 'buzzing', 'fun', 'party', 'vibrant'],
  chill: ['chill', 'relaxed', 'quiet', 'laid back', 'peaceful'],
  cheap: ['cheap', 'budget', 'affordable', 'inexpensive'],
  fancy: ['fancy', 'upmarket', 'classy', 'fine dining', 'posh', 'luxury'],
}

// ── Time signals ──
const TIME_SENSITIVE = ['tonight', 'now', 'today', 'this evening', 'right now', 'this weekend', 'tomorrow']

function norm(s) {
  return ' ' + String(s || '').toLowerCase().replace(/[''`]/g, "'").replace(/\s+/g, ' ').trim() + ' '
}
function hasAny(haystack, arr) {
  for (const w of arr) if (haystack.includes(' ' + w + ' ') || haystack.includes(w)) return w
  return null
}

function classifyIntent(rawQuery) {
  const raw = String(rawQuery || '').trim()
  const s = norm(raw)
  const wordCount = raw ? raw.split(/\s+/).length : 0

  const result = {
    raw,
    cleaned: raw.toLowerCase().trim(),
    intent: 'place_category',
    categories: [],
    vibe: null,
    ranked: false,
    timeSensitive: false,
    needsAI: false,
  }
  if (!raw) { result.intent = 'empty'; return result }

  // Time + vibe are orthogonal signals — capture them regardless of intent.
  result.timeSensitive = !!hasAny(s, TIME_SENSITIVE)
  for (const [vibe, words] of Object.entries(VIBE_KEYWORDS)) {
    if (hasAny(s, words)) { result.vibe = vibe; break }
  }
  result.ranked = RANKED_PATTERN.test(s)

  // ── Priority order matters: most specific / decisive first ──

  // 1. Surprise ("I'm bored") → hand to Sappo.
  if (hasAny(s, SURPRISE_KEYWORDS)) { result.intent = 'surprise'; return result }

  // 2. Explicit itinerary phrasing, or "X then Y" multi-stop.
  if (hasAny(s, ITINERARY_KEYWORDS) || THEN_PATTERN.test(s)) {
    result.intent = 'itinerary'
    // Pull any categories mentioned so the planner has hints.
    for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) if (hasAny(s, words)) result.categories.push(cat)
    return result
  }

  // 3. Events.
  if (hasAny(s, EVENT_KEYWORDS)) { result.intent = 'events'; return result }

  // 4. Broad discovery ("things to do").
  if (hasAny(s, DISCOVERY_KEYWORDS)) { result.intent = 'mixed_discovery'; return result }

  // 5. Category place search (pizza, coffee, bars, rooftop bar…).
  const cats = []
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (hasAny(s, words)) cats.push(cat)
  }
  if (cats.length) {
    result.categories = cats
    result.intent = result.ranked ? 'ranked_places' : 'place_category'
    // NOTE: a query like "Sefton Park" matches a category keyword ("park") but
    // is ALSO a specific venue name. The classifier can't know that (it reads no
    // DB by design). The search endpoint resolves this: it runs the venue
    // name-search anyway, and if there's a strong exact name match, the venue
    // wins over the category. So category here is a HINT, not a final answer.
    result.maybeVenueName = wordCount <= 4
    return result
  }

  // 6. Nothing matched a known signal.
  //    - Short (1–3 words) → probably a specific VENUE NAME; let /search handle it.
  //    - Longer / natural language → genuinely ambiguous → flag for AI.
  if (wordCount <= 3) {
    result.intent = 'venue_lookup'
  } else {
    result.intent = 'mixed_discovery'   // safe default: show a blend
    result.needsAI = true               // …but this one would benefit from AI reasoning
  }
  return result
}

module.exports = { classifyIntent, CATEGORY_KEYWORDS, EVENT_KEYWORDS }
