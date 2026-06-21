const axios = require('axios')
const { config } = require('../config')
const logger = require('../utils/logger')

const BASE = 'https://api.content.tripadvisor.com/api/v1'

function hasTripAdvisor() {
  return !!config.tripadvisor?.key
}

function normaliseCategory(categorySlug) {
  if (!categorySlug) return undefined
  const cat = String(categorySlug).toLowerCase()
  if (['restaurant', 'cafe', 'bakery', 'food', 'brunch'].includes(cat)) return 'restaurants'
  if (['hotel', 'lodging', 'accommodation'].includes(cat)) return 'hotels'
  // TripAdvisor puts bars, clubs, music venues, cinemas and attractions under attractions/things to do.
  if (['bar', 'pub', 'nightclub', 'club', 'music_venue', 'comedy_club', 'cinema', 'attraction', 'landmark', 'museum'].includes(cat)) return 'attractions'
  return 'attractions'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatLatLong(lat, lng) {
  if (lat == null || lng == null) return undefined
  const la = Number(lat)
  const lo = Number(lng)
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return undefined
  return `${la.toFixed(6)},${lo.toFixed(6)}`
}

function normaliseText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanSearchName(name) {
  return String(name || '')
    .replace(/[’`´]/g, "'")
    .replace(/\b(cocktail bar|bar|pub|club|nightclub|restaurant|cafe|coffee shop|venue|liverpool|manchester|uk|united kingdom)\b/ig, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function noPunctuationVariant(name) {
  return String(name || '')
    .replace(/[’'`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractPostcode(address = '') {
  const m = String(address || '').match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i)
  return m ? m[0].toUpperCase() : null
}

function extractCity(address = '') {
  const a = String(address || '')
  const known = ['Liverpool', 'Manchester', 'London', 'Birmingham', 'Leeds', 'Chester', 'York', 'Edinburgh', 'Glasgow', 'Cardiff', 'Bristol', 'Newcastle']
  return known.find(c => new RegExp(`\\b${c}\\b`, 'i').test(a)) || null
}

function tokenSet(value) {
  const stop = new Set(['the', 'and', 'of', 'at', 'in', 'on', 'to', 'a', 'an', 'liverpool', 'manchester', 'uk', 'united', 'kingdom'])
  return new Set(normaliseText(value).split(' ').filter(w => w.length > 1 && !stop.has(w)))
}

function tokenSimilarity(a, b) {
  const A = tokenSet(a)
  const B = tokenSet(b)
  if (!A.size || !B.size) return 0
  const overlap = [...A].filter(w => B.has(w)).length
  const union = new Set([...A, ...B]).size
  return overlap / union
}

function tripadvisorMatchScore({ query, venueName, itemName, itemAddress, venueAddress, itemDistance }) {
  const item = normaliseText(itemName)
  const venue = normaliseText(venueName)
  const q = normaliseText(query)
  let score = 0

  if (item && venue && item === venue) score += 100
  if (item && venue && (item.includes(venue) || venue.includes(item))) score += 45
  if (item && q && (item.includes(q) || q.includes(item))) score += 25
  score += Math.round(tokenSimilarity(venueName, itemName) * 45)

  const postcode = extractPostcode(venueAddress)
  if (postcode && normaliseText(itemAddress).includes(normaliseText(postcode))) score += 30
  const city = extractCity(venueAddress)
  if (city && normaliseText(itemAddress).includes(normaliseText(city))) score += 15

  const d = Number(itemDistance)
  if (Number.isFinite(d)) {
    // TripAdvisor distance appears to be miles/km depending response; treat small values as strong signal.
    if (d <= 0.2) score += 30
    else if (d <= 0.7) score += 20
    else if (d <= 2) score += 10
    else if (d > 10) score -= 20
  }

  // Avoid obviously unrelated results even when near.
  if (tokenSimilarity(venueName, itemName) === 0 && score < 35) score -= 25
  return score
}

function buildTripAdvisorQueries({ name, address, city }) {
  const out = []
  const push = q => {
    q = String(q || '').replace(/\s+/g, ' ').trim()
    if (q && !out.some(x => normaliseText(x) === normaliseText(q))) out.push(q)
  }
  const cleaned = cleanSearchName(name)
  const noPunc = noPunctuationVariant(name)
  const resolvedCity = city || extractCity(address)

  // Keep this intentionally short. Too many variants burn TripAdvisor quota and trigger 429s.
  if (resolvedCity) push(`${name} ${resolvedCity}`)
  push(name)
  if (noPunc && noPunc !== name && resolvedCity) push(`${noPunc} ${resolvedCity}`)
  if (cleaned && cleaned !== name && resolvedCity) push(`${cleaned} ${resolvedCity}`)
  if (cleaned && cleaned !== name) push(cleaned)

  return out.slice(0, 5)
}

function buildTripAdvisorCategories(categorySlug) {
  const primary = normaliseCategory(categorySlug)
  const slug = String(categorySlug || '').toLowerCase()
  const out = []
  const push = c => {
    if (!out.includes(c)) out.push(c)
  }

  // First request without category often performs best across mixed venue types.
  push(undefined)
  if (primary) push(primary)

  if (['bar', 'pub', 'nightclub', 'club', 'music_venue', 'comedy_club', 'cinema', 'attraction', 'landmark', 'museum'].includes(slug)) {
    push('attractions')
    push('restaurants') // pubs/bars are sometimes categorised as restaurants on TripAdvisor.
  }
  if (['restaurant', 'cafe', 'bakery', 'food', 'brunch'].includes(slug)) {
    push('restaurants')
    push('attractions')
  }
  return out.slice(0, 3)
}

async function searchTripAdvisorLocation({ name, lat, lng, address, categorySlug, radiusKm = 10, city, debug = false }) {
  if (!hasTripAdvisor() || !name) return null

  const latLong = formatLatLong(lat, lng)
  const baseParams = {
    key: config.tripadvisor.key,
    language: 'en',
  }
  if (latLong) {
    baseParams.latLong = latLong
    baseParams.radius = radiusKm
    baseParams.radiusUnit = 'km'
  }

  const resolvedCity = city || extractCity(address)
  const queryVariants = buildTripAdvisorQueries({ name, address, city: resolvedCity })
  const categories = buildTripAdvisorCategories(categorySlug)
  const debugInfo = {
    name,
    city: resolvedCity,
    categorySlug,
    latLong,
    queriesTried: [],
    rawResults: [],
    selected: null,
    status: 'pending',
  }

  let allLocations = []
  let wasRateLimited = false
  const seen = new Set()

  for (const q of queryVariants) {
    for (const category of categories) {
      const extra = category ? { searchQuery: q, category } : { searchQuery: q }
      const key = JSON.stringify(extra)
      if (seen.has(key)) continue
      seen.add(key)
      debugInfo.queriesTried.push(extra)
      try {
        const res = await axios.get(`${BASE}/location/search`, {
          params: { ...baseParams, ...extra },
          timeout: 5000,
        })
        const locations = res.data?.data || []
        debugInfo.rawResults.push({ query: extra, count: locations.length, sample: locations.slice(0, 5).map(l => ({ location_id: l.location_id, name: l.name, address: l.address_obj?.address_string || l.address_string, distance: l.distance })) })
        if (locations.length) {
          allLocations = allLocations.concat(locations.map(l => ({ ...l, _query: q, _category: category })))
        }
        // A tiny delay prevents bursts from being rejected when bulk syncing.
        await sleep(250)
      } catch (err) {
        const status = err.response?.status
        debugInfo.rawResults.push({ query: extra, error: status || err.message })
        logger.error('[tripadvisor] search failed:', status || err.message)
        if (status === 429) {
          wasRateLimited = true
          debugInfo.status = 'rate_limited'
          break
        }
      }
    }
    if (wasRateLimited) break
  }

  if (wasRateLimited && !allLocations.length) {
    const out = { _rateLimited: true, _debug: debugInfo }
    return out
  }

  if (!allLocations.length) {
    debugInfo.status = 'no_results'
    logger.info(`[tripadvisor] no results for ${name}; tried ${seen.size} searches`)
    return debug ? { _noMatch: true, _debug: debugInfo } : null
  }

  const sorted = allLocations
    .map(item => ({
      ...item,
      _score: tripadvisorMatchScore({
        query: item._query,
        venueName: name,
        itemName: item.name,
        itemAddress: item.address_obj?.address_string || item.address_string || '',
        venueAddress: address || '',
        itemDistance: item.distance,
      }),
    }))
    .sort((a, b) => b._score - a._score)

  const best = sorted[0] || null
  debugInfo.selected = best ? { location_id: best.location_id, name: best.name, score: best._score, address: best.address_obj?.address_string || best.address_string, distance: best.distance } : null
  debugInfo.rawResults = debugInfo.rawResults.slice(0, 12)

  // Require a GENUINE name match — distance + city proximity alone must NOT be enough,
  // or a nearby McDonald's wins the match for a pub. The names themselves must overlap.
  const nameSim = best ? tokenSimilarity(normaliseText(name), normaliseText(best.name || '')) : 0
  const MIN_SCORE = 55           // raised from 35 — weak matches were accepting wrong venues
  const MIN_NAME_SIM = 0.45      // names must actually resemble each other

  if (!best || best._score < MIN_SCORE || nameSim < MIN_NAME_SIM) {
    debugInfo.status = 'low_confidence'
    logger.info(`[tripadvisor] rejected weak match for ${name}; best=${best?.name || 'none'} score=${best?._score || 0} nameSim=${nameSim.toFixed(2)}`)
    return debug ? { _noMatch: true, _debug: debugInfo, _candidates: sorted.slice(0, 10).map(x => ({ location_id: x.location_id, name: x.name, score: x._score, address: x.address_obj?.address_string || x.address_string, distance: x.distance })) } : null
  }

  debugInfo.status = 'matched'
  best._debug = debugInfo
  logger.info(`[tripadvisor] match ${name} -> ${best.name || best.location_id} (${best.location_id}) score=${best._score} nameSim=${nameSim.toFixed(2)}`)
  return best
}

async function getTripAdvisorDetails(locationId) {
  if (!hasTripAdvisor() || !locationId) return null
  try {
    const res = await axios.get(`${BASE}/location/${locationId}/details`, {
      params: { key: config.tripadvisor.key, language: 'en', currency: 'GBP' },
      timeout: 5000,
    })
    return res.data || null
  } catch (err) {
    logger.error('[tripadvisor] details failed:', err.response?.status || err.message)
    return null
  }
}

async function getTripAdvisorReviews(locationId) {
  if (!hasTripAdvisor() || !locationId) return []
  try {
    const res = await axios.get(`${BASE}/location/${locationId}/reviews`, {
      params: { key: config.tripadvisor.key, language: 'en' },
      timeout: 5000,
    })
    return res.data?.data || []
  } catch (err) {
    logger.error('[tripadvisor] reviews failed:', err.response?.status || err.message)
    return []
  }
}

function normaliseTripAdvisor({ search, details, reviews }) {
  if (!search && !details) return null
  const d = details || {}
  const top = reviews?.[0] || null
  return {
    locationId: String(d.location_id || search?.location_id || search?.locationId || ''),
    rating: d.rating != null ? Number(d.rating) : null,
    reviewCount: d.num_reviews != null ? Number(d.num_reviews) : null,
    ranking: d.ranking_data?.ranking_string || d.ranking || null,
    url: d.web_url || null,
    photoUrl: d.photo?.images?.large?.url || d.photo?.images?.medium?.url || null,
    topReview: top ? {
      text: top.text || top.title || null,
      author: top.user?.username || top.author || 'TripAdvisor traveller',
      rating: top.rating != null ? Number(top.rating) : null,
      publishedDate: top.published_date || null,
      url: top.url || null,
      source: 'tripadvisor',
    } : null,
    debug: search?._debug || null,
    raw: { search, details, reviews: reviews?.slice?.(0, 3) || [] },
  }
}

async function enrichTripAdvisorForVenue(venue, opts = {}) {
  if (!hasTripAdvisor()) return null
  const search = venue.tripadvisor_location_id
    ? { location_id: venue.tripadvisor_location_id, locationId: venue.tripadvisor_location_id, name: venue.name, _debug: { status: 'cached_location_id' } }
    : await searchTripAdvisorLocation({
        name: venue.name,
        lat: venue.lat,
        lng: venue.lng,
        address: venue.address,
        city: venue.city,
        categorySlug: venue.category_slug,
        debug: opts.debug,
      })

  if (search?._rateLimited) return { rateLimited: true, debug: search._debug }
  if (search?._noMatch) return { noMatch: true, debug: search._debug, candidates: search._candidates || [] }

  const locationId = search?.location_id || search?.locationId || venue.tripadvisor_location_id
  if (!locationId) return null

  const [details, reviews] = await Promise.all([
    getTripAdvisorDetails(locationId),
    getTripAdvisorReviews(locationId),
  ])
  return normaliseTripAdvisor({ search, details, reviews })
}

module.exports = {
  hasTripAdvisor,
  searchTripAdvisorLocation,
  getTripAdvisorDetails,
  getTripAdvisorReviews,
  enrichTripAdvisorForVenue,
}
