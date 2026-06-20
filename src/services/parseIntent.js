// src/services/parseIntent.js
// Fast keyword-based parsing of a user's request into structured intent.
// Detects categories, vibe, budget, group, timing, crowd preference, and any city mention.
// (Gemini is used later for the actual plan; this is the cheap first pass.)

const { CITIES } = require('../config')
const { detectSearchIntent } = require('./decisionRules')

// category keyword → venue category_slug
const CATEGORY_KEYWORDS = {
  restaurant: ['food', 'eat', 'dinner', 'lunch', 'restaurant', 'burger', 'burgers', 'pizza', 'curry', 'steak', 'brunch', 'meal', 'dining', 'tapas', 'sushi', 'ramen'],
  cafe: ['coffee', 'cafe', 'café', 'breakfast', 'cake', 'tea', 'brunch'],
  bar: ['cocktail', 'cocktails', 'bar', 'drinks', 'wine', 'gin'],
  pub: ['pub', 'pint', 'pints', 'beer', 'ale', 'boozer'],
  nightclub: ['club', 'clubbing', 'nightclub', 'dance', 'rave', 'dancing'],
  music_venue: ['live music', 'gig', 'band', 'karaoke', 'concert', 'music venue', 'jazz', 'music'],
  comedy: ['comedy', 'stand up', 'stand-up', 'laughs'],
  event: ['event', 'events', "what's on", 'whats on', 'gig', 'gigs', 'concert', 'concerts', 'show', 'shows', 'theatre', 'festival'],
  // tourist / traveller categories
  museum: ['museum', 'exhibition', 'history', 'historical', 'culture', 'cultural'],
  gallery: ['gallery', 'art', 'galleries', 'exhibit'],
  landmark: ['landmark', 'landmarks', 'cathedral', 'church', 'monument', 'heritage', 'sights', 'sightseeing', 'iconic'],
  park: ['park', 'parks', 'gardens', 'green space', 'nature', 'outdoors', 'lake', 'lakes', 'waterside', 'waterfront'],
  attraction: ['attraction', 'attractions', 'things to do', 'tourist', 'explore', 'views', 'viewpoint', 'scenic'],
}

// vibe keywords → planner mode
const VIBE_KEYWORDS = {
  chilled: ['chilled', 'chill', 'relaxed', 'quiet', 'cosy', 'cozy', 'laid back', 'low key', 'easy'],
  chaos: ['chaos', 'wild', 'messy', 'big night', 'mad', 'crazy', 'lively', 'party'],
  cheap: ['cheap', 'budget', 'student', 'skint', 'affordable'],
  date_night: ['date', 'romantic', 'date night', 'anniversary'],
  hidden_gems: ['hidden', 'gems', 'local', 'authentic', 'off the beaten', 'underrated'],
  stag_hen: ['stag', 'hen', 'bachelor', 'bachelorette'],
}

const BUDGET_KEYWORDS = {
  cheap: ['cheap', 'budget', 'student', 'skint', 'under £20', 'under £25', 'under £30', 'affordable'],
  premium: ['treat', 'fancy', 'posh', 'splurge', 'high end', 'luxury', 'nice place', 'special'],
}

function parseIntent(message = '') {
  const text = message.toLowerCase()
  const intent = {
    categories: [], vibe: null, budget: null, busyPref: null,
    timing: null, group: null, cityMention: null, raw: message, searchIntent: null, strict: false,
  }

  // categories (collect all that match)
  for (const [cat, words] of Object.entries(CATEGORY_KEYWORDS)) {
    if (words.some(w => text.includes(w))) intent.categories.push(cat)
  }
  // special: karaoke is its own strong signal even though it maps to music_venue
  if (/karaoke/.test(text) && !intent.categories.includes('music_venue')) intent.categories.push('music_venue')

  intent.searchIntent = detectSearchIntent(message, intent)
  intent.strict = !!intent.searchIntent

  // vibe
  for (const [vibe, words] of Object.entries(VIBE_KEYWORDS)) {
    if (words.some(w => text.includes(w))) { intent.vibe = vibe; break }
  }

  // budget
  for (const [b, words] of Object.entries(BUDGET_KEYWORDS)) {
    if (words.some(w => text.includes(w))) { intent.budget = b; break }
  }
  // explicit £ amount → cheap/comfortable/premium
  const money = text.match(/£\s?(\d{1,3})/)
  if (money) {
    const amt = parseInt(money[1])
    intent.budgetPerPerson = amt
    if (amt <= 30) intent.budget = 'cheap'
    else if (amt >= 70) intent.budget = 'premium'
    else intent.budget = 'moderate'
  }

  // crowd preference
  if (/not too busy|quiet|avoid crowds|not packed|chilled/.test(text)) intent.busyPref = 'avoid'
  else if (/lively|busy|buzzing|packed|atmosphere/.test(text)) intent.busyPref = 'lively'

  // timing
  if (/tonight|today/.test(text)) intent.timing = 'tonight'
  else if (/tomorrow/.test(text)) intent.timing = 'tomorrow'
  else if (/weekend|saturday|sunday|friday/.test(text)) intent.timing = 'weekend'

  // group
  if (/date|romantic/.test(text)) intent.group = 'couple'
  else if (/stag|hen|lads|girls|mates|group|us\b|we\b/.test(text)) intent.group = 'group'
  else if (/family|kids|children/.test(text)) intent.group = 'family'

  // city mention — match any known city name in the message
  for (const [key, c] of Object.entries(CITIES)) {
    const name = (c.name || key).toLowerCase()
    if (text.includes(name)) { intent.cityMention = c.name; break }
  }

  return intent
}

// What's still genuinely missing — used to decide follow-up questions (max 1-2).
function missingInfo(intent) {
  const missing = []
  if (!intent.timing) missing.push('timing')
  if (!intent.budget && !intent.budgetPerPerson) missing.push('budget')
  return missing
}

module.exports = { parseIntent, missingInfo }
