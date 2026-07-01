// src/services/sappoScore.js
// The formal Sappo Roulette scoring model.
//
// Replaces the old flat "score += N" pile with the spec's weighted model:
//
//     SappoScore = 30% Quality
//                + 25% Uniqueness
//                + 20% Vibe / User match
//                + 15% Proximity
//                + 10% Trending / event strength
//
// Each bucket is computed on its OWN 0..100 scale, then combined by weight,
// so the final score is always 0..100 and the ordering "Quality > Novelty >
// Distance" is enforced by the weights themselves rather than by hand-tuned
// point values that happened to line up.
//
// HARD GATES (category mismatch, closed, too far, known-poor, vibe block) are
// NOT handled here — the route rejects those before scoring. This module only
// ranks candidates that already passed the gates.
//
// Budget and anti-repetition are applied by the route as post-adjustments,
// because they are preferences/penalties rather than quality dimensions.

const { qualityScore } = require('./qualityScore')
const { detectChain } = require('./chainDetection')

const WEIGHTS = {
  quality: 0.30,
  uniqueness: 0.25,
  vibe: 0.20,
  proximity: 0.15,
  trending: 0.10,
}

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x))

// ── Quality bucket (0..100) ──
// Built on qualityScore's signed output (roughly -40..+34), remapped onto
// 0..100 with 50 = neutral/unknown. Missing data lands at ~50 (neutral),
// good venues climb, known-mediocre sink — WITHOUT ever going below the pool.
function qualityBucket(v) {
  const q = qualityScore(v)           // { score, reason }
  // qualityScore.score empirically spans ~[-40, +34]; map to 0..100 with a
  // neutral midpoint at 50 so "no rating yet" (score 0) → 50, not 0.
  const bucket = clamp(50 + q.score * 1.4)
  return { value: bucket, reason: q.reason }
}

// ── Uniqueness bucket (0..100) ──
// Independent + hidden-gem signals push UP; chains crush it. This is where
// "prefer characterful local places" lives.
function uniquenessBucket(v, { mode, allowChains }) {
  let u = 55                          // baseline: assume moderately distinctive
  const reviewCount = Number(v.rating_count) || 0
  const rating = Number(v.rating) || 0

  // Hidden-gem shape: well-rated but not mega-reviewed = feels like a find.
  if (reviewCount > 0 && reviewCount < 800 && rating >= 4.2) u += 25
  // Very high review counts read as "obvious / touristy", less unique.
  if (reviewCount > 3000) u -= 20
  else if (reviewCount > 1500) u -= 10

  // Independent bonus vs chain penalty (unless chains are explicitly wanted).
  const chain = detectChain(v.name)
  const penaliseChain = chain.isChain && !allowChains
  if (penaliseChain) u -= 70          // a chain is the opposite of unique
  else if (!chain.isChain) u += 8     // small nudge for being independent

  // In hidden_gem mode, lean harder into the uniqueness signal.
  if (mode === 'hidden_gem') {
    if (reviewCount > 0 && reviewCount < 500 && rating >= 4.3) u += 12
    if (reviewCount > 2500) u -= 15
  }

  let reason = null
  if (!chain.isChain && reviewCount > 0 && reviewCount < 800 && rating >= 4.3) reason = 'feels like a hidden gem'
  return { value: clamp(u), isChain: chain.isChain, reason }
}

// ── Vibe / user-match bucket (0..100) ──
// How well the venue fits the requested mode + vibe, plus personalisation
// (behaviour learning, planner boosts). The route computes the sub-signals
// (it owns the vibe/mode/learning helpers) and passes them in.
function vibeBucket({ modeMatch, vibeBoost, learning, plannerBoost }) {
  let val = 45                        // neutral baseline
  if (modeMatch) val += 25            // venue is squarely in the requested mode
  val += (vibeBoost || 0) * 1.4       // vibeCheckCandidate boost (0..12ish)
  val += Math.min(learning || 0, 20)  // behaviour-learning signal, capped
  val += Math.min(plannerBoost || 0, 10)
  return clamp(val)
}

// ── Proximity bucket (0..100) ──
// Smooth decay scaled to the user's chosen radius. At the venue's exact
// location → ~100; at the chosen radius → ~55; beyond it tapers but never
// cliffs (the route's outer gate handles "too far"). This is the distance-
// weighting we agreed on: closer favoured, great-further-away can still win.
function proximityBucket(km, radiusKm) {
  if (km == null) return { value: 55 }   // unknown distance → neutral-ish
  const r = Math.max(0.2, radiusKm || 1.6)
  // Exponential decay with half-value near the chosen radius.
  const decayed = 100 * Math.exp(-0.6 * (km / r))
  return { value: clamp(decayed) }
}

// ── Trending bucket (0..100) ──
// Popularity / momentum. Real "trending" (events, saves velocity) comes later;
// for now we proxy it with review volume (well-trodden = currently relevant)
// and any positive learning signal, kept deliberately light (10% weight).
function trendingBucket(v, { learning }) {
  const reviewCount = Number(v.rating_count) || 0
  // log-ish ramp: 0 rev → 40, ~200 → 70, ~1000+ → ~90
  const volScore = reviewCount <= 0 ? 40 : clamp(40 + 18 * Math.log10(reviewCount + 1))
  const learnBump = Math.min(Math.max(learning || 0, 0), 10)
  return { value: clamp(volScore + learnBump) }
}

// ── Combine ──
// Returns { score (0..100), buckets:{...}, reasons:[...] }.
// `ctx` carries the route-computed sub-signals so this module stays pure.
function computeSappoScore(v, ctx) {
  const {
    mode, km, radiusKm, allowChains = false,
    modeMatch = false, vibeBoost = 0, learning = 0, plannerBoost = 0,
  } = ctx || {}

  const quality = qualityBucket(v)
  const uniqueness = uniquenessBucket(v, { mode, allowChains })
  const vibe = vibeBucket({ modeMatch, vibeBoost, learning, plannerBoost })
  const proximity = proximityBucket(km, radiusKm)
  const trending = trendingBucket(v, { learning })

  const score =
    quality.value * WEIGHTS.quality +
    uniqueness.value * WEIGHTS.uniqueness +
    vibe * WEIGHTS.vibe +
    proximity.value * WEIGHTS.proximity +
    trending.value * WEIGHTS.trending

  const reasons = []
  if (quality.reason) reasons.push(quality.reason)
  if (uniqueness.reason) reasons.push(uniqueness.reason)

  return {
    score,                              // 0..100
    isChain: uniqueness.isChain,
    buckets: {
      quality: Math.round(quality.value),
      uniqueness: Math.round(uniqueness.value),
      vibe: Math.round(vibe),
      proximity: Math.round(proximity.value),
      trending: Math.round(trending.value),
    },
    reasons,
  }
}

module.exports = { computeSappoScore, WEIGHTS }
