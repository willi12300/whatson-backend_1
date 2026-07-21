function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const STOP = new Set(['the','a','an','and','at','of','in','on'])

function normaliseName(name) {
  if (!name) return ''
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0 && !STOP.has(w))
    .join(' ')
    .trim()
}

function normalisePhone(p) { return p ? p.replace(/\D/g, '') : '' }

function extractDomain(url) {
  if (!url) return null
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`)
    return u.hostname.replace(/^www\./, '')
  } catch { return null }
}

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1
  if (!s1.length || !s2.length) return 0
  const matchDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1
  const s1m = new Array(s1.length).fill(false)
  const s2m = new Array(s2.length).fill(false)
  let matches = 0, t = 0
  for (let i = 0; i < s1.length; i++) {
    const lo = Math.max(0, i - matchDist), hi = Math.min(i + matchDist + 1, s2.length)
    for (let j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue
      s1m[i] = s2m[j] = true; matches++; break
    }
  }
  if (!matches) return 0
  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1m[i]) continue
    while (!s2m[k]) k++
    if (s1[i] !== s2[k]) t++; k++
  }
  const jaro = (matches/s1.length + matches/s2.length + (matches - t/2)/matches) / 3
  let p = 0
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) { if (s1[i] === s2[i]) p++; else break }
  return jaro + p * 0.1 * (1 - jaro)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Google photo delivery ────────────────────────────────────────────────────
// Database rows contain historical Google Places media URLs. Never send their
// embedded API keys to the app. On Railway, rewrite them to SAPPO's own image
// route; that route contacts Google privately with the current server key.
function publicApiBase() {
  const configured = process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN
  const raw = configured || (railwayDomain ? `https://${railwayDomain}` : null)
  return raw ? String(raw).replace(/\/+$/, '') : null
}

function googlePhotoParts(url) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'places.googleapis.com') return null
    const match = parsed.pathname.match(/^\/v1\/(places\/[^/]+\/photos\/[^/]+)\/media$/)
    if (!match) return null
    const requested = Number(parsed.searchParams.get('maxWidthPx'))
    const width = Number.isFinite(requested) ? Math.max(100, Math.min(Math.round(requested), 1600)) : 900
    return { name: match[1], width }
  } catch { return null }
}

function repairPhotoUrl(url, currentKey) {
  const key = currentKey || process.env.GOOGLE_PLACES_API_KEY
  if (!url || typeof url !== 'string') return url
  const googlePhoto = googlePhotoParts(url)
  if (!googlePhoto) return url

  const base = publicApiBase()
  if (base) {
    return `${base}/media/google-photo?name=${encodeURIComponent(googlePhoto.name)}&width=${googlePhoto.width}`
  }

  // Local-development fallback when no public backend URL is available.
  if (!key) return url
  if (/[?&]key=/.test(url)) return url.replace(/([?&]key=)[^&]*/i, `$1${key}`)
  return url + (url.includes('?') ? '&' : '?') + `key=${key}`
}

// Repair every photo URL on a venue row/object IN PLACE-ish (returns a new
// object). Handles `cover_photo`, `photos` (array of strings or {url} objects),
// and `heroImages`. Safe to call on any venue shape; leaves non-Google URLs be.
function repairVenuePhotos(venue, currentKey) {
  if (!venue || typeof venue !== 'object') return venue
  const key = currentKey || process.env.GOOGLE_PLACES_API_KEY
  const fixOne = (p) => {
    if (!p) return p
    if (typeof p === 'string') return repairPhotoUrl(p, key)
    if (typeof p === 'object' && p.url) return { ...p, url: repairPhotoUrl(p.url, key) }
    return p
  }
  let photos = venue.photos
  if (typeof photos === 'string') { try { photos = JSON.parse(photos) } catch { /* leave */ } }
  const out = { ...venue }
  if (venue.cover_photo) out.cover_photo = repairPhotoUrl(venue.cover_photo, key)
  if (Array.isArray(photos)) out.photos = photos.map(fixOne)
  if (Array.isArray(venue.heroImages)) out.heroImages = venue.heroImages.map(p => repairPhotoUrl(p, key))
  return out
}

module.exports = { distanceMeters, normaliseName, normalisePhone, extractDomain, jaroWinkler, sleep, googlePhotoParts, repairPhotoUrl, repairVenuePhotos }
