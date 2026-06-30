const { query } = require('../db/pool')
const { distanceMeters } = require('../utils/helpers')
const { estimateBusy } = require('./busyEstimate')
const { enrichTripAdvisorForVenue, hasTripAdvisor } = require('../clients/tripadvisor')
const { getPlaceDetails, findPlaceDetails } = require('../clients/google')
const { config } = require('../config')
const logger = require('../utils/logger')

// Google Place photo URLs embed the API key. When the key changes (e.g. account
// switch), every saved URL breaks. This rewrites any Google photo URL to use the
// CURRENT key at serve time — so existing AND new photos always work, and a future
// key change never breaks images again.
function repairPhotoUrl(url) {
  if (!url || typeof url !== 'string') return url
  if (!url.includes('places.googleapis.com')) return url   // only Google photo URLs
  const currentKey = config.google?.key
  if (!currentKey) return url
  // swap whatever key= is in there for the current one (or add it if missing)
  if (/[?&]key=/.test(url)) return url.replace(/([?&]key=)[^&]*/, `$1${currentKey}`)
  return url + (url.includes('?') ? '&' : '?') + `key=${currentKey}`
}
function repairPhoto(p) {
  if (!p) return p
  if (typeof p === 'string') return repairPhotoUrl(p)
  if (p.url) return { ...p, url: repairPhotoUrl(p.url) }
  return p
}

function toNum(x) {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}

function asJson(value, fallback = null) {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try { return JSON.parse(value) } catch { return fallback }
  }
  return value
}



function normalizeOpeningHours(raw) {
  const oh = asJson(raw, null)
  if (!oh || typeof oh !== 'object') return null
  const openNow = typeof oh.openNow === 'boolean' ? oh.openNow : (typeof oh.open_now === 'boolean' ? oh.open_now : null)
  const nextOpen = oh.nextOpenTime || oh.next_open_time || oh.next_open || null
  const nextClose = oh.nextCloseTime || oh.next_close_time || oh.next_close || null
  const weekday = oh.weekdayDescriptions || oh.weekday_text || oh.weekday_descriptions || []
  return {
    ...oh,
    openNow,
    open_now: openNow,
    next_open: nextOpen,
    next_close: nextClose,
    weekday_text: weekday,
    source: oh.source || 'google',
    checked_at: new Date().toISOString(),
  }
}

function isHoursFresh(v, maxMinutes = 15) {
  const oh = asJson(v.opening_hours, null)
  const checkedRaw = oh?.checked_at || v.google_last_checked || v.profile_last_enriched || null
  if (!checkedRaw) return false
  const checked = new Date(checkedRaw)
  if (Number.isNaN(checked.getTime())) return false
  return (Date.now() - checked.getTime()) < maxMinutes * 60 * 1000
}

function walkMinutes(meters) {
  if (meters == null) return null
  return Math.max(1, Math.round(Number(meters) / 80))
}

function driveMinutes(meters) {
  if (meters == null) return null
  return Math.max(2, Math.round(Number(meters) / 420))
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function buildGoogleMapsUrl(v) {
  if (v.google_maps_url) return v.google_maps_url
  if (v.google_place_id) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=${encodeURIComponent(v.google_place_id)}`
  if (v.lat != null && v.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name || ''} ${v.address || ''}`)}`
}

function isOpenNow(v) {
  const oh = asJson(v.opening_hours, {}) || {}
  if (typeof oh.open_now === 'boolean') return oh.open_now
  if (typeof oh.openNow === 'boolean') return oh.openNow
  // Google businessStatus means the place exists/operates generally. It does NOT mean open right now.
  // Unknown hours should stay unknown rather than defaulting to open.
  return null
}

function nextOpenText(v) {
  const oh = asJson(v.opening_hours, {}) || {}
  const next = oh.next_open || oh.nextOpenTime || oh.next_open_time || null
  if (!next) return null
  try {
    return `Opens ${new Date(next).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
  } catch { return 'Opens soon' }
}

function closesText(v) {
  const oh = asJson(v.opening_hours, {}) || {}
  if (oh.closeText) return oh.closeText
  if (oh.today_close) return `Closes ${oh.today_close}`
  const nextClose = oh.next_close || oh.nextCloseTime || oh.next_close_time || null
  if (nextClose) {
    try { return `Closes ${new Date(nextClose).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` } catch {}
  }
  const weekday = oh.weekdayDescriptions || oh.weekday_descriptions || oh.weekday_text
  if (Array.isArray(weekday) && weekday.length) return 'Hours available'
  return null
}

function deriveSappoScore({ googleRating, googleReviews, tripRating, tripReviews, distanceM, openNow, busyLevel, categoryMatch = true }) {
  let score = 62
  if (googleRating) score += Math.min(20, Math.max(0, (googleRating - 3.4) * 14))
  if (tripRating) score += Math.min(12, Math.max(0, (tripRating - 3.5) * 10))
  const reviews = Math.max(Number(googleReviews || 0), Number(tripReviews || 0))
  if (reviews > 2000) score += 7
  else if (reviews > 700) score += 5
  else if (reviews > 150) score += 3
  if (distanceM != null) {
    if (distanceM < 500) score += 8
    else if (distanceM < 1200) score += 6
    else if (distanceM < 2500) score += 3
  }
  if (openNow) score += 5
  if (busyLevel === 'quiet' || busyLevel === 'moderate') score += 3
  if (busyLevel === 'very_busy') score -= 3
  if (categoryMatch) score += 4
  return Math.max(45, Math.min(98, Math.round(score)))
}

function categoryLabel(slug) {
  const map = {
    restaurant: 'Restaurant', cafe: 'Coffee Shop', bar: 'Bar', pub: 'Pub', nightclub: 'Club',
    music_venue: 'Live Music', comedy_club: 'Comedy', tourist_attraction: 'Attraction', museum: 'Museum',
    art_gallery: 'Gallery', park: 'Park', other: 'Venue',
  }
  return map[slug] || String(slug || 'Venue').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function buildTags(v) {
  const tags = [categoryLabel(v.category_slug)]
  const name = `${v.name || ''} ${v.category_slug || ''} ${v.cuisine_type || ''} ${v.menu_summary || ''}`.toLowerCase()
  if (/cafe|coffee/.test(name)) tags.push('Breakfast', 'Brunch')
  if (/restaurant|food/.test(name)) tags.push('Food')
  if (/bar|pub|cocktail/.test(name)) tags.push('Drinks')
  if (/museum|gallery|attraction|landmark/.test(name)) tags.push('Culture')
  return [...new Set(tags)].slice(0, 4)
}

function buildVibeTags(v, busyLevel) {
  const s = `${v.name || ''} ${v.category_slug || ''} ${v.description || ''} ${v.cuisine_type || ''}`.toLowerCase()
  const tags = []
  if (/cafe|coffee|brunch|museum|gallery|park|restaurant/.test(s) || busyLevel === 'moderate') tags.push({ icon: '😌', label: 'Chill' })
  if (/cafe|coffee|brunch|cosy|cozy/.test(s)) tags.push({ icon: '☕', label: 'Cozy' })
  if (/restaurant|cocktail|wine|view|date|brunch|bar/.test(s)) tags.push({ icon: '❤️', label: 'Date Friendly' })
  if (/attraction|museum|landmark|tourist|restaurant|cafe|bar/.test(s)) tags.push({ icon: '👣', label: 'Tourist Friendly' })
  if (['busy', 'very_busy'].includes(busyLevel) || (v.rating_count || 0) > 800) tags.push({ icon: '🔥', label: 'Popular' })
  if (/independent|hidden|gem|local/.test(s)) tags.push({ icon: '💎', label: 'Hidden Gem' })
  return tags.slice(0, 6)
}

function buildWhy(v, ctx) {
  const out = []
  const tags = buildTags(v).join(' ').toLowerCase()
  out.push('Matches your vibe')
  if ((ctx.googleRating || 0) >= 4.2 || (ctx.tripRating || 0) >= 4.2) out.push('Highly rated')
  if (/breakfast|brunch|coffee|food|restaurant/.test(tags)) out.push(/coffee/.test(tags) ? 'Great for coffee' : /brunch/.test(tags) ? 'Great for brunch' : 'Great for food')
  if (ctx.distanceM == null || ctx.distanceM < 1600) out.push('Nearby')
  if (ctx.openNow) out.push('Open now')
  if (ctx.busyLevel !== 'very_busy') out.push('Not too busy right now')
  return [...new Set(out)].slice(0, 5)
}

function topReview(v) {
  const taReview = asJson(v.tripadvisor_top_review)
  if (taReview?.text) return { ...taReview, source: taReview.source || 'tripadvisor' }
  const googleReviews = asJson(v.google_review_sample, [])
  const google = Array.isArray(googleReviews) ? googleReviews.find(r => r?.text) : null
  if (google?.text) return { ...google, source: google.source || 'google' }
  return null
}


async function getGooglePlaceIdForVenue(venue) {
  if (venue.google_place_id) return venue.google_place_id
  const src = await query(`SELECT provider_id FROM venue_sources WHERE venue_id=$1 AND provider='google' LIMIT 1`, [venue.id]).catch(() => null)
  return src?.rows?.[0]?.provider_id || null
}

function buildGoogleSearchQueries(venue) {
  const name = String(venue.name || '').trim()
  const city = String(venue.city || '').trim()
  const address = String(venue.address || '').trim()
  const postcode = String(venue.postcode || '').trim()
  const queries = []
  if (name && city) queries.push(`${name} ${city}`)
  if (name && postcode) queries.push(`${name} ${postcode}`)
  if (name && address) queries.push(`${name} ${address}`)
  if (name) queries.push(name)
  return [...new Set(queries.filter(Boolean))].slice(0, 4)
}

async function maybeUpdateGoogleProfile(venue, { force = false } = {}) {
  const checked = venue.google_last_checked ? new Date(venue.google_last_checked) : (venue.profile_last_enriched ? new Date(venue.profile_last_enriched) : null)
  const googleReviews = asJson(venue.google_review_sample, [])
  const hasReviews = Array.isArray(googleReviews) && googleReviews.some(r => r?.text)
  const profileFresh = checked && (Date.now() - checked.getTime()) < 7 * 24 * 60 * 60 * 1000
  const hoursFresh = isHoursFresh(venue, 15)
  // Reviews/ratings can be cached for days, but opening status must be refreshed regularly.
  if (!force && profileFresh && hoursFresh && venue.google_place_id && (hasReviews || venue.rating)) return venue

  const debug = { queriesTried: [], method: null, placeId: null, status: 'started' }
  try {
    let placeId = await getGooglePlaceIdForVenue(venue)
    let details = null

    if (placeId) {
      debug.method = 'place_id'
      debug.placeId = placeId
      details = await getPlaceDetails(placeId)
    }

    // Older/manual venues often have no google_place_id even though Google has the place.
    // In that case, search by name/city/address, then cache the returned place ID forever.
    if (!details) {
      for (const q of buildGoogleSearchQueries(venue)) {
        debug.queriesTried.push(q)
        details = await findPlaceDetails(q)
        if (details?.providerId) {
          placeId = details.providerId
          debug.method = 'text_search'
          debug.placeId = placeId
          break
        }
      }
    }

    if (!details) {
      debug.status = 'no_match'
      await query(`UPDATE venues SET google_last_checked=now(), google_status='no_match', google_debug=$2 WHERE id=$1`, [venue.id, JSON.stringify(debug)]).catch(() => {})
      return { ...venue, google_status: 'no_match', google_debug: debug }
    }

    const nextPhotos = details.photos?.length ? details.photos : asJson(venue.photos, [])
    const cover = venue.cover_photo || details.photos?.[0]?.url || null
    const reviews = details.reviews || []
    debug.status = 'synced'

    await query(`
      UPDATE venues SET
        google_place_id=$1,
        google_maps_url=COALESCE($2, google_maps_url),
        rating=COALESCE($3, rating),
        rating_count=COALESCE($4, rating_count),
        price_level=COALESCE($5, price_level),
        opening_hours=COALESCE($6, opening_hours),
        business_status=COALESCE($7, business_status),
        phone=COALESCE(phone, $8),
        website=COALESCE(website, $9),
        google_review_sample=$10,
        photos=COALESCE($11, photos),
        cover_photo=COALESCE(cover_photo, $12),
        profile_last_enriched=now(),
        google_last_checked=now(),
        google_status='synced',
        google_debug=$14
      WHERE id=$13
    `, [
      placeId || details.providerId,
      details.googleMapsUrl,
      details.rating,
      details.ratingCount,
      details.priceLevel,
      normalizeOpeningHours(details.openingHours) ? JSON.stringify(normalizeOpeningHours(details.openingHours)) : null,
      details.businessStatus,
      details.phone,
      details.website,
      JSON.stringify(reviews),
      nextPhotos ? JSON.stringify(nextPhotos) : null,
      cover,
      venue.id,
      JSON.stringify(debug),
    ])

    if (placeId) {
      await query(
        `INSERT INTO venue_sources (venue_id, provider, provider_id, raw)
         VALUES ($1, 'google', $2, $3)
         ON CONFLICT (provider, provider_id) DO UPDATE SET venue_id=EXCLUDED.venue_id, raw=EXCLUDED.raw`,
        [venue.id, placeId, details.raw ? JSON.stringify(details.raw) : null]
      ).catch(() => {})
    }

    return {
      ...venue,
      google_place_id: placeId || details.providerId || venue.google_place_id,
      google_maps_url: details.googleMapsUrl || venue.google_maps_url,
      rating: details.rating ?? venue.rating,
      rating_count: details.ratingCount ?? venue.rating_count,
      price_level: details.priceLevel ?? venue.price_level,
      opening_hours: normalizeOpeningHours(details.openingHours) || venue.opening_hours,
      business_status: details.businessStatus || venue.business_status,
      phone: venue.phone || details.phone,
      website: venue.website || details.website,
      google_review_sample: reviews,
      photos: nextPhotos,
      cover_photo: venue.cover_photo || cover,
      profile_last_enriched: new Date().toISOString(),
      google_last_checked: new Date().toISOString(),
      google_status: 'synced',
      google_debug: debug,
    }
  } catch (e) {
    debug.status = 'error'
    debug.error = e.message
    logger.error('[venueProfile] Google profile update skipped:', e.message)
    await query(`UPDATE venues SET google_last_checked=now(), google_status='error', google_debug=$2 WHERE id=$1`, [venue.id, JSON.stringify(debug)]).catch(() => {})
    return { ...venue, google_status: 'error', google_debug: debug }
  }
}

async function maybeUpdateTripAdvisor(venue, { force = false } = {}) {
  if (!hasTripAdvisor()) return venue
  const checked = venue.tripadvisor_last_checked ? new Date(venue.tripadvisor_last_checked) : null
  const isFresh = checked && (Date.now() - checked.getTime()) < 7 * 24 * 60 * 60 * 1000
  if (!force && isFresh && venue.tripadvisor_rating) return venue

  try {
    logger.info(`[venueProfile] TripAdvisor enrich ${force ? 'FORCE ' : ''}${venue.name} (${venue.id})`)
    const ta = await enrichTripAdvisorForVenue(venue, { debug: true })
    if (ta?.rateLimited) {
      logger.error(`[venueProfile] TripAdvisor rate limited for ${venue.name} (${venue.id})`)
      // Do not mark as a permanent no-match. Keep existing cached data if any.
      return {
        ...venue,
        tripadvisor_status: 'rate_limited',
        tripadvisor_debug: ta.debug || null,
      }
    }
    if (ta?.noMatch || !ta?.locationId) {
      logger.info(`[venueProfile] TripAdvisor no match for ${venue.name} (${venue.id})`)
      await query(`UPDATE venues SET tripadvisor_last_checked=now(), tripadvisor_status='no_match', tripadvisor_debug=$2, tripadvisor_candidates=$3 WHERE id=$1`, [venue.id, ta?.debug ? JSON.stringify(ta.debug) : null, ta?.candidates ? JSON.stringify(ta.candidates) : JSON.stringify([])]).catch(() => {})
      return {
        ...venue,
        tripadvisor_last_checked: new Date().toISOString(),
        tripadvisor_status: 'no_match',
        tripadvisor_debug: ta?.debug || null,
        tripadvisor_candidates: ta?.candidates || [],
      }
    }
    await query(`
      UPDATE venues SET
        tripadvisor_location_id=$1,
        tripadvisor_rating=$2,
        tripadvisor_review_count=$3,
        tripadvisor_ranking=$4,
        tripadvisor_url=$5,
        tripadvisor_top_review=$6,
        tripadvisor_last_checked=now(),
        tripadvisor_status='synced',
        tripadvisor_debug=$7,
        tripadvisor_candidates=$8,
        cover_photo=COALESCE(cover_photo, $9),
        profile_last_enriched=now()
      WHERE id=$10
    `, [
      ta.locationId,
      ta.rating,
      ta.reviewCount,
      ta.ranking,
      ta.url,
      ta.topReview ? JSON.stringify(ta.topReview) : null,
      ta.debug ? JSON.stringify(ta.debug) : null,
      ta.candidates ? JSON.stringify(ta.candidates) : JSON.stringify([]),
      ta.photoUrl,
      venue.id,
    ])
    return {
      ...venue,
      tripadvisor_location_id: ta.locationId,
      tripadvisor_rating: ta.rating,
      tripadvisor_review_count: ta.reviewCount,
      tripadvisor_ranking: ta.ranking,
      tripadvisor_url: ta.url,
      tripadvisor_top_review: ta.topReview,
      cover_photo: venue.cover_photo || ta.photoUrl,
      profile_last_enriched: new Date().toISOString(),
      tripadvisor_status: 'synced',
      tripadvisor_debug: ta.debug || null,
      tripadvisor_candidates: ta.candidates || [],
    }
  } catch (e) {
    logger.error('[venueProfile] TripAdvisor update skipped:', e.message)
    return venue
  }
}

async function getVenueProfile(id, { lat = null, lng = null } = {}) {
  const { rows } = await query(`SELECT * FROM venues WHERE id = $1`, [id])
  if (!rows.length) return null
  let venue = rows[0]

  // Google detail enrichment gives us real review snippets and maps URLs for the profile.
  venue = await maybeUpdateGoogleProfile(venue)

  // TripAdvisor is on-demand and cached, so the profile gets richer without blocking the whole app forever.
  venue = await maybeUpdateTripAdvisor(venue)

  const eventsQ = await query(`SELECT id,name,description,image_url,category,genre,starts_at,ends_at,is_free,min_price,ticket_url FROM events WHERE venue_id=$1 AND status='active' AND starts_at>=now() ORDER BY starts_at ASC LIMIT 20`, [id])
  const sourcesQ = await query(`SELECT provider,provider_id FROM venue_sources WHERE venue_id=$1`, [id])
  const offersQ = await query(`SELECT id,title,description,discount_type,estimated_value,ends_at,redeem_url FROM offers WHERE venue_id=$1 AND active=TRUE AND (ends_at IS NULL OR ends_at>=now()) ORDER BY created_at DESC`, [id])

  const userLat = toNum(lat)
  const userLng = toNum(lng)
  const venueLat = toNum(venue.lat)
  const venueLng = toNum(venue.lng)
  const distanceM = userLat != null && userLng != null && venueLat != null && venueLng != null
    ? Math.round(distanceMeters(userLat, userLng, venueLat, venueLng))
    : null
  const walk = walkMinutes(distanceM)
  const drive = driveMinutes(distanceM)

  const openNow = isOpenNow(venue)
  const rawBusyEstimate = estimateBusy(venue, { when: new Date(), events: eventsQ.rows.map(e => ({ ...e, venue_id: Number(id) })) })
  const busyEstimate = openNow === false
    ? { level: 'closed', reason: nextOpenText(venue) || 'Closed right now', confidence: 'google_hours' }
    : rawBusyEstimate
  const busyLevel = busyEstimate.level
  const googleRating = toNum(venue.rating)
  const googleReviews = Number(venue.rating_count || 0)
  const tripRating = toNum(venue.tripadvisor_rating)
  const tripReviews = Number(venue.tripadvisor_review_count || 0)
  const sappoScore = deriveSappoScore({ googleRating, googleReviews, tripRating, tripReviews, distanceM, openNow, busyLevel })
  const whyChosen = buildWhy(venue, { googleRating, tripRating, distanceM, openNow, busyLevel })
  const vibeTags = buildVibeTags(venue, busyLevel)
  const mapsUrl = buildGoogleMapsUrl(venue)
  const tags = buildTags(venue)

  // Persist lightweight profile intelligence for future calls.
  await query(`
    UPDATE venues SET
      sappo_score=$1,
      why_chosen=$2,
      vibe_tags=$3,
      busy_level=$4,
      busy_reason=$5,
      google_maps_url=COALESCE(google_maps_url, $6),
      profile_last_enriched=now()
    WHERE id=$7
  `, [sappoScore, JSON.stringify(whyChosen), JSON.stringify(vibeTags), busyLevel, busyEstimate.reason, mapsUrl, id]).catch(() => {})

  const photosRaw = Array.isArray(asJson(venue.photos, [])) ? asJson(venue.photos, []) : []
  const photos = photosRaw.map(repairPhoto)
  const googleReviewSample = Array.isArray(asJson(venue.google_review_sample, [])) ? asJson(venue.google_review_sample, []) : []
  const cover = repairPhotoUrl(venue.cover_photo) || photos?.[0]?.url || photos?.[0] || null

  return {
    ...venue,
    category: categoryLabel(venue.category_slug),
    tags,
    cover_photo: cover,
    heroImages: [cover, ...photos.map(p => p.url || p).filter(Boolean)].filter(Boolean),
    events: eventsQ.rows,
    sources: sourcesQ.rows,
    offers: offersQ.rows,

    // UX fields consumed by the new VenueDetail screen.
    distance_meters: distanceM,
    distance_text: distanceM != null ? `${(distanceM / 1609.344).toFixed(1)} mi` : null,
    walking_time_minutes: walk,
    walking_time_text: walk ? `${walk} min walk` : null,
    driving_time_minutes: drive,
    driving_time_text: drive ? `${drive} min drive` : null,
    open_now: openNow,
    closes_text: closesText(venue),
    opens_text: nextOpenText(venue),
    opening_hours_checked_at: asJson(venue.opening_hours, {})?.checked_at || venue.google_last_checked || null,
    google_rating: googleRating,
    google_reviews: googleReviews,
    google_review_count: googleReviews,
    google_review_sample: googleReviewSample,
    googleReviewSample,
    tripadvisor_rating: tripRating,
    tripadvisorRating: tripRating,
    tripadvisor_reviews: tripReviews,
    tripadvisorReviews: tripReviews,
    tripadvisor_review_count: tripReviews,
    tripadvisorReviewCount: tripReviews,
    tripadvisor_ranking: venue.tripadvisor_ranking || null,
    tripadvisorRanking: venue.tripadvisor_ranking || null,
    tripadvisor_url: venue.tripadvisor_url || null,
    tripadvisorUrl: venue.tripadvisor_url || null,
    sappo_score: sappoScore,
    popularity_label: googleReviews > 1000 || tripReviews > 500 ? 'Popular Today' : 'Great Match',
    busy: {
      ...busyEstimate,
      isClosed: openNow === false,
      levelText: openNow === false ? 'Closed' : busyLevel === 'very_busy' ? 'Very busy' : busyLevel === 'busy' ? 'Busy' : busyLevel === 'moderate' ? 'Moderate' : 'Quiet',
      waitText: openNow === false ? (nextOpenText(venue) || 'Check opening times') : busyLevel === 'very_busy' ? 'Live wait time: ~25 min' : busyLevel === 'busy' ? 'Live wait time: ~20 min' : busyLevel === 'moderate' ? 'Live wait time: ~10 min' : 'Usually no wait',
      reason: openNow === false ? (nextOpenText(venue) || 'Closed right now') : busyEstimate.reason,
    },
    busy_level: busyLevel,
    busy_reason: busyEstimate.reason,
    why_chosen: whyChosen,
    whyChosen,
    tripadvisor_top_review: asJson(venue.tripadvisor_top_review),
    tripadvisorTopReview: asJson(venue.tripadvisor_top_review),
    google_status: venue.google_status || (venue.google_place_id ? 'synced' : 'pending'),
    googleStatus: venue.google_status || (venue.google_place_id ? 'synced' : 'pending'),
    google_debug: venue.google_debug || null,
    googleDebug: venue.google_debug || null,
    tripadvisor_status: venue.tripadvisor_status || (tripRating ? 'synced' : 'pending'),
    tripadvisorStatus: venue.tripadvisor_status || (tripRating ? 'synced' : 'pending'),
    tripadvisor_debug: venue.tripadvisor_debug || null,
    tripadvisorDebug: venue.tripadvisor_debug || null,
    tripadvisor_candidates: venue.tripadvisor_candidates || [],
    tripadvisorCandidates: venue.tripadvisor_candidates || [],
    top_review: topReview(venue),
    topReview: topReview(venue),
    vibe_tags: vibeTags,
    google_maps_url: mapsUrl,
    maps_url: mapsUrl,
    instagram: venue.instagram || null,
    facebook: venue.facebook || null,
    menu_url: venue.menu_url || (['restaurant', 'cafe'].includes(venue.category_slug) ? venue.website : null),
    updated_at: venue.profile_last_enriched || venue.updated_at || new Date().toISOString(),
  }
}

async function syncTripAdvisorForVenue(id, { force = true } = {}) {
  const { rows } = await query(`SELECT * FROM venues WHERE id = $1`, [id])
  if (!rows.length) return null
  const before = rows[0]
  const after = await maybeUpdateTripAdvisor(before, { force })
  return {
    id: after.id,
    name: after.name,
    matched: !!after.tripadvisor_location_id,
    status: after.tripadvisor_status || (after.tripadvisor_location_id ? 'synced' : 'no_match'),
    tripadvisor_location_id: after.tripadvisor_location_id || null,
    tripadvisor_rating: toNum(after.tripadvisor_rating),
    tripadvisor_review_count: Number(after.tripadvisor_review_count || 0),
    tripadvisor_ranking: after.tripadvisor_ranking || null,
    tripadvisor_url: after.tripadvisor_url || null,
    tripadvisor_top_review: asJson(after.tripadvisor_top_review),
    debug: after.tripadvisor_debug || null,
    candidates: after.tripadvisor_candidates || [],
  }
}

async function syncTripAdvisorBatch({ city = null, limit = 25, force = false } = {}) {
  const params = []
  const where = []
  if (city) { params.push(city); where.push(`city = $${params.length}`) }
  if (!force) where.push(`(tripadvisor_last_checked IS NULL OR tripadvisor_last_checked < now() - interval '30 days')`)
  params.push(Number(limit) || 25)
  const sql = `SELECT * FROM venues ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY tripadvisor_last_checked ASC NULLS FIRST, rating_count DESC NULLS LAST LIMIT $${params.length}`
  const { rows } = await query(sql, params)
  const results = []
  for (const venue of rows) {
    const updated = await maybeUpdateTripAdvisor(venue, { force })
    results.push({
      id: updated.id,
      name: updated.name,
      matched: !!updated.tripadvisor_location_id,
      status: updated.tripadvisor_status || (updated.tripadvisor_location_id ? 'synced' : 'no_match'),
      rating: toNum(updated.tripadvisor_rating),
      reviewCount: Number(updated.tripadvisor_review_count || 0),
      locationId: updated.tripadvisor_location_id || null,
      debug: updated.tripadvisor_debug || null,
      candidates: updated.tripadvisor_candidates || [],
    })
    // Avoid hammering TripAdvisor during bulk sync.
    await sleep(1500)
  }
  return {
    scanned: rows.length,
    matched: results.filter(r => r.matched).length,
    failed: results.filter(r => !r.matched).length,
    rateLimited: results.filter(r => r.status === 'rate_limited').length,
    results,
  }
}


async function syncGoogleForVenue(id, { force = true } = {}) {
  const { rows } = await query(`SELECT * FROM venues WHERE id = $1`, [id])
  if (!rows.length) return null
  const after = await maybeUpdateGoogleProfile(rows[0], { force })
  return {
    id: after.id,
    name: after.name,
    matched: !!after.google_place_id,
    status: after.google_status || (after.google_place_id ? 'synced' : 'no_match'),
    google_place_id: after.google_place_id || null,
    google_rating: toNum(after.rating),
    google_review_count: Number(after.rating_count || 0),
    google_maps_url: after.google_maps_url || null,
    google_review_sample_count: Array.isArray(asJson(after.google_review_sample, [])) ? asJson(after.google_review_sample, []).length : 0,
    debug: after.google_debug || null,
  }
}

async function syncGoogleBatch({ city = null, limit = 25, force = false } = {}) {
  const params = []
  const where = []
  if (city) { params.push(city); where.push(`city = $${params.length}`) }
  // A venue "needs enriching" only if it hasn't been checked recently. We must NOT
  // use "rating IS NULL" here — many real venues (stations, some pubs) have no Google
  // rating, so they'd be re-selected forever. google_last_checked is the source of truth.
  if (!force) where.push(`(google_last_checked IS NULL OR google_last_checked < now() - interval '30 days')`)
  params.push(Number(limit) || 25)
  const sql = `SELECT * FROM venues ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY google_last_checked ASC NULLS FIRST, rating_count DESC NULLS LAST LIMIT $${params.length}`
  const { rows } = await query(sql, params)
  const results = []
  for (const venue of rows) {
    const updated = await maybeUpdateGoogleProfile(venue, { force })
    results.push({
      id: updated.id,
      name: updated.name,
      matched: !!updated.google_place_id,
      status: updated.google_status || (updated.google_place_id ? 'synced' : 'no_match'),
      rating: toNum(updated.rating),
      reviewCount: Number(updated.rating_count || 0),
      placeId: updated.google_place_id || null,
      debug: updated.google_debug || null,
    })
    await sleep(400)
  }
  return {
    scanned: rows.length,
    matched: results.filter(r => r.matched).length,
    failed: results.filter(r => !r.matched).length,
    results,
  }
}

module.exports = { getVenueProfile, deriveSappoScore, syncTripAdvisorForVenue, syncTripAdvisorBatch, syncGoogleForVenue, syncGoogleBatch }
