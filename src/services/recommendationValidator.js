const { spendFor } = require('./costEstimate')
const { openingState, haversineMeters } = require('./recommendationScoring')

function date(value) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

const UNSUPPORTED_LIVE_CLAIM = /\b(packed|crowded|quiet(?:er)? than usual|queue|wait time|guaranteed|definitely open|availability|sold out|not busy|busiest)\b/i

function safeMessage(plan, context) {
  const text = String(plan?.sappoMessage || '').trim()
  if (!text || UNSUPPORTED_LIVE_CLAIM.test(text)) {
    return `I’d go with ${plan?.title || 'this plan'} — it fits the time you have and keeps the stops practical.`
  }
  return text
}

function allowedReason(reason, context, candidates) {
  if (!reason || !reason.text || !reason.source) return false
  if (UNSUPPORTED_LIVE_CLAIM.test(String(reason.text))) return false
  const source = String(reason.source).toLowerCase()
  if (source === 'user_request' || source === 'sappo_route' || source === 'sappo_estimate') return true
  if (source === 'open_meteo') return !!context.weather?.current
  return candidates.some(c => String(c.source || '').toLowerCase() === source)
}

function safeStopReason(reason, candidate) {
  const text = String(reason || '').trim()
  if (text && !UNSUPPORTED_LIVE_CLAIM.test(text)) return text
  if (candidate.scoreReasons?.includes('intent_match')) return 'This is one of the strongest matches for the interests in your request.'
  if (candidate.scoreReasons?.includes('timely_event')) return 'The verified event time fits inside your requested window.'
  return 'This option passed SAPPO\'s location, timing and constraint checks.'
}

function spendEstimate(stops) {
  let min = 0, max = 0, known = 0
  for (const stop of stops) {
    if (stop.type === 'event') {
      if (stop.isFree) { known++; continue }
      if (stop.minPrice != null) { min += stop.minPrice; max += stop.minPrice; known++; }
      continue
    }
    if (stop.priceLevel != null || /restaurant|cafe|bar|pub|nightclub|music_venue/.test(stop.category || '')) {
      const [lo, hi] = spendFor(stop.category || 'other', stop.priceLevel)
      min += lo; max += hi; known++
    }
  }
  if (!known) return null
  return {
    min: Math.round(min), max: Math.round(max),
    confidence: known === stops.length ? 'medium' : 'low',
  }
}

async function travelLeg(from, to, modes, travelFn) {
  const route = await Promise.resolve()
    .then(() => travelFn({ lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }))
    .catch(() => null)
  const preferred = (modes || []).find(m => route?.[m]) || route?.primary
  const info = preferred ? route?.[preferred] : null
  if (info?.durationSeconds != null) {
    return {
      fromCandidateId: from.candidateId, toCandidateId: to.candidateId,
      fromVenueId: from.venueId || null, toVenueId: to.venueId || null,
      mode: preferred, durationMinutes: Math.max(1, Math.round(info.durationSeconds / 60)),
      distanceMeters: info.distanceMeters == null ? null : Math.round(info.distanceMeters),
      source: 'google_routes', confidence: 'high',
    }
  }
  const meters = haversineMeters(from.lat, from.lng, to.lat, to.lng)
  if (meters == null) return null
  return {
    fromCandidateId: from.candidateId, toCandidateId: to.candidateId,
    fromVenueId: from.venueId || null, toVenueId: to.venueId || null,
    mode: 'walking', durationMinutes: Math.max(1, Math.round(meters / 80)),
    distanceMeters: Math.round(meters), source: 'haversine_estimate', confidence: 'medium',
  }
}

async function validateExperience(plan, context, shortlist, deps = {}) {
  const errors = [], warnings = []
  const candidates = shortlist.all || []
  const byId = new Map(candidates.map(c => [String(c.candidateId), c]))
  const rawStops = Array.isArray(plan?.stops) ? plan.stops : []
  if (!plan || typeof plan !== 'object') return { valid: false, errors: ['planner returned no JSON object'], warnings, experience: null }
  if (!rawStops.length) return { valid: false, errors: ['plan contains no stops'], warnings, experience: null }
  if (rawStops.length > 4) errors.push('plan contains more than four stops')

  const selected = []
  const seen = new Set()
  for (const raw of rawStops.slice(0, 4)) {
    const id = String(raw.candidateId || '')
    const candidate = byId.get(id)
    if (!candidate) { errors.push(`invented or unavailable candidateId: ${id || '(missing)'}`); continue }
    if (seen.has(id)) { errors.push(`duplicate stop: ${id}`); continue }
    seen.add(id)
    selected.push({ raw, candidate })
  }
  if (!selected.length) return { valid: false, errors, warnings, experience: null }

  selected.sort((a, b) => (date(a.raw.startTime)?.getTime() || 0) - (date(b.raw.startTime)?.getTime() || 0))
  const start = date(context.intent.startTime)
  const deadline = new Date(start.getTime() + context.intent.durationMinutes * 60000)
  const travelFn = deps.getTravel || require('./travelProvider').getTravel
  const idFn = deps.ensureInternalVenueId || require('./recommendationCandidates').ensureInternalVenueId
  const stops = [], travelLegs = []
  let cursor = new Date(start)

  for (const { raw, candidate } of selected) {
    let pendingLeg = null
    let earliestStart = new Date(cursor)
    if (stops.length) {
      const leg = await travelLeg(stops[stops.length - 1], candidate, context.intent.transportModes, travelFn)
      if (!leg) { errors.push(`travel unavailable to ${candidate.candidateId}`); continue }
      if (leg.mode === 'walking' && leg.durationMinutes > 45) { errors.push(`excessive walking to ${candidate.candidateId}`); continue }
      pendingLeg = leg
      earliestStart = new Date(cursor.getTime() + leg.durationMinutes * 60000)
    }

    let proposed = date(raw.startTime)
    if (!proposed || proposed < earliestStart) proposed = new Date(earliestStart)
    if (candidate.type === 'event') {
      const eventStart = date(candidate.startsAt)
      if (!eventStart || eventStart < earliestStart || eventStart >= deadline) { errors.push(`event timing does not fit: ${candidate.candidateId}`); continue }
      proposed = eventStart
    }
    let duration = clamp(Number(raw.durationMinutes) || (candidate.type === 'event' ? 90 : 60), 20, 180)
    if (candidate.type === 'event' && candidate.endsAt) {
      const eventEnd = date(candidate.endsAt)
      if (eventEnd) duration = Math.min(duration, Math.max(20, Math.round((eventEnd - proposed) / 60000)))
    }
    const finish = new Date(proposed.getTime() + duration * 60000)
    if (finish > deadline) { errors.push(`duration exceeds requested window at ${candidate.candidateId}`); continue }

    if (candidate.type === 'venue') {
      const openAtStart = openingState(candidate, proposed, context.intent.location.city)
      const openAtFinish = openingState(candidate, new Date(finish.getTime() - 60000), context.intent.location.city)
      if (openAtStart === false || openAtFinish === false) { errors.push(`venue closed during stop: ${candidate.candidateId}`); continue }
      if (openAtStart == null || openAtFinish == null) warnings.push(`Opening hours could not be confirmed for ${candidate.name}.`)
    }

    const venueId = candidate.type === 'venue'
      ? await Promise.resolve().then(() => idFn(candidate, { ...deps, city: context.intent.location.city })).catch(() => null)
      : null
    if (candidate.type === 'venue' && !venueId) { errors.push(`venue could not be assigned an internal ID: ${candidate.candidateId}`); continue }
    if (pendingLeg) travelLegs.push({ ...pendingLeg, toVenueId: venueId || pendingLeg.toVenueId || null })
    const hydrated = {
      candidateId: candidate.candidateId,
      type: candidate.type,
      venueId: venueId || undefined,
      eventId: candidate.type === 'event' ? candidate.eventId : undefined,
      name: candidate.name,
      category: candidate.category,
      address: candidate.address,
      lat: candidate.lat, lng: candidate.lng,
      coverPhoto: candidate.coverPhoto || null,
      rating: candidate.rating ?? null,
      ratingCount: candidate.ratingCount ?? null,
      priceLevel: candidate.priceLevel ?? null,
      isFree: candidate.isFree,
      minPrice: candidate.minPrice,
      startsAt: candidate.startsAt,
      ticketUrl: candidate.ticketUrl,
      startTime: proposed.toISOString(),
      durationMinutes: duration,
      reason: safeStopReason(raw.reason, candidate),
      source: candidate.source,
      dataConfidence: candidate.dataConfidence,
    }
    stops.push(hydrated)
    cursor = finish
  }

  if (!stops.length) return { valid: false, errors, warnings, experience: null }
  if (stops.length !== selected.length) errors.push('one or more selected stops could not be scheduled safely')
  const totalDurationMinutes = Math.round((cursor - start) / 60000)
  if (totalDurationMinutes > context.intent.durationMinutes) errors.push('total duration exceeds the request')

  const acceptedReasons = (Array.isArray(plan.reasons) ? plan.reasons : []).filter(r => allowedReason(r, context, candidates)).slice(0, 5)
  if (!acceptedReasons.length) acceptedReasons.push({ type: 'intent', text: 'The stops match the interests and constraints supplied in the request.', source: 'user_request', confidence: 'high' })
  if (travelLegs.length && !acceptedReasons.some(r => r.type === 'route')) acceptedReasons.push({ type: 'route', text: 'The stops were checked in sequence with practical travel legs.', source: 'sappo_route', confidence: travelLegs.every(l => l.confidence === 'high') ? 'high' : 'medium' })

  const confidenceBase = clamp(Number(plan.confidence) || 0.72, 0, 1)
  if (context.intent.accessibility?.length) warnings.push('Accessibility details should be confirmed with each venue before travelling.')
  const confidence = clamp(confidenceBase - warnings.length * 0.06 - errors.length * 0.08, 0.2, 0.98)
  const experience = {
    title: String(plan.title || 'Your SAPPO experience'),
    summary: UNSUPPORTED_LIVE_CLAIM.test(String(plan.summary || ''))
      ? 'A practical plan built around what you asked for.'
      : String(plan.summary || 'A practical plan built around what you asked for.'),
    sappoMessage: safeMessage(plan, context),
    reasons: acceptedReasons,
    stops,
    travelLegs,
    totalDurationMinutes,
    estimatedSpendPerPerson: spendEstimate(stops),
    warnings: [...new Set(warnings)],
    confidence: Math.round(confidence * 100) / 100,
  }
  return { valid: errors.length === 0, errors, warnings, experience }
}

module.exports = { validateExperience, spendEstimate, safeMessage, safeStopReason, allowedReason, travelLeg }
