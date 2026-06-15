// src/services/scoreVenues.js
// The recommendation engine. Takes verified DB venues + structured intent + live
// context, and returns a SCORED, FILTERED, VARIED shortlist. Gemini never picks
// venues — it only writes up the shortlist this produces.

const { estimateBusy } = require('./busyEstimate')
const { spendFor } = require('./costEstimate')

// keyword → category, plus free-text keywords we match against venue name
const CATEGORY_KEYWORDS = {
  restaurant: ['food', 'eat', 'dinner', 'lunch', 'restaurant', 'burger', 'pizza', 'curry', 'steak', 'brunch', 'meal', 'tapas', 'sushi', 'ramen', 'thai', 'italian', 'indian'],
  cafe: ['coffee', 'cafe', 'café', 'breakfast', 'cake', 'tea'],
  bar: ['cocktail', 'bar', 'drinks', 'wine', 'gin'],
  pub: ['pub', 'pint', 'beer', 'ale'],
  nightclub: ['club', 'clubbing', 'nightclub', 'dance', 'rave'],
  music_venue: ['live music', 'gig', 'band', 'karaoke', 'concert', 'jazz'],
  comedy: ['comedy', 'stand up', 'stand-up'],
}

// Distance helper (km)
function haversineKm(a, b, c, d) {
  if ([a, b, c, d].some(x => x == null)) return null
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Is the venue open at `when`? Returns true/false/null(unknown) from Google hours.
function isOpenAt(openingHours, when) {
  try {
    const oh = typeof openingHours === 'string' ? JSON.parse(openingHours) : openingHours
    const periods = oh?.periods
    if (!Array.isArray(periods) || !periods.length) return null
    const day = when.getDay()           // 0=Sun
    const hm = when.getHours() * 100 + when.getMinutes()
    for (const p of periods) {
      if (p.open?.day === day) {
        const o = p.open.hour * 100 + (p.open.minute || 0)
        const c = p.close ? p.close.hour * 100 + (p.close.minute || 0) : 2400
        if (hm >= o && hm <= c) return true
      }
    }
    return false
  } catch { return null }
}

// freetext keyword match against a venue name (e.g. "burger" → "Burger & Beyond")
function keywordHits(raw, venue) {
  if (!raw) return 0
  const name = (venue.name || '').toLowerCase()
  const words = raw.toLowerCase().match(/[a-z]{3,}/g) || []
  const stop = new Set(['the', 'and', 'for', 'with', 'near', 'place', 'night', 'out', 'some', 'good', 'want', 'this', 'that', 'plan', 'tonight', 'today'])
  let hits = 0
  for (const w of words) { if (!stop.has(w) && name.includes(w)) hits++ }
  return hits
}

/**
 * Score & rank venues.
 * @param venues  verified DB rows (already filtered to the right CITY upstream)
 * @param intent  { categories[], vibe, budget, budgetPerPerson, busyPref, raw, ... }
 * @param ctx     { lat, lng, when, weather, recentlyShownIds:Set, events[] }
 * @returns { ranked:[{venue, score, reasons[], rejected, rejectReason}], debug }
 */
function scoreVenues(venues, intent = {}, ctx = {}) {
  const when = ctx.when || new Date()
  const wantCats = new Set(intent.categories || [])
  const recentlyShown = ctx.recentlyShownIds instanceof Set ? ctx.recentlyShownIds : new Set(ctx.recentlyShownIds || [])
  const wantsHidden = intent.vibe === 'hidden_gems'

  const scored = venues.map(v => {
    const reasons = []
    let score = 0
    let rejected = false
    let rejectReason = null

    // ── CATEGORY relevance (the biggest signal) ──
    if (wantCats.size) {
      if (wantCats.has(v.category_slug)) {
        score += 50; reasons.push(`matches ${v.category_slug}`)
      } else {
        // wrong category when the user explicitly asked for categories → heavy penalty
        score -= 30; rejected = true; rejectReason = `wrong category (${v.category_slug}, wanted ${[...wantCats].join('/')})`
      }
    }

    // ── KEYWORD relevance (name matches the request) ──
    const kh = keywordHits(intent.raw, v)
    if (kh) { score += kh * 12; reasons.push('name matches request') }

    // ── RATING / quality ──
    if (v.rating) { score += Math.min(v.rating * 3, 15); if (v.rating >= 4.4) reasons.push('highly rated') }
    score += Math.min((v.rating_count || 0) / 250, 5)

    // ── BUDGET fit ──
    if (intent.budget === 'cheap') {
      if (v.price_level && v.price_level <= 2) { score += 10; reasons.push('budget-friendly') }
      else if (v.price_level >= 3) { score -= 12; if (!rejectReason) rejectReason = 'too expensive for cheap budget' }
    } else if (intent.budget === 'premium') {
      if (v.price_level >= 3) { score += 8; reasons.push('upmarket') }
    }
    if (intent.budgetPerPerson && v.price_level) {
      const [lo] = spendFor(v.category_slug, v.price_level)
      if (lo > intent.budgetPerPerson * 1.3) { score -= 15; if (!rejectReason) rejectReason = `likely over £${intent.budgetPerPerson} budget` }
    }

    // ── DISTANCE ──
    let dist = null
    if (ctx.lat != null && v.lat != null) {
      dist = haversineKm(ctx.lat, ctx.lng, v.lat, v.lng)
      if (dist != null) {
        if (dist <= 1.5) { score += 10; reasons.push('close by') }
        else if (dist <= 4) { score += 5 }
        else if (dist > 12) { score -= 10; if (!rejectReason) rejectReason = `too far (${dist.toFixed(1)}km)` }
        else score += Math.max(0, 4 - dist / 3)
      }
    }

    // ── OPENING HOURS ──
    const open = isOpenAt(v.opening_hours, when)
    if (open === true) { score += 8; reasons.push('open now') }
    else if (open === false) { score -= 25; rejected = true; rejectReason = rejectReason || 'closed now' }

    // ── BUSY / crowd preference ──
    let busy = null
    try { busy = estimateBusy(v, { when, events: ctx.events || [] }) } catch {}
    if (busy && intent.busyPref === 'avoid') {
      if (busy.level === 'very_busy') { score -= 12; if (!rejectReason) rejectReason = 'likely too busy' }
      else if (busy.level === 'quiet') { score += 8; reasons.push('nice and quiet') }
    } else if (busy && intent.busyPref === 'lively') {
      if (busy.level === 'busy' || busy.level === 'very_busy') { score += 8; reasons.push('good buzz') }
      else if (busy.level === 'quiet') { score -= 4 }
    }

    // ── WEATHER suitability ──
    const outdoorCats = new Set(['park', 'scenic', 'attraction'])
    if (ctx.weather?.planningHint?.mode === 'indoor' && outdoorCats.has(v.category_slug)) {
      score -= 8; reasons.push('(rainy — leaning indoor)')
    }

    // ── HIDDEN GEMS: penalise the obvious tourist traps ──
    if (wantsHidden) {
      if ((v.rating_count || 0) > 2000) { score -= 12; if (!rejectReason) rejectReason = 'too touristy for hidden gems' }
      else if ((v.rating_count || 0) < 400 && v.rating >= 4.3) { score += 10; reasons.push('proper local gem') }
    }

    // ── UNIQUENESS: penalise venues shown in recent plans ──
    if (recentlyShown.has(v.id)) { score -= 14; reasons.push('(shown recently — deprioritised)') }

    // small deterministic jitter for variety among near-ties
    score += (hashId(v.id) % 100) / 100 * 5

    return { venue: { ...v, _dist: dist, _busy: busy, _open: open }, score: Math.round(score * 10) / 10, reasons, rejected, rejectReason }
  })

  // split accepted vs rejected
  const accepted = scored.filter(s => !s.rejected && s.score > 0).sort((a, b) => b.score - a.score)
  const rejectedList = scored.filter(s => s.rejected || s.score <= 0).sort((a, b) => b.score - a.score)

  const debug = {
    candidatesScored: scored.length,
    accepted: accepted.length,
    rejected: rejectedList.length,
    topCandidates: accepted.slice(0, 10).map(s => ({ name: s.venue.name, cat: s.venue.category_slug, score: s.score, reasons: s.reasons })),
    rejectedSample: rejectedList.slice(0, 8).map(s => ({ name: s.venue.name, cat: s.venue.category_slug, score: s.score, why: s.rejectReason })),
  }

  return { ranked: accepted, rejected: rejectedList, debug }
}

// pick a varied shortlist from the top matches (not always the same top N)
function pickVaried(ranked, n = 12) {
  const pool = ranked.slice(0, Math.max(n * 2, 16))   // top ~24
  // ensure category spread: round-robin by category
  const byCat = {}
  for (const r of pool) { (byCat[r.venue.category_slug] ||= []).push(r) }
  const cats = Object.keys(byCat)
  const out = []
  let i = 0
  while (out.length < n && pool.length) {
    const cat = cats[i % cats.length]
    const bucket = byCat[cat]
    if (bucket && bucket.length) out.push(bucket.shift())
    i++
    if (i > pool.length * 2) break
  }
  // fill any remainder straight from ranked
  for (const r of pool) { if (out.length >= n) break; if (!out.includes(r)) out.push(r) }
  return out.slice(0, n)
}

function hashId(id) { const s = String(id); let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }

module.exports = { scoreVenues, pickVaried, isOpenAt, haversineKm }
