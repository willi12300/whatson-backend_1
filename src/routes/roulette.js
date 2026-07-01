// src/routes/roulette.js
// Sappo Roulette — strict intent matching + trust-first recommendation quality.
// Compatibility preserved: same POST /roulette request/response shape.

const express = require('express')
const { getWeather } = require('../clients/weather')
const { getProfile, plannerBoosts } = require('../services/travelProfile')
const { CITIES } = require('../config')
const { reverseGeocode } = require('../clients/google')
const { gatherCandidates, getRecentSpins, recordSpin, storeIntelligence, saveDiscoveredVenue } = require('../services/rouletteEngine')
const logger = require('../utils/logger')
const { getUserSignals, getVenueSignalMap, venueLearningScore, recordInteraction } = require('../services/behaviorLearning')
const { modeAllowsChains } = require('../services/chainDetection')
const { isKnownPoorQuality } = require('../services/qualityScore')
const { computeSappoScore } = require('../services/sappoScore')
const router = express.Router()

// Internal broad categories used by the decision engine.
// Keep these fairly broad because API providers use different labels.
const CATEGORY_GROUPS = {
  food: new Set(['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'meal_delivery', 'food', 'brunch', 'diner', 'dessert', 'street_food', 'food_market']),
  drinks: new Set(['bar', 'pub', 'cocktail_bar', 'wine_bar', 'brewery', 'taproom']),
  nightlife: new Set(['nightclub', 'night_club', 'club', 'dance_club']),
  event: new Set(['event', 'music', 'live_music', 'concert', 'gig', 'comedy', 'theatre', 'performance', 'festival', 'club_night', 'workshop', 'tour']),
  tourist: new Set(['attraction', 'tourist_attraction', 'landmark', 'historical_landmark', 'museum', 'gallery', 'art_gallery', 'historic_site', 'church', 'zoo', 'aquarium']),
  scenic: new Set(['park', 'viewpoint', 'waterfront', 'garden', 'beach', 'trail', 'walking_route']),
  accommodation: new Set(['hotel', 'lodging', 'accommodation', 'hostel', 'guest_house', 'motel', 'serviced_apartment', 'apartment', 'real_estate', 'rental'])
}

const MODE_RULES = {
  food: {
    venueAllow: ['food'],
    eventAllowRegex: /\b(food|brunch|breakfast|lunch|dinner|supper|street food|market|tasting|restaurant|burger|pizza|coffee|bake|bakery|meal|feast|supper club)\b/i,
    eventAllowed: 'only_food_events',
    hardBlockGroups: ['drinks', 'nightlife', 'tourist', 'scenic'],
  },
  drinks: {
    venueAllow: ['drinks'],
    eventAllowRegex: /\b(bar|pub|cocktail|wine|brewery|beer|drink|club night|dj|party)\b/i,
    eventAllowed: 'only_drinks_nightlife_events',
    hardBlockGroups: ['food', 'tourist', 'scenic'],
  },
  live_event: {
    venueAllow: [],
    eventAllowRegex: /./,
    eventAllowed: 'yes',
    hardBlockGroups: [],
  },
  hidden_gem: {
    venueAllow: ['food', 'drinks', 'tourist', 'scenic'],
    eventAllowRegex: /\b(hidden|secret|independent|local|underground|live|gig|comedy|market|tour|walk|workshop|pop up|popup)\b/i,
    eventAllowed: 'yes',
    hardBlockGroups: ['nightlife'],
  },
  tourist_spot: {
    venueAllow: ['tourist', 'scenic'],
    eventAllowRegex: /\b(tour|museum|gallery|history|historic|heritage|landmark|walk|walking|sightseeing|exhibition)\b/i,
    eventAllowed: 'only_tourist_events',
    hardBlockGroups: ['nightlife'],
  },
  date_night: {
    venueAllow: ['food', 'drinks', 'tourist', 'scenic'],
    eventAllowRegex: /\b(comedy|theatre|music|live|jazz|acoustic|cinema|show|experience|tasting|dinner|cocktail|wine)\b/i,
    eventAllowed: 'yes',
    hardBlockGroups: ['nightlife'],
  },
  rainy_day: {
    venueAllow: ['food', 'drinks', 'tourist'],
    eventAllowRegex: /\b(indoor|museum|gallery|comedy|theatre|cinema|show|workshop|class|tasting|food|music)\b/i,
    eventAllowed: 'yes',
    hardBlockGroups: ['scenic'],
  },
  anything: {
    venueAllow: ['food', 'drinks', 'tourist', 'scenic'],
    eventAllowRegex: /./,
    eventAllowed: 'yes',
    hardBlockGroups: [],
  },
}

const GOOGLE_TYPES_BY_MODE = {
  food: ['restaurant', 'cafe', 'bakery', 'meal_takeaway'],
  drinks: ['bar', 'pub'],
  live_event: ['bar', 'night_club', 'performing_arts_theater'],
  hidden_gem: ['restaurant', 'cafe', 'bar', 'art_gallery', 'tourist_attraction', 'park'],
  tourist_spot: ['tourist_attraction', 'museum', 'art_gallery', 'historical_landmark', 'park'],
  date_night: ['restaurant', 'bar', 'art_gallery', 'performing_arts_theater'],
  rainy_day: ['museum', 'art_gallery', 'cafe', 'restaurant', 'performing_arts_theater'],
  anything: ['restaurant', 'cafe', 'bar', 'pub', 'tourist_attraction', 'museum', 'art_gallery', 'park'],
}

// Used only for DB venue category prefetch. Live Google search uses GOOGLE_TYPES_BY_MODE.
const MODE_CATEGORIES = {
  food: ['restaurant', 'cafe', 'bakery', 'meal_takeaway', 'food'],
  drinks: ['bar', 'pub', 'cocktail_bar', 'wine_bar', 'brewery'],
  live_event: ['music_venue', 'bar', 'pub', 'nightclub', 'night_club'],
  hidden_gem: ['bar', 'pub', 'restaurant', 'cafe', 'attraction', 'gallery', 'museum', 'landmark', 'park'],
  tourist_spot: ['attraction', 'landmark', 'museum', 'gallery', 'park'],
  date_night: ['restaurant', 'cafe', 'bar', 'pub', 'gallery', 'attraction'],
  rainy_day: ['museum', 'gallery', 'cafe', 'restaurant', 'bar', 'pub'],
  anything: ['restaurant', 'bar', 'pub', 'cafe', 'attraction', 'museum', 'landmark', 'gallery', 'park', 'music_venue'],
}

const DISTANCE_M = { '10min': 800, '20min': 1600, '5miles': 8000, anywhere: 15000 }
const PRICE_LABEL = ['', '£', '££', '£££', '££££']

function haversineKm(a, b, c, d) {
  if ([a, b, c, d].some(x => x == null)) return null
  const R = 6371, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function nearestCity(lat, lng) {
  if (lat == null || lng == null) return null
  let best = null
  for (const [key, c] of Object.entries(CITIES)) {
    const distKm = haversineKm(lat, lng, c.lat, c.lng)
    if (distKm != null && (!best || distKm < best.distKm)) best = { key, name: c.name, distKm }
  }
  return best
}

function normaliseCategory(raw = '') {
  return String(raw || '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
}

function textBlob(obj = {}) {
  return [obj.name, obj.title, obj.category, obj.genre, obj.type, obj.venue_name, obj.address, obj.description]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function venueGroups(v) {
  const cat = normaliseCategory(v.category_slug || v.category || v.primaryType)
  const blob = textBlob(v)
  const groups = new Set()
  for (const [group, vals] of Object.entries(CATEGORY_GROUPS)) {
    if (vals.has(cat)) groups.add(group)
  }
  // Name/category fallbacks for older DB rows.
  if (/\b(restaurant|brunch|breakfast|cafe|coffee|bakery|burger|pizza|food|kitchen|diner|grill|bistro|market)\b/i.test(blob)) groups.add('food')
  if (/\b(bar|pub|cocktail|wine|brewery|taproom)\b/i.test(blob)) groups.add('drinks')
  if (/\b(nightclub|night club|club|rave)\b/i.test(blob)) groups.add('nightlife')
  if (/\b(museum|gallery|landmark|attraction|historic|history|tourist|theatre|theater)\b/i.test(blob)) groups.add('tourist')
  if (/\b(park|view|viewpoint|waterfront|garden|trail|walk)\b/i.test(blob)) groups.add('scenic')
  if (/\b(hotel|hostel|lodging|accommodation|apartment|travelodge|premier inn)\b/i.test(blob)) groups.add('accommodation')
  return groups
}

function eventBlob(e) { return textBlob(e) }

function isOpenNow(openingHours, when = new Date()) {
  try {
    const oh = typeof openingHours === 'string' ? JSON.parse(openingHours) : openingHours
    const periods = oh?.periods
    if (!Array.isArray(periods) || !periods.length) return null
    const day = when.getDay(), hm = when.getHours() * 100 + when.getMinutes()
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

function matchesModeVenue(v, mode) {
  const rules = MODE_RULES[mode] || MODE_RULES.anything
  const groups = venueGroups(v)
  if (groups.has('accommodation')) return { ok: false, reason: 'accommodation_blacklist' }
  for (const g of rules.hardBlockGroups || []) {
    if (groups.has(g)) return { ok: false, reason: `blocked_${g}` }
  }
  if (mode === 'live_event') return { ok: false, reason: 'live_event_mode_requires_event' }
  const ok = (rules.venueAllow || []).some(g => groups.has(g))
  return ok ? { ok: true, groups } : { ok: false, reason: `not_${mode}` }
}

function matchesModeEvent(e, mode) {
  const rules = MODE_RULES[mode] || MODE_RULES.anything
  const blob = eventBlob(e)
  if (/\b(hotel|hostel|accommodation|lodging|apartment|travelodge|premier inn)\b/i.test(blob)) return { ok: false, reason: 'accommodation_blacklist' }
  if (rules.eventAllowed === 'no') return { ok: false, reason: 'events_not_allowed' }
  // Strict mode-specific event matching. Prevent Food from returning Comedy.
  if (mode === 'food' || mode === 'drinks' || mode === 'tourist_spot') {
    if (!rules.eventAllowRegex.test(blob)) return { ok: false, reason: `event_not_${mode}` }
  } else if (mode !== 'anything' && !rules.eventAllowRegex.test(blob)) {
    return { ok: false, reason: `event_not_${mode}` }
  }
  return { ok: true }
}

function vibeCheckCandidate(item, vibe) {
  if (!vibe || vibe === 'balanced') return { ok: true, penalty: 0, boost: 0, reason: null }
  const blob = item.kind === 'event' ? eventBlob(item.e) : textBlob(item.v)
  const groups = item.kind === 'venue' ? venueGroups(item.v) : new Set()

  if (vibe === 'chill') {
    if (/\b(nightclub|night club|club night|rave|dj set|party|afterparty|drum and bass|dnb|techno|house music)\b/i.test(blob) || groups.has('nightlife')) {
      return { ok: false, reason: 'chill_blocks_loud_nightlife' }
    }
    if (/\b(cafe|coffee|museum|gallery|jazz|acoustic|cosy|cozy|relaxed|wine|restaurant|view|park)\b/i.test(blob)) {
      return { ok: true, boost: 12, penalty: 0, reason: 'fits chill vibe' }
    }
  }

  if (vibe === 'lively') {
    if (/\b(live|music|comedy|bar|pub|cocktail|event|gig|show|party)\b/i.test(blob)) return { ok: true, boost: 12, penalty: 0, reason: 'fits lively vibe' }
  }

  if (vibe === 'adventure') {
    if (/\b(hidden|secret|trail|walk|tour|view|landmark|market|experience|activity|outdoor|historic)\b/i.test(blob)) return { ok: true, boost: 12, penalty: 0, reason: 'fits adventure vibe' }
  }
  return { ok: true, boost: 0, penalty: 0, reason: null }
}

function priceFits(priceLevel, budget) {
  if (!budget || budget === 'comfortable') return { score: 0, reason: null }
  const p = Number(priceLevel || 0)
  if (budget === 'cheap') {
    if (!p || p <= 2) return { score: 10, reason: 'good value' }
    return { score: -18, reason: 'may be pricey' }
  }
  if (budget === 'treat') {
    if (p >= 3) return { score: 8, reason: 'a proper treat' }
    return { score: 0, reason: null }
  }
  return { score: 0, reason: null }
}

function weightedPick(pool) {
  if (!pool.length) return null
  const min = Math.min(...pool.map(p => p.score))
  const weights = pool.map(p => Math.max(1, p.score - min + 1))
  const total = weights.reduce((a, b) => a + b, 0)
  let r = Math.random() * total
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i]
    if (r <= 0) return pool[i]
  }
  return pool[pool.length - 1]
}

function pushReject(rejects, item, reason) {
  if (rejects.length < 25) rejects.push({ title: item.name || item.title, reason })
}

// POST /roulette { mode, distance, budget, who, vibe, spinMode, lat, lng, selectedCity, deviceId }
router.post('/', async (req, res, next) => {
  try {
    const { mode = 'anything', distance = '20min', budget, who, vibe = 'balanced', spinMode = 'discover', selectedCity, deviceId, allowChains } = req.body || {}
    let { lat, lng } = req.body || {}

    let cityName
    if (lat != null && lng != null) {
      const geo = await reverseGeocode(lat, lng)
      if (geo?.city) cityName = geo.city
      else { const near = nearestCity(lat, lng); cityName = (near && near.distKm <= 60) ? near.name : (selectedCity || 'Liverpool') }
    } else {
      cityName = selectedCity || 'Liverpool'
      const preset = CITIES[(cityName || '').toLowerCase().replace(/\s+/g, '')]
      if (preset) { lat = preset.lat; lng = preset.lng }
    }

    const cats = MODE_CATEGORIES[mode] || MODE_CATEGORIES.anything
    const radiusM = DISTANCE_M[distance] || 1600
    const radiusMiles = Math.max(2, Math.round(radiusM / 1609) || 5)
    const when = new Date()

    let weather = null
    try { weather = await getWeather(lat, lng) } catch {}

    let boosts = null
    const pkey = req.userId ? { userId: req.userId } : (deviceId ? { deviceId } : null)
    if (pkey) { try { boosts = plannerBoosts(await getProfile(pkey)) } catch {} }

    const googleTypes = GOOGLE_TYPES_BY_MODE[mode] || GOOGLE_TYPES_BY_MODE.anything
    const { venues, events, audit } = await gatherCandidates({ lat, lng, cityName, cats, radiusMiles, googleTypes })

    const venueSignalMap = await getVenueSignalMap(venues.map(v => v.id).filter(Boolean))
    const userSignals = await getUserSignals({ userId: req.userId || null, deviceId: deviceId || null })

    const recent = await getRecentSpins({ deviceId, userId: req.userId })
    const keyOf = (item) => item.kind === 'event'
      ? `e:${item.e.id || item.e.name}`
      : `v:${item.v.provider_id || item.v.google_place_id || item.v.id || item.v.name}`
    const repetitionPenalty = (k) => {
      if (recent.last === k) return -10000
      if (recent.last5.has(k)) return -1000
      if (recent.today.has(k)) return -200
      return 0
    }

    const rejected = []
    let afterCategoryVenues = 0, afterCategoryEvents = 0, afterVibeVenues = 0, afterVibeEvents = 0

    // Score venues. HARD GATES (category, distance, closed, vibe, quality)
    // reject candidates outright; everything that survives is ranked by the
    // weighted SappoScore model (30 quality / 25 uniqueness / 20 vibe /
    // 15 proximity / 10 trending).
    const radiusKm = radiusM / 1000
    const scoredVenues = venues.map(v => {
      let reasons = [], reject = false, rejectReason = null
      let modeMatch = false, vibeBoost = 0, learning = 0, plannerBoost = 0

      // ── GATE: category lock ──
      const mm = matchesModeVenue(v, mode)
      if (!mm.ok) { reject = true; rejectReason = mm.reason }
      else afterCategoryVenues++

      // ── GATE: distance outer bound (weighted decay handled in the model) ──
      const km = haversineKm(lat, lng, v.lat, v.lng)
      if (!reject && km != null) {
        if (km * 1000 > radiusM * 1.35 && distance !== 'anywhere') { reject = true; rejectReason = 'too_far' }
        else if (km * 1000 <= radiusM) reasons.push('nearby')
      }

      // ── GATE: closed now ──
      const open = isOpenNow(v.opening_hours, when)
      if (!reject) {
        if (open === false) { reject = true; rejectReason = 'closed_now' }
        else if (open === true) reasons.push('open now')
      }

      // ── GATE: vibe hard-block (also collect boost for the vibe bucket) ──
      if (!reject) {
        const vibeResult = vibeCheckCandidate({ kind: 'venue', v }, vibe)
        if (!vibeResult.ok) { reject = true; rejectReason = vibeResult.reason }
        else {
          afterVibeVenues++
          vibeBoost = vibeResult.boost || 0
          if (vibeResult.reason) reasons.push(vibeResult.reason)
        }
      }

      // ── GATE: known-poor quality (never drops missing-data venues) ──
      if (!reject && isKnownPoorQuality(v)) { reject = true; rejectReason = 'known_poor_quality' }

      // ── Collect remaining sub-signals for the model ──
      const groups = venueGroups(v)
      if (!reject) {
        modeMatch = (MODE_RULES[mode]?.venueAllow || []).some(g => groups.has(g))
        if (v.id) {
          learning = venueLearningScore({ ...v, type: 'venue' }, venueSignalMap.get(Number(v.id)), userSignals)
          if (learning >= 8) reasons.push('popular with Sappo users')
        }
        if (boosts?.categoryBoost?.[v.category_slug]) plannerBoost = Math.min(boosts.categoryBoost[v.category_slug], 10)
      }

      // ── The weighted SappoScore ──
      let score = 0, buckets = null, isChainVenue = false
      if (!reject) {
        const wantChains = modeAllowsChains(mode, { allowChains })
        const sappo = computeSappoScore(v, { mode, km, radiusKm, allowChains: wantChains, modeMatch, vibeBoost, learning, plannerBoost })
        score = sappo.score
        buckets = sappo.buckets
        isChainVenue = sappo.isChain
        for (const r of sappo.reasons) reasons.push(r)

        // ── Post-adjustments (preferences & penalties, not quality buckets) ──
        // Budget: nudge on price fit.
        const pf = priceFits(v.price_level, budget)
        score += pf.score * 0.4
        if (pf.reason && pf.score > 0) reasons.push(pf.reason)

        // Rainy-day / indoor weather: gently down-weight scenic outdoor spots.
        if ((mode === 'rainy_day' || weather?.planningHint?.mode === 'indoor') && groups.has('scenic')) score -= 6
      }

      const item = { kind: 'venue', v, score, buckets, reasons, reject, rejectReason, km, open, groups, isChain: isChainVenue }
      item.score += repetitionPenalty(keyOf(item)) * 0.15   // scale penalty to 0..100 range
      if (reject) pushReject(rejected, v, rejectReason)
      return item
    }).filter(s => !s.reject && s.score > -500)

    // Score events. Events don't fit the venue quality buckets (no rating,
    // time-sensitive), so they get their own 0..100 model built from
    // event-appropriate signals — kept on the SAME 0..100 scale as venues so
    // mixed-mode pools compare them fairly instead of by scale accident.
    const scoredEvents = events.map(e => {
      let reasons = [], reject = false, rejectReason = null
      let proximity = 55, timeliness = 40, vibeBoost = 0, sourceBoost = 0, modeBoost = 0, budgetAdj = 0

      const mm = matchesModeEvent(e, mode)
      if (!mm.ok) { reject = true; rejectReason = mm.reason }
      else afterCategoryEvents++

      // ── GATE: distance outer bound (events allow a wider bound than venues) ──
      const km = (e.lat != null) ? haversineKm(lat, lng, e.lat, e.lng) : null
      if (!reject && km != null) {
        if (km * 1000 > radiusM * 2 && distance !== 'anywhere') { reject = true; rejectReason = 'too_far' }
        else {
          const r = Math.max(0.2, (radiusM / 1000))
          proximity = Math.max(0, Math.min(100, 100 * Math.exp(-0.5 * (km / r))))
          if (km * 1000 <= radiusM) reasons.push('nearby')
        }
      }

      // ── GATE: event must be upcoming; sooner = higher timeliness ──
      const hrs = (new Date(e.starts_at) - when) / 3600000
      if (!reject) {
        if (hrs >= 0 && hrs <= 12) { timeliness = 100; reasons.push('on today') }
        else if (hrs <= 48 && hrs >= 0) { timeliness = 80; reasons.push('on soon') }
        else if (hrs <= 24 * 7 && hrs >= 0) { timeliness = 55; reasons.push('this week') }
        else if (hrs < 0) { reject = true; rejectReason = 'event_passed' }
        else { timeliness = 40 }
      }

      // ── GATE: vibe hard-block ──
      if (!reject) {
        const vibeResult = vibeCheckCandidate({ kind: 'event', e }, vibe)
        if (!vibeResult.ok) { reject = true; rejectReason = vibeResult.reason }
        else {
          afterVibeEvents++
          vibeBoost = vibeResult.boost || 0
          if (vibeResult.reason) reasons.push(vibeResult.reason)
        }
      }

      if (!reject) {
        const p = (e.provider || '').toLowerCase()
        if (p.includes('skiddle') || p.includes('eventbrite') || p.includes('ticketmaster')) { sourceBoost = 12; reasons.push(`${cap(p)} event`) }
        if (mode === 'live_event') { modeBoost += 25; reasons.push('a live event') }
        if (mode === 'date_night') { modeBoost += 10; reasons.push('good for a date') }
        if (budget === 'cheap' && e.is_free) { budgetAdj += 8; reasons.push('free') }
        if (budget === 'cheap' && e.min_price && Number(e.min_price) > 30) budgetAdj -= 8
      }

      // Combine on a 0..100 scale. Events lean on timeliness + proximity, with
      // vibe/source/mode as boosts. Weighting mirrors the venue model's spirit:
      // "is it on, is it near, does it fit".
      let score = 0, buckets = null
      if (!reject) {
        const vibeVal = Math.min(100, 50 + vibeBoost * 2 + modeBoost)
        score =
          timeliness * 0.35 +
          proximity * 0.30 +
          vibeVal * 0.25 +
          Math.min(100, 40 + sourceBoost * 3) * 0.10
        score += budgetAdj
        buckets = { timeliness: Math.round(timeliness), proximity: Math.round(proximity), vibe: Math.round(vibeVal) }
      }

      const item = { kind: 'event', e, score, buckets, reasons, reject, rejectReason, km }
      item.score += repetitionPenalty(keyOf(item)) * 0.15
      if (reject) pushReject(rejected, e, rejectReason)
      return item
    }).filter(s => !s.reject && s.score > -500)

    scoredVenues.sort((a, b) => b.score - a.score)
    scoredEvents.sort((a, b) => b.score - a.score)

    // Mode-specific pool composition. Strict modes stay strict.
    let pool = []
    if (mode === 'food' || mode === 'drinks' || mode === 'tourist_spot') {
      // Mostly venues, with only genuinely matching events allowed.
      pool = [...scoredVenues.slice(0, 40), ...scoredEvents.slice(0, 8)]
    } else if (mode === 'live_event') {
      pool = scoredEvents.slice(0, 50)
    } else if (mode === 'anything') {
      pool = [...scoredVenues.slice(0, 28), ...scoredEvents.slice(0, 22)]
    } else {
      pool = [...scoredVenues.slice(0, 30), ...scoredEvents.slice(0, 20)]
    }

    // Never repeat the immediate last result. Keep only sensible top pool.
    pool = pool
      .filter(item => keyOf(item) !== recent.last)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)

    const totalCandidates = (audit.dbVenues.count + audit.googlePlaces.count + audit.dbEvents.count + audit.skiddle.count + audit.ticketmaster.count + audit.eventbrite.count)
    const debug = {
      selected: { cityName, mode, vibe, who, distance, budget, lat, lng },
      totalCandidates,
      audit,
      filtering: {
        rawVenues: venues.length,
        rawEvents: events.length,
        afterCategoryVenues,
        afterCategoryEvents,
        afterVibeVenues,
        afterVibeEvents,
        scoredVenues: scoredVenues.length,
        scoredEvents: scoredEvents.length,
        finalPool: pool.length,
        rejectedExamples: rejected,
      },
      topPool: pool.slice(0, 10).map(item => ({ title: item.kind === 'event' ? item.e.name : item.v.name, kind: item.kind, score: Math.round(item.score), buckets: item.buckets || null, reasons: item.reasons }))
    }

    logger.info('[roulette AUDIT] ' + JSON.stringify(debug))
    storeIntelligence({ venues, events, cityName }).catch(() => {})

    if (!pool.length) {
      return res.json({
        error: 'no_matches',
        message: `I couldn't find a strong ${mode.replace('_', ' ')} match nearby right now. Try a wider distance or Anything.`,
        debug,
      })
    }

    const pick = weightedPick(pool)
    const chosenKey = keyOf(pick)
    recordSpin({ deviceId, userId: req.userId, resultKey: chosenKey, resultName: pick.kind === 'event' ? pick.e.name : pick.v.name }).catch(() => {})

    if (pick.kind === 'event') {
      const e = pick.e
      const walkMin = pick.km != null ? Math.max(1, Math.round((pick.km / 5) * 60)) : null
      const whyBits = [...new Set(pick.reasons)]
      recordInteraction({ userId: req.userId || null, deviceId, action: 'shown', itemType: 'event', eventId: /^\d+$/.test(String(e.id || '')) ? e.id : null, itemId: e.id || e.name, itemName: e.name, category: e.category, city: cityName, source: e.provider || 'Event', context: 'roulette' }).catch(() => {})
      return res.json({
        title: e.name,
        type: 'Live event' + (e.venue_name ? ` · ${e.venue_name}` : ''),
        distance: walkMin != null ? `${walkMin} min walk` : null,
        estimated_cost: e.is_free ? 'Free' : (e.min_price ? `from £${e.min_price}` : '££'),
        why: `Chosen because it's ${whyBits.join(', ')} — it matches ${mode.replace('_', ' ')} and your ${vibe || 'selected'} vibe.`,
        when: e.starts_at,
        source: cap(e.provider) || 'Event',
        lat: e.lat, lng: e.lng, address: e.address || null,
        google_maps_url: e.ticket_url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${e.venue_name || e.name}, ${cityName}`)}`,
        is_event: true,
        actions: ['Let\u2019s Go', 'Spin Again', 'Add to Plan'],
        debug,
      })
    }

    const v = pick.v
    // If Roulette selected a live Google result that is not yet in our DB, save it now
    // so the frontend can open a proper venue profile immediately.
    let liveVenueId = v.id || null
    if (!liveVenueId && v._src === 'google') {
      try { liveVenueId = await saveDiscoveredVenue(v, cityName) } catch {}
    }
    const walkMin = pick.km != null ? Math.max(1, Math.round((pick.km / 5) * 60)) : null
    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name}, ${v.address || cityName}`)}`
    const whyBits = [...new Set(pick.reasons)]
    recordInteraction({ userId: req.userId || null, deviceId, action: 'shown', itemType: 'venue', venueId: liveVenueId, itemId: liveVenueId || v.provider_id || v.google_place_id || v.name, itemName: v.name, category: v.category_slug, city: cityName, source: v._src === 'google' ? 'Google Places' : 'Sappo', context: 'roulette' }).catch(() => {})
    return res.json({
      title: v.name,
      type: prettyType(v.category_slug),
      distance: walkMin != null ? `${walkMin} min walk` : null,
      estimated_cost: v.price_level ? PRICE_LABEL[v.price_level] : '££',
      why: `Chosen because it ${whyBits.length ? whyBits.join(', ') : 'fits what you fancied'} — a strong ${mode.replace('_', ' ')} match near you.`,
      rating: v.rating || null,
      review_count: v.rating_count || null,
      lat: v.lat, lng: v.lng,
      address: v.address || null,
      source: v._src === 'google' ? 'Google Places' : 'Sappo',
      google_maps_url: mapUrl,
      venueId: liveVenueId,
      actions: ['Let\u2019s Go', 'Spin Again', 'Add to Plan'],
      debug,
    })
  } catch (err) { logger.error('[roulette] error:', err.message); next(err) }
})

function cap(s) { return s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s }

function prettyType(slug) {
  const s = normaliseCategory(slug)
  return ({
    restaurant: 'Restaurant', cafe: 'Café', bakery: 'Bakery', meal_takeaway: 'Takeaway',
    bar: 'Bar', pub: 'Pub', cocktail_bar: 'Cocktail bar', wine_bar: 'Wine bar', brewery: 'Brewery',
    nightclub: 'Club', night_club: 'Club', music_venue: 'Live music', museum: 'Museum',
    gallery: 'Art gallery', art_gallery: 'Art gallery', landmark: 'Landmark', historical_landmark: 'Historic landmark',
    park: 'Park', attraction: 'Attraction', tourist_attraction: 'Attraction',
  })[s] || 'Spot'
}

module.exports = router
