const { query } = require('../db/pool')
const { distanceMeters } = require('../utils/helpers')
const { estimateBusy } = require('./busyEstimate')
const { enrichTripAdvisorForVenue, hasTripAdvisor } = require('../clients/tripadvisor')
const { getPlaceDetails } = require('../clients/google')
const logger = require('../utils/logger')

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

function walkMinutes(meters) {
  if (meters == null) return null
  return Math.max(1, Math.round(Number(meters) / 80))
}

function driveMinutes(meters) {
  if (meters == null) return null
  return Math.max(2, Math.round(Number(meters) / 420))
}

function buildGoogleMapsUrl(v) {
  if (v.google_maps_url) return v.google_maps_url
  if (v.google_place_id) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.name)}&query_place_id=${encodeURIComponent(v.google_place_id)}`
  if (v.lat != null && v.lng != null) return `https://www.google.com/maps/dir/?api=1&destination=${v.lat},${v.lng}`
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${v.name || ''} ${v.address || ''}`)}`
}

function isOpenNow(v) {
  const oh = v.opening_hours || {}
  if (typeof oh.openNow === 'boolean') return oh.openNow
  if (typeof oh.open_now === 'boolean') return oh.open_now
  return v.business_status === 'OPERATIONAL' || !v.business_status
}

function closesText(v) {
  const oh = v.opening_hours || {}
  if (oh.closeText) return oh.closeText
  if (oh.today_close) return `Closes ${oh.today_close}`
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

async function maybeUpdateGoogleProfile(venue) {
  const checked = venue.profile_last_enriched ? new Date(venue.profile_last_enriched) : null
  const googleReviews = asJson(venue.google_review_sample, [])
  const hasReviews = Array.isArray(googleReviews) && googleReviews.some(r => r?.text)
  const isFresh = checked && (Date.now() - checked.getTime()) < 3 * 24 * 60 * 60 * 1000
  if (isFresh && venue.google_place_id && hasReviews) return venue

  try {
    const placeId = await getGooglePlaceIdForVenue(venue)
    if (!placeId) return venue
    const details = await getPlaceDetails(placeId)
    if (!details) return { ...venue, google_place_id: placeId }

    const nextPhotos = details.photos?.length ? details.photos : asJson(venue.photos, [])
    const cover = venue.cover_photo || details.photos?.[0]?.url || null
    const reviews = details.reviews || []

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
        profile_last_enriched=now()
      WHERE id=$13
    `, [
      placeId,
      details.googleMapsUrl,
      details.rating,
      details.ratingCount,
      details.priceLevel,
      details.openingHours ? JSON.stringify(details.openingHours) : null,
      details.businessStatus,
      details.phone,
      details.website,
      JSON.stringify(reviews),
      nextPhotos ? JSON.stringify(nextPhotos) : null,
      cover,
      venue.id,
    ])

    return {
      ...venue,
      google_place_id: placeId,
      google_maps_url: details.googleMapsUrl || venue.google_maps_url,
      rating: details.rating ?? venue.rating,
      rating_count: details.ratingCount ?? venue.rating_count,
      price_level: details.priceLevel ?? venue.price_level,
      opening_hours: details.openingHours || venue.opening_hours,
      business_status: details.businessStatus || venue.business_status,
      phone: venue.phone || details.phone,
      website: venue.website || details.website,
      google_review_sample: reviews,
      photos: nextPhotos,
      cover_photo: venue.cover_photo || cover,
      profile_last_enriched: new Date().toISOString(),
    }
  } catch (e) {
    logger.error('[venueProfile] Google profile update skipped:', e.message)
    return venue
  }
}

async function maybeUpdateTripAdvisor(venue) {
  if (!hasTripAdvisor()) return venue
  const checked = venue.tripadvisor_last_checked ? new Date(venue.tripadvisor_last_checked) : null
  const isFresh = checked && (Date.now() - checked.getTime()) < 7 * 24 * 60 * 60 * 1000
  if (isFresh && venue.tripadvisor_rating) return venue

  try {
    const ta = await enrichTripAdvisorForVenue(venue)
    if (!ta?.locationId) return venue
    await query(`
      UPDATE venues SET
        tripadvisor_location_id=$1,
        tripadvisor_rating=$2,
        tripadvisor_review_count=$3,
        tripadvisor_ranking=$4,
        tripadvisor_url=$5,
        tripadvisor_top_review=$6,
        tripadvisor_last_checked=now(),
        cover_photo=COALESCE(cover_photo, $7),
        profile_last_enriched=now()
      WHERE id=$8
    `, [
      ta.locationId,
      ta.rating,
      ta.reviewCount,
      ta.ranking,
      ta.url,
      ta.topReview ? JSON.stringify(ta.topReview) : null,
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

  const busyEstimate = estimateBusy(venue, { when: new Date(), events: eventsQ.rows.map(e => ({ ...e, venue_id: Number(id) })) })
  const busyLevel = busyEstimate.level
  const googleRating = toNum(venue.rating)
  const googleReviews = Number(venue.rating_count || 0)
  const tripRating = toNum(venue.tripadvisor_rating)
  const tripReviews = Number(venue.tripadvisor_review_count || 0)
  const openNow = isOpenNow(venue)
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

  const photos = Array.isArray(asJson(venue.photos, [])) ? asJson(venue.photos, []) : []
  const googleReviewSample = Array.isArray(asJson(venue.google_review_sample, [])) ? asJson(venue.google_review_sample, []) : []
  const cover = venue.cover_photo || photos?.[0]?.url || photos?.[0] || null

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
      levelText: busyLevel === 'very_busy' ? 'Very busy' : busyLevel === 'busy' ? 'Busy' : busyLevel === 'moderate' ? 'Moderate' : 'Quiet',
      waitText: busyLevel === 'very_busy' ? 'Live wait time: ~25 min' : busyLevel === 'busy' ? 'Live wait time: ~20 min' : busyLevel === 'moderate' ? 'Live wait time: ~10 min' : 'Usually no wait',
    },
    busy_level: busyLevel,
    busy_reason: busyEstimate.reason,
    why_chosen: whyChosen,
    whyChosen,
    tripadvisor_top_review: asJson(venue.tripadvisor_top_review),
    tripadvisorTopReview: asJson(venue.tripadvisor_top_review),
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

module.exports = { getVenueProfile, deriveSappoScore }
