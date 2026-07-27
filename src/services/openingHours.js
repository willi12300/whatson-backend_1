// Time-aware venue availability. This is intentionally pure: every
// recommendation pipeline uses the same rules before a venue can be selected.

const CITY_TIMEZONES = {
  liverpool: 'Europe/London', manchester: 'Europe/London', london: 'Europe/London',
  chester: 'Europe/London', birmingham: 'Europe/London', leeds: 'Europe/London',
  glasgow: 'Europe/London', edinburgh: 'Europe/London',
}

function asObject(value) {
  if (!value) return null
  if (typeof value === 'string') { try { return JSON.parse(value) } catch { return null } }
  return typeof value === 'object' ? value : null
}

function timezoneFor(city, supplied) {
  if (supplied && typeof supplied === 'string') return supplied
  return CITY_TIMEZONES[String(city || '').trim().toLowerCase()] || 'Europe/London'
}

function localParts(at, timezone) {
  const bits = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(at)
  const get = type => bits.find(x => x.type === type)?.value
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { day: weekday < 0 ? 0 : weekday, hour: Number(get('hour')), minute: Number(get('minute')) }
}

function toMinute(point) {
  if (!point) return null
  const hour = Number(point.hour ?? 0), minute = Number(point.minute ?? 0)
  return hour * 60 + minute
}

function sourcePeriods(raw) {
  const hours = asObject(raw)
  if (!hours) return []
  return Array.isArray(hours.periods) ? hours.periods : (Array.isArray(hours.openingHours?.periods) ? hours.openingHours.periods : [])
}

function normaliseOpeningHours(raw, { city, timezone } = {}) {
  const source = asObject(raw)
  if (!source) return null
  const periods = sourcePeriods(source)
  const isOpenNow = typeof source.isOpenNow === 'boolean' ? source.isOpenNow
    : (typeof source.openNow === 'boolean' ? source.openNow : (typeof source.open_now === 'boolean' ? source.open_now : null))
  const opensAt = source.opensAt || source.nextOpenTime || source.next_open || source.next_open_time || null
  const closesAt = source.closesAt || source.nextCloseTime || source.next_close || source.next_close_time || null
  return {
    isOpenNow,
    opensAt,
    closesAt,
    openingHours: periods,
    periods,
    weekdayDescriptions: source.weekdayDescriptions || source.weekday_text || source.weekday_descriptions || [],
    nextOpenTime: source.nextOpenTime || source.next_open || source.next_open_time || null,
    timezone: timezoneFor(city, source.timezone || timezone),
    source: source.source || 'google',
    checkedAt: source.checkedAt || source.checked_at || null,
  }
}

function weeklyIntervals(periods) {
  const out = []
  for (const period of periods || []) {
    if (!period?.open) continue
    const openDay = Number(period.open.day ?? 0)
    const openAt = toMinute(period.open)
    if (!Number.isFinite(openDay) || openAt == null) continue
    let start = openDay * 1440 + openAt
    // Google represents a continuously open place with one open point and no close.
    if (!period.close) { out.push({ start: 0, end: 7 * 1440 }); continue }
    const closeDay = Number(period.close.day ?? openDay)
    const closeAt = toMinute(period.close)
    if (!Number.isFinite(closeDay) || closeAt == null) continue
    let end = closeDay * 1440 + closeAt
    if (end <= start) end += 7 * 1440
    out.push({ start, end })
  }
  return out
}

function formatTime(at, timezone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

function evaluateOpeningHours(raw, arrivalAt = new Date(), { city, timezone, durationMinutes = 60 } = {}) {
  const hours = normaliseOpeningHours(raw, { city, timezone })
  const tz = hours?.timezone || timezoneFor(city, timezone)
  if (!hours || !hours.periods.length) return { eligible: false, status: 'unknown_hours', timezone: tz, reason: 'Opening hours are not verified.' }
  const local = localParts(arrivalAt, tz)
  const startMinute = local.day * 1440 + local.hour * 60 + local.minute
  const endMinute = startMinute + Math.max(1, Number(durationMinutes) || 60)
  const intervals = weeklyIntervals(hours.periods)
  const matching = intervals.find(interval => [startMinute - 10080, startMinute, startMinute + 10080].some(shifted => shifted >= interval.start && shifted + Math.max(1, Number(durationMinutes) || 60) <= interval.end))
  if (!matching) {
    return { eligible: false, status: 'closed_at_arrival', timezone: tz, arrivalAt: arrivalAt.toISOString(), reason: `Closed when you would arrive at ${formatTime(arrivalAt, tz)}.` }
  }
  const closeMinute = matching.end % 10080
  const closeDate = new Date(arrivalAt.getTime() + Math.max(0, closeMinute - (startMinute % 10080)) * 60000)
  return {
    eligible: true,
    status: 'open_at_arrival',
    timezone: tz,
    arrivalAt: arrivalAt.toISOString(),
    opensAt: hours.opensAt || null,
    closesAt: hours.closesAt || closeDate.toISOString(),
    openingHours: hours.weekdayDescriptions,
    nextOpenTime: hours.nextOpenTime || null,
    reason: `Included because your visit is planned for ${formatTime(arrivalAt, tz)}.`,
  }
}

function visitDurationMinutes(venue) {
  const category = String(venue?.category_slug || venue?.category || '').toLowerCase()
  if (/museum|gallery|attraction|landmark|park/.test(category)) return 90
  if (/restaurant|food|diner/.test(category)) return 90
  if (/bar|pub|club|music/.test(category)) return 75
  return 45
}

function isTimeAppropriate(venue, arrivalAt = new Date(), { city, timezone } = {}) {
  const category = String(venue?.category_slug || venue?.category || '').toLowerCase()
  const hour = localParts(arrivalAt, timezoneFor(city, timezone)).hour
  if (/cafe|coffee|bakery|breakfast|brunch/.test(category)) return hour >= 6 && hour < 18
  if (/museum|gallery|attraction|landmark|park/.test(category)) return hour >= 8 && hour < 19
  if (/nightclub|night_club|club/.test(category)) return hour >= 19 || hour < 5
  if (/bar|pub|cocktail|wine|brewery|music/.test(category)) return hour >= 12 || hour < 3
  return true
}

function estimatedWalkMinutes(from, to) {
  if (![from?.lat, from?.lng, to?.lat, to?.lng].every(Number.isFinite)) return 10
  const r = x => x * Math.PI / 180, R = 6371
  const dLat = r(to.lat - from.lat), dLng = r(to.lng - from.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(from.lat)) * Math.cos(r(to.lat)) * Math.sin(dLng / 2) ** 2
  return Math.max(3, Math.round((2 * R * Math.asin(Math.sqrt(h)) / 5) * 60))
}

function estimateItinerarySchedule(stops, { startAt = new Date(), origin = null, city, timezone, transportMode = 'walking' } = {}) {
  let cursor = new Date(startAt)
  let previous = origin
  return (stops || []).map((venue, index) => {
    const travelMinutes = index === 0 ? (previous ? estimatedWalkMinutes(previous, venue) : 5) : estimatedWalkMinutes(previous, venue)
    const multiplier = transportMode === 'driving' ? 0.55 : 1
    cursor = new Date(cursor.getTime() + Math.max(2, Math.round(travelMinutes * multiplier)) * 60000)
    const durationMinutes = visitDurationMinutes(venue)
    const availability = evaluateOpeningHours(venue.opening_hours || venue.openingHours, cursor, { city, timezone, durationMinutes })
    const stop = { ...venue, estimatedArrivalAt: cursor.toISOString(), estimatedArrivalTime: formatTime(cursor, availability.timezone || timezoneFor(city, timezone)), estimatedTravelMinutes: travelMinutes, visitDurationMinutes: durationMinutes, availability }
    cursor = new Date(cursor.getTime() + durationMinutes * 60000)
    previous = venue
    return stop
  })
}

function candidateSlots(startAt, count = 3) {
  const slots = []
  let cursor = new Date(startAt)
  for (let i = 0; i < count; i++) { cursor = new Date(cursor.getTime() + (i === 0 ? 5 : 85) * 60000); slots.push(cursor) }
  return slots
}

function filterCandidatesForPlan(candidates, opts = {}) {
  const slots = candidateSlots(opts.startAt || new Date(), opts.stops || 3)
  return (candidates || []).filter(venue => slots.some(arrival =>
    isTimeAppropriate(venue, arrival, opts) && evaluateOpeningHours(venue.opening_hours || venue.openingHours, arrival, { city: opts.city, timezone: opts.timezone, durationMinutes: visitDurationMinutes(venue) }).eligible
  ))
}

function apiHours(raw, opts = {}) {
  const h = normaliseOpeningHours(raw, opts)
  if (!h) return { isOpenNow: null, opensAt: null, closesAt: null, openingHours: [], nextOpenTime: null, timezone: timezoneFor(opts.city, opts.timezone) }
  return { isOpenNow: h.isOpenNow, opensAt: h.opensAt, closesAt: h.closesAt, openingHours: h.weekdayDescriptions, nextOpenTime: h.nextOpenTime, timezone: h.timezone }
}

module.exports = { normaliseOpeningHours, evaluateOpeningHours, estimateItinerarySchedule, filterCandidatesForPlan, visitDurationMinutes, isTimeAppropriate, apiHours, timezoneFor }
