// src/services/busyEstimate.js
// Estimates how busy a venue is likely to be, using ONLY legal/available signals:
// category, day/time heuristics, rating volume, and known event start times.
// No scraping of Google popular-times (not in the official API).

// Returns { level, reason, confidence } where level is quiet|moderate|busy|very_busy
function estimateBusy(venue, { when = new Date(), events = [] } = {}) {
  const day = when.getDay()          // 0 Sun .. 6 Sat
  const hour = when.getHours()
  const isWeekend = day === 5 || day === 6
  const isFriSat = day === 5 || day === 6
  const cat = venue.category_slug || 'other'

  let score = 0
  const reasons = []

  // Time-of-day patterns by category
  const nightlife = ['bar', 'nightclub', 'pub', 'music_venue'].includes(cat)
  const food = ['restaurant', 'cafe'].includes(cat)

  if (nightlife) {
    if (hour >= 21 || hour < 2) { score += 2; reasons.push('peak nightlife hours') }
    else if (hour >= 18) { score += 1 }
  }
  if (food) {
    if ((hour >= 12 && hour <= 14) || (hour >= 18 && hour <= 20)) { score += 2; reasons.push('typical meal rush') }
  }

  // Weekend bump
  if (isFriSat && (nightlife || food)) { score += 1; reasons.push('weekend') }
  else if (isWeekend) { score += 0.5 }

  // Popularity (lots of reviews + high rating = generally busier)
  const reviews = venue.rating_count || venue.user_ratings_total || 0
  if (reviews > 1000 && (venue.rating || 0) >= 4.3) { score += 1; reasons.push('very popular spot') }
  else if (reviews > 300) { score += 0.5 }

  // A live event starting soon at this venue is a strong signal
  const soonEvent = events.find(e => {
    if (e.venue_id !== venue.id) return false
    const start = new Date(e.starts_at)
    const diffH = (start - when) / 36e5
    return diffH >= -1 && diffH <= 3
  })
  if (soonEvent) {
    score += 2
    const t = new Date(soonEvent.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    reasons.push(`${soonEvent.name || 'an event'} starts ${t}`)
  }

  // Map score → level
  let level = 'quiet', confidence = 0.5
  if (score >= 4) { level = 'very_busy'; confidence = 0.7 }
  else if (score >= 2.5) { level = 'busy'; confidence = 0.65 }
  else if (score >= 1) { level = 'moderate'; confidence = 0.6 }
  else { level = 'quiet'; confidence = 0.55 }

  // Confidence is modest by design — these are heuristics, not live data.
  const reason = reasons.length
    ? capitalize(reasons.slice(0, 2).join(', '))
    : 'Based on typical patterns for this kind of place'

  return { level, reason, confidence: Math.round(confidence * 100) / 100 }
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1) }

// Human label + emoji for UI
function busyLabel(level) {
  switch (level) {
    case 'very_busy': return { text: 'Very busy', icon: '🔴' }
    case 'busy': return { text: 'Likely busy', icon: '🟠' }
    case 'moderate': return { text: 'Moderate', icon: '🟡' }
    default: return { text: 'Quiet now', icon: '🟢' }
  }
}

module.exports = { estimateBusy, busyLabel }
