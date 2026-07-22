const ALCOHOL_CATEGORIES = new Set(['bar', 'pub', 'nightclub', 'night_club', 'wine_bar', 'cocktail_bar'])

function haversineMeters(aLat, aLng, bLat, bLng) {
  if ([aLat, aLng, bLat, bLng].some(v => v == null || !Number.isFinite(Number(v)))) return null
  const R = 6371000, rad = d => Number(d) * Math.PI / 180
  const dLat = rad(Number(bLat) - Number(aLat)), dLng = rad(Number(bLng) - Number(aLng))
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function timeZoneForCity(city = '') {
  const key = String(city).toLowerCase()
  if (/liverpool|manchester|london|birmingham|leeds|glasgow|bristol|edinburgh/.test(key)) return 'Europe/London'
  return 'UTC'
}

function zonedParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = type => parts.find(p => p.type === type)?.value
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get('weekday')]
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) }
}

function minuteOf(point = {}) {
  return Number(point.hour || 0) * 60 + Number(point.minute || 0)
}

function openingState(candidate, at, city) {
  if (!candidate || candidate.type !== 'venue') return null
  if (/CLOSED_PERMANENTLY/i.test(candidate.businessStatus || '')) return false
  const hours = typeof candidate.openingHours === 'string'
    ? (() => { try { return JSON.parse(candidate.openingHours) } catch { return null } })()
    : candidate.openingHours
  const periods = hours?.periods
  if (!Array.isArray(periods) || !periods.length) return null
  const target = zonedParts(new Date(at), timeZoneForCity(city))

  for (const period of periods) {
    if (!period?.open || period.open.day == null) continue
    const openDay = Number(period.open.day), closeDay = period.close?.day == null ? openDay : Number(period.close.day)
    const openMinute = minuteOf(period.open), closeMinute = period.close ? minuteOf(period.close) : 24 * 60
    if (openDay === closeDay && target.day === openDay && target.minute >= openMinute && target.minute < closeMinute) return true
    if (closeDay !== openDay) {
      if (target.day === openDay && target.minute >= openMinute) return true
      if (target.day === closeDay && target.minute < closeMinute) return true
    }
  }
  return false
}

function openDuringWindow(candidate, start, end, city) {
  let known = false
  for (let at = new Date(start).getTime(); at <= new Date(end).getTime(); at += 30 * 60 * 1000) {
    const state = openingState(candidate, new Date(at), city)
    if (state === true) return true
    if (state === false) known = true
  }
  return known ? false : null
}

function text(candidate) {
  return `${candidate.name || ''} ${candidate.category || ''} ${candidate.address || ''}`.toLowerCase()
}

function matchesInterest(candidate, interests = []) {
  if (!interests.length) return true
  const blob = text(candidate)
  const aliases = {
    food: /restaurant|cafe|bakery|food|brunch|dining/,
    drinks: /bar|pub|drink|cocktail|wine/,
    walk: /park|walk|trail|garden|waterfront/,
    outdoors: /park|walk|trail|garden|outdoor|waterfront/,
    music: /music|concert|gig|jazz|band|event/,
    culture: /museum|gallery|theatre|landmark|culture/,
    history: /museum|historic|heritage|landmark/,
    quiet: /cafe|museum|gallery|park/,
    family: /attraction|museum|park|cinema|theatre/,
    reading: /cafe|library|book|museum|gallery/,
    nightlife: /bar|pub|nightclub|music|event/,
  }
  return interests.some(i => aliases[i]?.test(blob) || blob.includes(i.replace(/_/g, ' ')))
}

function historyPenalty(candidate, history = []) {
  let value = 0
  for (const row of history) {
    const same = candidate.type === 'venue'
      ? candidate.venueId && Number(row.venue_id) === Number(candidate.venueId)
      : String(row.event_id || '') === String(candidate.eventId || '')
    if (!same) continue
    if (['dismissed', 'ignored'].includes(row.action)) value -= 18
    if (['saved', 'added_to_plan', 'directions'].includes(row.action)) value += 5
    if (['opened_profile', 'clicked'].includes(row.action)) value += 2
  }
  return Math.max(-25, Math.min(10, value))
}

function scoreCandidate(candidate, context) {
  const { intent, weather, userSignals, history } = context
  const reasons = []
  let score = 30
  const interestMatch = matchesInterest(candidate, intent.interests)
  if (interestMatch) { score += intent.interests.length ? 24 : 8; reasons.push('intent_match') }
  else score -= 18

  const distance = haversineMeters(intent.location.lat, intent.location.lng, candidate.lat, candidate.lng)
  if (distance != null) {
    score += Math.max(-15, 18 - distance / 250)
    if (distance <= 1600) reasons.push('nearby')
  }
  if (candidate.type === 'venue') {
    if (candidate.rating != null) score += Math.max(0, (candidate.rating - 3.5) * 8)
    if (candidate.ratingCount != null) score += Math.min(8, Math.log10(candidate.ratingCount + 1) * 2.5)
    if (candidate.priceLevel != null && intent.budget.level != null) {
      const difference = candidate.priceLevel - intent.budget.level
      score += difference <= 0 ? 6 : -difference * 7
      if (difference <= 0) reasons.push('budget_fit')
    }
    const pref = userSignals?.categoryBoost?.[candidate.category] || 0
    if (pref) score += Math.max(-8, Math.min(10, Number(pref) * 0.5))
  } else {
    const hoursUntil = (new Date(candidate.startsAt) - new Date(intent.startTime)) / 3600000
    if (hoursUntil >= 0 && hoursUntil <= intent.durationMinutes / 60) { score += 18; reasons.push('timely_event') }
    if (candidate.isFree && (intent.budget.level === 1 || intent.budget.maxPerPerson != null)) { score += 8; reasons.push('free_event') }
  }
  const indoorWeather = weather?.planningHint?.mode === 'indoor'
  if (indoorWeather && /park|outdoor|walk|garden/.test(text(candidate))) score -= 12
  if (indoorWeather && /museum|gallery|cafe|restaurant|theatre/.test(text(candidate))) { score += 7; reasons.push('weather_fit') }
  score += historyPenalty(candidate, history)

  const known = [candidate.lat != null, candidate.lng != null, candidate.category, candidate.type === 'event' ? candidate.startsAt : candidate.openingHours]
  const dataConfidence = known.filter(Boolean).length / known.length
  score += dataConfidence * 6
  return { ...candidate, score: Math.round(score * 10) / 10, distanceMeters: distance == null ? null : Math.round(distance), scoreReasons: reasons, dataConfidence }
}

function filterAndShortlist(context, { maxVenues = 12, maxEvents = 8 } = {}) {
  const start = new Date(context.intent.startTime)
  const end = new Date(start.getTime() + context.intent.durationMinutes * 60000)
  const rejected = []
  const seen = new Set()
  const keep = []
  const noAlcohol = (context.intent.avoid || []).some(a => /alcohol|bar|pub|drinks/.test(a))

  for (const candidate of [...context.venues, ...context.events]) {
    let reason = null
    if (candidate.lat == null || candidate.lng == null) reason = 'missing_coordinates'
    const distance = haversineMeters(context.intent.location.lat, context.intent.location.lng, candidate.lat, candidate.lng)
    if (!reason && distance != null && distance > (context.intent.radiusMiles || 6) * 1609.344) reason = 'outside_search_radius'
    if (!reason && noAlcohol && candidate.type === 'venue' && ALCOHOL_CATEGORIES.has(candidate.category)) reason = 'alcohol_avoided'
    if (!reason && (context.intent.avoid || []).some(a => text(candidate).includes(a))) reason = 'explicit_avoidance'
    if (!reason && candidate.type === 'venue') {
      const state = openDuringWindow(candidate, start, end, context.intent.location.city)
      if (state === false) reason = 'closed_during_window'
    }
    if (!reason && candidate.type === 'event') {
      const eventStart = new Date(candidate.startsAt)
      const eventEnd = candidate.endsAt ? new Date(candidate.endsAt) : null
      if (!candidate.startsAt || eventStart >= end || (eventEnd && eventEnd <= start)) reason = 'event_outside_window'
    }
    const key = `${candidate.type}:${String(candidate.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}:${Number(candidate.lat).toFixed(3)}`
    if (!reason && seen.has(key)) reason = 'duplicate'
    if (reason) rejected.push({ candidateId: candidate.candidateId, reason })
    else { seen.add(key); keep.push(scoreCandidate(candidate, context)) }
  }

  const venues = keep.filter(c => c.type === 'venue').sort((a, b) => b.score - a.score).slice(0, maxVenues)
  const events = keep.filter(c => c.type === 'event').sort((a, b) => b.score - a.score).slice(0, maxEvents)
  return { venues, events, all: [...venues, ...events], rejected }
}

module.exports = {
  filterAndShortlist,
  scoreCandidate,
  openingState,
  openDuringWindow,
  haversineMeters,
  timeZoneForCity,
}
