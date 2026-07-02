// src/services/timeContext.js
// Time-of-day + daylight awareness for Sappo Roulette.
//
// Goal: make recommendations feel time-appropriate. Daytime favours outdoor,
// sightseeing, culture (viewpoints, piers, landmarks, museums, parks); evening
// favours bars, restaurants, nightlife, theatre. This is a WEIGHT, never a
// filter — a pier at dusk still shows, just ranked below evening options.
//
// Two parts:
//   1. Daylight: computed astronomically from latitude + date (no API, always
//      available even when the weather provider is rate-limited). This is what
//      makes 5pm feel like "still daytime" in a Liverpool June but "evening/
//      dark" in December.
//   2. Daypart weighting: given the hour, daylight state, and a venue's groups,
//      return a signed nudge, blended smoothly across daypart boundaries so
//      nothing snaps at an arbitrary clock minute.

// ── Sunrise/sunset (NOAA-style approximation) ──
// Returns { sunriseHour, sunsetHour } in LOCAL decimal hours for the given
// date + coordinates. Accurate to a few minutes — plenty for "is it light out".
function solarTimes(date, lat, lng, tzOffsetHours) {
  const rad = Math.PI / 180
  const deg = 180 / Math.PI

  // Day of year
  const start = new Date(date.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((date - start) / 86400000)

  // Fractional year (gamma) in radians
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + 0.5)

  // Equation of time (minutes) and solar declination (radians)
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma)
    - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma))
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma)

  // Hour angle for sunrise/sunset (zenith 90.833° accounts for refraction)
  const zenith = 90.833 * rad
  const latR = lat * rad
  const cosH = (Math.cos(zenith) - Math.sin(latR) * Math.sin(decl)) / (Math.cos(latR) * Math.cos(decl))

  // Polar day / polar night guards
  if (cosH > 1) return { sunriseHour: null, sunsetHour: null, polar: 'night' }   // sun never rises
  if (cosH < -1) return { sunriseHour: null, sunsetHour: null, polar: 'day' }    // sun never sets

  const ha = Math.acos(cosH) * deg   // degrees

  // Times in minutes from local midnight (using timezone offset + longitude)
  const solarNoon = 720 - 4 * lng - eqTime + tzOffsetHours * 60
  const sunriseMin = solarNoon - 4 * ha
  const sunsetMin = solarNoon + 4 * ha

  return { sunriseHour: sunriseMin / 60, sunsetHour: sunsetMin / 60, polar: null }
}

// Smooth 0..1 ramp between edge0 and edge1 (like GLSL smoothstep).
function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

// Build the full time context for a given moment + city coordinates.
// tzOffsetHours: local timezone offset from UTC (e.g. +1 for UK summer). If the
// server runs in a different tz, pass the CITY's offset so dayparts are local
// to the city, not the server. Defaults to the server's own offset.
function getTimeContext(date, lat, lng, tzOffsetHours) {
  const d = date || new Date()
  const tz = (typeof tzOffsetHours === 'number') ? tzOffsetHours : -d.getTimezoneOffset() / 60
  const hour = d.getHours() + d.getMinutes() / 60

  const { sunriseHour, sunsetHour, polar } = solarTimes(d, lat, lng, tz)

  // Daylight fraction: 1 = full daylight, 0 = full night, with smooth twilight
  // transitions ~1h around sunrise/sunset.
  let daylight
  let isDaylight
  if (polar === 'day') { daylight = 1; isDaylight = true }
  else if (polar === 'night') { daylight = 0; isDaylight = false }
  else {
    const rise = smoothstep(sunriseHour - 0.5, sunriseHour + 0.5, hour)
    const set = 1 - smoothstep(sunsetHour - 0.5, sunsetHour + 0.5, hour)
    daylight = Math.max(0, Math.min(rise, set))
    isDaylight = daylight > 0.5
  }

  // Coarse daypart label (for reasons/debug only; weighting uses the curves).
  let daypart
  if (hour < 6) daypart = 'late_night'
  else if (hour < 11) daypart = 'morning'
  else if (hour < 17) daypart = 'afternoon'
  else if (hour < 22) daypart = 'evening'
  else daypart = 'late_night'

  // "Eveningness" 0..1: how much the moment leans toward evening/night activity.
  // Driven by BOTH clock and darkness — an evening that's still bright (summer)
  // leans less hard toward nightlife than a dark winter evening at the same hour.
  const clockEvening = smoothstep(15, 20, hour)                    // ramps up mid-afternoon → 8pm
  const darkness = 1 - daylight
  const eveningness = Math.max(0, Math.min(1, 0.6 * clockEvening + 0.4 * darkness))

  return {
    hour, daypart, daylight, isDaylight, eveningness,
    sunriseHour, sunsetHour,
  }
}

// Given a venue's groups (Set) and the time context, return a signed nudge on
// the SappoScore's 0..100 scale (before mode-scaling). Positive = time-
// appropriate, negative = time-inappropriate. Deliberately modest — this
// colours the ranking, it doesn't dominate quality/uniqueness.
const MAX_NUDGE = 18

function timeOfDayNudge(groups, ctx) {
  if (!groups || groups.size === 0) return { nudge: 0, reason: null }
  const day = ctx.daylight              // 1 daytime … 0 night
  const eve = ctx.eveningness           // 0 … 1 evening/night
  let nudge = 0
  let reason = null

  // Daytime-favoured: scenic outdoors + sightseeing/culture.
  if (groups.has('scenic')) {
    // Strongly daytime — outdoor viewpoints/piers/parks are a daytime pleasure,
    // and pointless after dark. Reward in daylight, penalise at night.
    nudge += (day - 0.5) * 2 * MAX_NUDGE
    if (day > 0.6) reason = 'great while it\'s light out'
  }
  if (groups.has('tourist')) {
    // Sightseeing/culture leans daytime but many are indoors (museums), so a
    // gentler daytime lean than scenic.
    nudge += (day - 0.5) * MAX_NUDGE
    if (day > 0.6 && !reason) reason = 'perfect for daytime exploring'
  }

  // Evening-favoured: drinks, nightlife, (and food leans dinner-ward later).
  if (groups.has('nightlife')) {
    // Clubs/late bars — strongly evening/night. Small penalty in bright daytime.
    nudge += (eve - 0.5) * 2 * MAX_NUDGE
    if (eve > 0.6) reason = 'right for the evening'
  }
  if (groups.has('drinks')) {
    nudge += (eve - 0.45) * MAX_NUDGE
    if (eve > 0.6 && !reason) reason = 'good for evening drinks'
  }

  // Food is bimodal: lunch bump midday, dinner bump evening, neutral between.
  if (groups.has('food')) {
    const h = ctx.hour
    const lunch = smoothstep(11, 12.5, h) * (1 - smoothstep(14, 15.5, h))   // ~12–14
    const dinner = smoothstep(17.5, 19, h) * (1 - smoothstep(21.5, 23, h))  // ~18–22
    const meal = Math.max(lunch, dinner)
    nudge += meal * (MAX_NUDGE * 0.5)
    if (meal > 0.6 && !reason) reason = h < 15 ? 'good for lunch' : 'good for dinner'
  }

  // Clamp so a venue in several groups can't stack an outsized swing.
  nudge = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, nudge))
  return { nudge, reason }
}

module.exports = { getTimeContext, timeOfDayNudge, solarTimes, MAX_NUDGE }
