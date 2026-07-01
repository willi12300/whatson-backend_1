// src/services/chainDetection.js
// Chain / franchise detection for Sappo Roulette.
//
// Philosophy: chains are PENALISED, never hard-rejected — so a user who
// explicitly asks for a chain (or a mode that legitimately wants one) can
// still receive it. Roulette's quality bar is "prefer independent, local,
// characterful places", not "chains are forbidden".
//
// Matching is deliberately conservative: we match on normalised name tokens
// with word-boundary awareness so we don't accidentally flag an independent
// venue whose name merely CONTAINS a chain word (e.g. "The Gregory Arms"
// must not match "greggs"; "Pizza Loco" must not match "pizza express").

// ── The blacklist ──
// Each entry is a lower-case chain identifier. Grouped only for readability;
// the code flattens them. Add freely over time — this is the single source
// of truth. Keep entries as the DISTINCTIVE part of the brand name.
const CHAIN_BRANDS = [
  // Coffee
  'starbucks', 'costa coffee', 'costa', 'caffe nero', 'cafe nero', 'nero',
  'greggs', 'pret a manger', 'pret', 'coffee republic', 'esquires',

  // Fast food / burgers
  'mcdonalds', 'burger king', 'kfc', 'subway', 'dominos', 'pizza hut',
  'papa johns', 'five guys', 'wendys', 'popeyes', 'taco bell',
  'leon', 'gourmet burger kitchen', 'gbk', 'byron', 'honest burgers',

  // Casual dining chains
  'nandos', 'wagamama', 'tgi fridays', 'tgi friday', 'fridays',
  'hard rock cafe', 'frankie and bennys', 'frankie bennys',
  'bella italia', 'zizzi', 'ask italian', 'prezzo', 'pizza express',
  'cafe rouge', 'las iguanas', 'chiquito', 'harvester', 'toby carvery',
  'beefeater', 'brewers fayre', 'miller and carter', 'wetherspoon',
  'wetherspoons', 'jd wetherspoon', 'slug and lettuce', 'all bar one',
  'yates', 'walkabout', 'revolution', 'be at one', 'turtle bay',
  'cosy club', 'wildwood', 'giraffe', 'yo sushi', 'itsu', 'wasabi',
  'tortilla', 'chipotle', 'chopstix', 'wok to walk',

  // Pubs / bars (managed estate chains)
  'greene king', 'stonegate', 'sizzling pubs', 'ember inns',
  'vintage inns', 'hungry horse', 'flaming grill',

  // Dessert / misc
  'krispy kreme', 'dunkin', 'baskin robbins', 'creams', 'kaspas',
  'heavenly desserts', 'shakeaway',
]

// Multi-word brands must match as a phrase; single-word brands match as a
// whole token. We pre-split into the two buckets for fast, safe matching.
const _multiWord = []
const _singleWord = new Set()
for (const brand of CHAIN_BRANDS) {
  const b = brand.trim().toLowerCase()
  if (b.includes(' ')) _multiWord.push(b)
  else _singleWord.add(b)
}

// Normalise a name to a space-delimited token string for matching.
// Mirrors helpers.normaliseName but kept local so this module is standalone
// and its matching rules can evolve independently of dedupe normalisation.
function _norm(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Returns { isChain: boolean, brand: string|null }.
// Word-boundary safe: single-word brands match a whole token only; multi-word
// brands match as a contiguous phrase surrounded by boundaries.
function detectChain(name) {
  const norm = _norm(name)
  if (!norm) return { isChain: false, brand: null }

  const padded = ` ${norm} `
  // Multi-word phrases first (more specific).
  for (const phrase of _multiWord) {
    if (padded.includes(` ${phrase} `)) return { isChain: true, brand: phrase }
  }
  // Single-word tokens.
  const tokens = norm.split(' ')
  for (const t of tokens) {
    if (_singleWord.has(t)) return { isChain: true, brand: t }
  }
  return { isChain: false, brand: null }
}

// Convenience boolean.
function isChain(name) {
  return detectChain(name).isChain
}

// Whether a given roulette mode legitimately wants chains surfaced.
// Currently none do by default — but this is the single hook to change that,
// e.g. if you ever add a "quick bite" or "familiar" mode.
function modeAllowsChains(mode, opts = {}) {
  if (opts.allowChains === true) return true          // explicit per-request override
  return false
}

// The penalty applied to a chain's SappoScore-style score when it is NOT
// explicitly wanted. Large enough to sink a chain beneath any comparable
// independent venue, small enough that a chain can still surface if it is
// genuinely the only reasonable option nearby (better a Nando's than an
// empty spin).
const CHAIN_PENALTY = -60

module.exports = {
  CHAIN_BRANDS,
  detectChain,
  isChain,
  modeAllowsChains,
  CHAIN_PENALTY,
}
