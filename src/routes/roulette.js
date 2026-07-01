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
const { detectChain, modeAllowsChains, CHAIN_PENALTY } = require('../services/chainDetection')
const { qualityScore, isKnownPoorQuality } = require('../services/qualityScore')
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

    // Score venues with hard category lock first.
    const scoredVenues = venues.map(v => {
      let score = 0, reasons = [], reject = false, rejectReason = null
      const mm = matchesModeVenue(v, mode)
      if (!mm.ok) { reject = true; rejectReason = mm.reason }
      else afterCategoryVenues++

      const km = haversineKm(lat, lng, v.lat, v.lng)
      if (!reject && km != null) {
        if (km * 1000 > radiusM * 1.35 && distance !== 'anywhere') { reject = true; rejectReason = 'too_far' }
        else {
          score += Math.max(0, 35 - km * 10)
          if (km * 1000 <= radiusM) reasons.push('nearby')
        }
      }

      const open = isOpenNow(v.opening_hours, when)
      if (!reject) {
        if (open === false) { reject = true; rejectReason = 'closed_now' }
        else if (open === true) { score += 14; reasons.push('open now') }
      }

      if (!reject) {
        const vibeResult = vibeCheckCandidate({ kind: 'venue', v }, vibe)
        if (!vibeResult.ok) { reject = true; rejectReason = vibeResult.reason }
        else {
          afterVibeVenues++
          score += vibeResult.boost || 0
          if (vibeResult.reason) reasons.push(vibeResult.reason)
        }
      }

      // Quality: rewards known-good, penalises known-bad, neutral on missing
      // data, and dampens thin-signal ratings (4.9 from 3 reviews ≠ excellent).
      if (!reject) {
        if (isKnownPoorQuality(v)) { reject = true; rejectReason = 'known_poor_quality' }
        else {
          const q = qualityScore(v)
          score += q.score
          if (q.reason) reasons.push(q.reason)
        }
      }
      if (!reject && v.id) {
        const learning = venueLearningScore({ ...v, type: 'venue' }, venueSignalMap.get(Number(v.id)), userSignals)
        score += learning
        if (learning >= 8) reasons.push('popular with Sappo users')
      }

      if (!reject) {
        const pf = priceFits(v.price_level, budget)
        score += pf.score
        if (pf.reason && pf.score > 0) reasons.push(pf.reason)
      }

      const groups = venueGroups(v)
      if (!reject && (MODE_RULES[mode]?.venueAllow || []).some(g => groups.has(g))) {
        score += 30; reasons.push(`matches ${mode.replace('_', ' ')}`)
      }

      // Hidden gem: boost smaller high-rated places, penalise giant obvious tourist traps.
      if (!reject && mode === 'hidden_gem') {
        if ((v.rating_count || 0) > 2500) score -= 15
        else if ((v.rating_count || 0) < 800 && (v.rating || 0) >= 4.2) { score += 18; reasons.push('feels like a hidden gem') }
      }

      if (!reject && (mode === 'rainy_day' || weather?.planningHint?.mode === 'indoor') && groups.has('scenic')) score -= 16
      if (!reject && boosts?.categoryBoost?.[v.category_slug]) score += Math.min(boosts.categoryBoost[v.category_slug], 10)

      // Chain / franchise penalty. Independent, characterful places are the
      // heart of Roulette — chains are pushed down hard but NOT rejected, so
      // they can still surface if explicitly wanted or if nothing else fits.
      let isChainVenue = false
      if (!reject && !modeAllowsChains(mode, { allowChains })) {
        const chain = detectChain(v.name)
        if (chain.isChain) { score += CHAIN_PENALTY; isChainVenue = true }
      }

      const item = { kind: 'venue', v, score, reasons, reject, rejectReason, km, open, groups, isChain: isChainVenue }
      item.score += repetitionPenalty(keyOf(item))
      if (reject) pushReject(rejected, v, rejectReason)
      return item
    }).filter(s => !s.reject && s.score > -500)

    // Score events with mode-specific event matching. Food won't get comedy unless it is actually a food event.
    const scoredEvents = events.map(e => {
      let score = 0, reasons = [], reject = false, rejectReason = null
      const mm = matchesModeEvent(e, mode)
      if (!mm.ok) { reject = true; rejectReason = mm.reason }
      else afterCategoryEvents++

      const km = (e.lat != null) ? haversineKm(lat, lng, e.lat, e.lng) : null
      if (!reject && km != null) {
        if (km * 1000 > radiusM * 2 && distance !== 'anywhere') { reject = true; rejectReason = 'too_far' }
        else { score += Math.max(0, 30 - km * 7); if (km * 1000 <= radiusM) reasons.push('nearby') }
      }

      const hrs = (new Date(e.starts_at) - when) / 3600000
      if (!reject) {
        if (hrs >= 0 && hrs <= 12) { score += 32; reasons.push('on today') }
        else if (hrs <= 48 && hrs >= 0) { score += 22; reasons.push('on soon') }
        else if (hrs <= 24 * 7 && hrs >= 0) { score += 10; reasons.push('this week') }
        else if (hrs < 0) { reject = true; rejectReason = 'event_passed' }
      }

      if (!reject) {
        const vibeResult = vibeCheckCandidate({ kind: 'event', e }, vibe)
        if (!vibeResult.ok) { reject = true; rejectReason = vibeResult.reason }
        else {
          afterVibeEvents++
          score += vibeResult.boost || 0
          if (vibeResult.reason) reasons.push(vibeResult.reason)
        }
      }

      if (!reject) {
        const p = (e.provider || '').toLowerCase()
        if (p.includes('skiddle') || p.includes('eventbrite') || p.includes('ticketmaster')) { score += 18; reasons.push(`${cap(p)} event`) }
        if (mode === 'live_event') { score += 35; reasons.push('a live event') }
        if (mode === 'date_night') { score += 12; reasons.push('good for a date') }
        if (budget === 'cheap' && e.is_free) { score += 12; reasons.push('free') }
        if (budget === 'cheap' && e.min_price && Number(e.min_price) > 30) score -= 12
      }

      const item = { kind: 'event', e, score, reasons, reject, rejectReason, km }
      item.score += repetitionPenalty(keyOf(item))
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
      topPool: pool.slice(0, 10).map(item => ({ title: item.kind === 'event' ? item.e.name : item.v.name, kind: item.kind, score: Math.round(item.score), reasons: item.reasons }))
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
