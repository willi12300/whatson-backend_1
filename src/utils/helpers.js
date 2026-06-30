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

// Google Place photo URLs embed the API key, so they break when the key changes.
// Rewrite to the CURRENT key at serve time. Safe on non-Google URLs (returns as-is).
function repairPhotoUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (!url.includes('places.googleapis.com')) return url
  let key
  try { key = require('../config').config.google?.key } catch { key = null }
  if (!key) return url
  if (/[?&]key=/.test(url)) return url.replace(/([?&]key=)[^&]*/, `$1${key}`)
  return url + (url.includes('?') ? '&' : '?') + `key=${key}`
}
function repairVenuePhotos(v) {
  if (!v) return v
  const out = { ...v }
  if (out.cover_photo) out.cover_photo = repairPhotoUrl(out.cover_photo)
  if (Array.isArray(out.photos)) out.photos = out.photos.map(p => (typeof p === 'string' ? repairPhotoUrl(p) : (p && p.url ? { ...p, url: repairPhotoUrl(p.url) } : p)))
  return out
}

module.exports = { distanceMeters, normaliseName, normalisePhone, extractDomain, jaroWinkler, sleep, repairPhotoUrl, repairVenuePhotos }
