// src/services/gemTags.js
// Derive durable "gem tags" from venue review text.
//
// The app stores review SAMPLES (google_review_sample, tripadvisor_top_review).
// This module reads that text and derives a small set of metadata tags
// (hidden_gem, local_favourite, romantic, great_cocktails, …). Per the spec and
// good data hygiene, we output ONLY derived tags + evidence counts — we never
// persist the raw review text from here.
//
// Matching discipline (mirrors chainDetection): word-boundary aware, negation-
// aware ("not cosy" must not count as cosy), and threshold-gated so a single
// stray word can't mislabel a venue.

// ── Signal lexicon ──
// Each tag maps to phrases whose presence in reviews is evidence FOR that tag.
// Phrases are matched as whole words/phrases, case-insensitive.
const TAG_SIGNALS = {
  hidden_gem:      ['hidden gem', 'hidden treasure', 'best kept secret', 'tucked away', 'off the beaten track', 'you would never know', 'underrated', 'unassuming'],
  local_favourite: ['local favourite', 'local favorite', 'locals love', 'where the locals', 'popular with locals', 'a local institution', 'neighbourhood favourite', 'regulars'],
  authentic:       ['authentic', 'traditional', 'the real deal', 'genuine', 'proper'],
  independent:     ['independent', 'family run', 'family-run', 'family owned', 'independently owned', 'small business', 'owner run'],
  cosy:            ['cosy', 'cozy', 'snug', 'intimate', 'homely', 'warm atmosphere', 'welcoming'],
  romantic:        ['romantic', 'date night', 'perfect for a date', 'intimate', 'candlelit', 'special occasion'],
  great_atmosphere:['great atmosphere', 'lovely atmosphere', 'amazing atmosphere', 'buzzing', 'great vibe', 'brilliant atmosphere', 'wonderful ambiance', 'ambience'],
  great_cocktails: ['great cocktails', 'amazing cocktails', 'best cocktails', 'fantastic cocktails', 'cocktail menu', 'creative cocktails'],
  great_coffee:    ['great coffee', 'best coffee', 'amazing coffee', 'excellent coffee', 'proper coffee', 'flat white'],
  great_food:      ['amazing food', 'incredible food', 'delicious', 'best meal', 'fantastic food', 'food was excellent', 'mouth watering', 'mouthwatering'],
  great_views:     ['great views', 'amazing views', 'stunning views', 'beautiful views', 'view of', 'overlooking', 'panoramic'],
  quirky:          ['quirky', 'unique', 'unusual', 'eclectic', 'characterful', 'full of character', 'one of a kind'],
  friendly_staff:  ['friendly staff', 'lovely staff', 'staff were great', 'welcoming staff', 'attentive staff', 'wonderful service', 'brilliant service'],
  family_friendly: ['family friendly', 'family-friendly', 'great for kids', 'kids loved', 'good for children', 'child friendly'],
  good_for_groups: ['good for groups', 'great for groups', 'big group', 'group of us', 'perfect for groups'],
  worth_visiting:  ['worth visiting', 'worth a visit', 'must visit', 'must-visit', 'highly recommend', 'cannot recommend enough', 'a must'],
  beautiful:       ['beautiful', 'gorgeous', 'stunning', 'picturesque', 'charming'],
}

// ── Negative signals (evidence AGAINST quality / for tourist-trap-ness) ──
// These don't create positive tags; they can produce a caution flag and
// suppress positive tags when strongly present.
const NEGATIVE_SIGNALS = {
  tourist_trap: ['tourist trap', 'overrated', 'not worth', 'waste of money', 'overpriced for what'],
  overpriced:   ['overpriced', 'too expensive', 'expensive for', 'rip off', 'rip-off', 'pricey for'],
  poor_service: ['poor service', 'rude staff', 'terrible service', 'slow service', 'ignored us', 'unfriendly'],
  generic:      ['generic', 'bland', 'nothing special', 'average at best', 'forgettable', 'soulless'],
  crowded:      ['too crowded', 'overcrowded', 'long queues', 'long wait', 'packed and'],
  dirty:        ['dirty', 'unclean', 'filthy', 'grubby', 'not clean'],
}

// Negation words that, appearing just before a signal phrase, invert it.
const NEGATORS = ['not', 'no', "n't", 'never', 'hardly', 'barely', 'wasnt', 'wasn', 'isnt', 'isn', 'without', 'lacking', 'lacked']

function normaliseText(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Count non-negated occurrences of a phrase in normalised text.
function countPhrase(text, phrase) {
  const p = phrase.toLowerCase()
  let count = 0, idx = 0
  const padded = ` ${text} `
  const needle = ` ${p} `
  // Also allow phrase at boundaries via word-boundary regex for single words.
  if (!p.includes(' ')) {
    const re = new RegExp(`${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')
    let m
    while ((m = re.exec(text)) !== null) {
      // Whole-word check: chars either side must be word boundaries.
      const start = m.index, end = m.index + p.length
      const prevChar = start > 0 ? text[start - 1] : ' '
      const nextChar = end < text.length ? text[end] : ' '
      if (/[a-z0-9']/.test(prevChar) || /[a-z0-9']/.test(nextChar)) continue  // substring, skip
      const preWords = text.slice(Math.max(0, start - 30), start).trim().split(/\s+/).slice(-3)
      if (!preWords.some(w => NEGATORS.includes(w))) count++
    }
    return count
  }
  // Multi-word phrase: substring scan with a negation look-back over the
  // preceding few words (so "not a hidden gem" is caught, not just "not gem").
  while ((idx = padded.indexOf(needle, idx)) !== -1) {
    const preWords = padded.slice(Math.max(0, idx - 30), idx).trim().split(/\s+/).slice(-3)
    const negated = preWords.some(w => NEGATORS.includes(w))
    if (!negated) count++
    idx += needle.length - 1
  }
  return count
}

// Extract an array of review text strings from stored venue fields.
// Accepts the venue row; reads google_review_sample (array) and
// tripadvisor_top_review (single). Tolerant of JSON stored as string.
function extractReviewTexts(venue) {
  const texts = []
  const parse = (val, fallback) => {
    if (val == null) return fallback
    if (typeof val === 'object') return val
    try { return JSON.parse(val) } catch { return fallback }
  }
  const g = parse(venue.google_review_sample, [])
  if (Array.isArray(g)) for (const r of g) { if (r && r.text) texts.push(String(r.text)) }
  const ta = parse(venue.tripadvisor_top_review, null)
  if (ta && ta.text) texts.push(String(ta.text))
  return texts
}

// Derive tags from a set of review texts.
// Returns { tags: [...], evidence: {tag: count}, cautions: [...], reviewsSeen }.
// minHits: how many total signal occurrences (across all reviews) a tag needs.
function deriveTagsFromTexts(texts, { minHits = 2 } = {}) {
  const joined = texts.map(normaliseText).filter(Boolean)
  const reviewsSeen = joined.length
  const evidence = {}
  const cautionEvidence = {}

  if (reviewsSeen === 0) return { tags: [], evidence: {}, cautions: [], reviewsSeen: 0 }

  const blob = joined.join(' . ')

  for (const [tag, phrases] of Object.entries(TAG_SIGNALS)) {
    let hits = 0
    for (const phrase of phrases) hits += countPhrase(blob, phrase)
    if (hits > 0) evidence[tag] = hits
  }
  for (const [flag, phrases] of Object.entries(NEGATIVE_SIGNALS)) {
    let hits = 0
    for (const phrase of phrases) hits += countPhrase(blob, phrase)
    if (hits > 0) cautionEvidence[flag] = hits
  }

  // With few reviews, require fewer hits (1); with many, require more, so a
  // single word in a big pile of reviews doesn't earn a tag.
  const threshold = reviewsSeen <= 2 ? 1 : minHits

  const tags = Object.entries(evidence)
    .filter(([, hits]) => hits >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)

  const cautions = Object.entries(cautionEvidence)
    .filter(([, hits]) => hits >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([flag]) => flag)

  // Strong negative signal suppresses the soft "hidden_gem"/"beautiful" glow.
  if (cautions.includes('tourist_trap') || cautions.includes('generic')) {
    const i = tags.indexOf('hidden_gem'); if (i >= 0) tags.splice(i, 1)
  }

  return { tags: tags.slice(0, 8), evidence, cautions, reviewsSeen }
}

// Convenience: derive directly from a venue row.
function deriveTagsForVenue(venue, opts) {
  return deriveTagsFromTexts(extractReviewTexts(venue), opts)
}

module.exports = {
  TAG_SIGNALS,
  NEGATIVE_SIGNALS,
  deriveTagsFromTexts,
  deriveTagsForVenue,
  extractReviewTexts,
  countPhrase,
  normaliseText,
}
