// src/services/qualityScore.js
// Quality scoring for Sappo Roulette venues.
//
// Design principles (these are the whole point of this module):
//
//  1. REWARD known-good.   A 4.6★ with lots of reviews should rise.
//  2. PENALISE known-bad.  A 2.4★ with lots of reviews should SINK — not
//                          merely score "a bit less". Quality > Novelty > Distance
//                          only works if genuinely poor places drop out of the pool.
//  3. NEVER punish missing data. A venue with rating = null hasn't been
//                          enriched yet (Google coverage is ~83% in Liverpool,
//                          less elsewhere). "No rating" is NOT "bad rating".
//                          Missing data scores NEUTRAL (0), so an un-enriched
//                          real gem isn't thrown away for a data gap.
//  4. DAMPEN thin signals. 4.9★ from 3 reviews is noise, not excellence.
//                          Confidence scales with review volume, so a high
//                          rating on a handful of reviews is pulled toward
//                          neutral until enough reviews back it up.
//
// Returns a signed contribution (can be negative) plus an optional reason
// string for the user-facing "why" line. The route adds `score += result.score`.

// Where the rating scale pivots: at/above this, ratings add points; below it,
// they subtract. 3.6 sits deliberately below the "good" band so that only
// genuinely weak venues (sub-3.6) are penalised, while the broad middle
// (3.6–4.1) is roughly neutral and the good band (4.2+) is rewarded.
const RATING_PIVOT = 3.6

// Rating headroom above/below the pivot is worth this many points per star.
const POINTS_PER_STAR = 22

// Hard clamps so rating can't dominate the whole score.
const RATING_MAX = 26     // best possible rating contribution (~5.0★, confident)
const RATING_MIN = -40    // worst possible (a confidently-known bad venue sinks hard)

// Review-volume confidence: how much we trust the rating.
// 0 reviews → 0 confidence (rating ignored). Confidence ramps up and saturates
// near CONFIDENCE_FULL reviews. This is what dampens the "4.9 from 3 reviews" trap.
const CONFIDENCE_FULL = 60   // aligns with the spec's "50+ reviews" quality bar

// Separate, always-positive bonus for review VOLUME itself (popularity/trust),
// independent of the rating value. Capped so a mega-popular place doesn't run away.
const VOLUME_MAX = 8
const VOLUME_SCALE = 350    // reviews per point (matches prior behaviour)

// Compute a 0..1 confidence weight from review count.
function ratingConfidence(reviewCount) {
  const n = Number(reviewCount) || 0
  if (n <= 0) return 0
  // Smooth saturating curve: n / (n + K) style, tuned so ~60 reviews ≈ 0.75,
  // ~180 ≈ 0.9, and it approaches 1 for very well-reviewed venues.
  const K = CONFIDENCE_FULL * 0.33
  return n / (n + K)
}

// Main entry point.
// v: venue row with .rating (0–5 or null) and .rating_count (int or null).
// Returns { score, reason }.
function qualityScore(v) {
  const rating = (v.rating == null || v.rating === '') ? null : Number(v.rating)
  const reviewCount = Number(v.rating_count) || 0

  let score = 0
  let reason = null

  // ── Rating contribution (confidence-weighted, signed) ──
  // Missing rating → contributes exactly 0 (neutral). This is principle #3.
  if (rating != null && !Number.isNaN(rating)) {
    const confidence = ratingConfidence(reviewCount)
    const raw = (rating - RATING_PIVOT) * POINTS_PER_STAR
    let contribution = raw * confidence
    contribution = Math.max(RATING_MIN, Math.min(RATING_MAX, contribution))
    score += contribution

    // Reasons only for genuinely strong, well-backed venues.
    if (rating >= 4.4 && reviewCount >= 50) reason = 'highly rated'
    else if (rating >= 4.2 && reviewCount >= 150) reason = 'well loved'
  }

  // ── Review-volume bonus (always ≥ 0; popularity/trust signal) ──
  score += Math.min(reviewCount / VOLUME_SCALE, VOLUME_MAX)

  return { score, reason }
}

// Should this venue be hard-dropped on quality grounds?
// VERY conservative: only drops venues we KNOW are bad (real rating below the
// floor, backed by enough reviews to trust it). Missing data is never dropped.
const HARD_DROP_RATING = 3.0
const HARD_DROP_MIN_REVIEWS = 30
function isKnownPoorQuality(v) {
  const rating = (v.rating == null || v.rating === '') ? null : Number(v.rating)
  if (rating == null || Number.isNaN(rating)) return false        // no data → never drop
  const reviewCount = Number(v.rating_count) || 0
  return rating < HARD_DROP_RATING && reviewCount >= HARD_DROP_MIN_REVIEWS
}

module.exports = {
  qualityScore,
  ratingConfidence,
  isKnownPoorQuality,
  RATING_PIVOT,
  HARD_DROP_RATING,
  HARD_DROP_MIN_REVIEWS,
}
