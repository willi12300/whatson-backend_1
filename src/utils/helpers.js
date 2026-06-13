// src/utils/helpers.js
// Geo distance, string normalisation, and fuzzy matching — no external deps.

/** Haversine distance in metres between two coordinates. */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'at', 'of', 'in', 'on', 'bar', 'pub'])

/** Normalise a venue name for comparison. "The Owl & Anchor" -> "owl anchor" */
function normaliseName(name) {
  if (!name) return ''
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w))
    .join(' ')
    .trim()
}

/** Strip a phone number to digits only. */
function normalisePhone(phone) {
  return phone ? phone.replace(/\D/g, '') : ''
}

/** Pull the domain out of a website URL. */
function extractDomain(url) {
  if (!url) return null
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Jaro-Winkler string similarity, 0..1. Good for pub/venue names. */
function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1
  if (!s1.length || !s2.length) return 0

  const matchDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1
  const s1Matches = new Array(s1.length).fill(false)
  const s2Matches = new Array(s2.length).fill(false)
  let matches = 0
  let transpositions = 0

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDist)
    const end = Math.min(i + matchDist + 1, s2.length)
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue
      s1Matches[i] = true
      s2Matches[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0

  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue
    while (!s2Matches[k]) k++
    if (s1[i] !== s2[k]) transpositions++
    k++
  }

  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3

  let prefix = 0
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** Sleep helper for rate limiting. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

module.exports = {
  distanceMeters,
  normaliseName,
  normalisePhone,
  extractDomain,
  jaroWinkler,
  sleep,
}
