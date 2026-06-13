// src/ingestion/google.ts
import axios from 'axios'
import { config, LIVERPOOL } from '../config'
import { LIVERPOOL_GRID } from '../utils/geo'
import { logger } from '../utils/logger'

const BASE = 'https://places.googleapis.com/v1/places:searchNearby'
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress',
  'places.location', 'places.types', 'places.primaryType',
  'places.rating', 'places.userRatingCount', 'places.priceLevel',
  'places.regularOpeningHours', 'places.photos',
  'places.internationalPhoneNumber', 'places.websiteUri',
  'places.businessStatus', 'places.shortFormattedAddress'
].join(',')

const VENUE_TYPES = [
  'bar', 'night_club', 'restaurant', 'cafe',
  'pub', 'comedy_club', 'karaoke'
]

export interface RawGoogleVenue {
  googlePlaceId: string
  name: string
  address: string
  lat: number
  lng: number
  types: string[]
  primaryType: string
  rating: number | null
  ratingCount: number | null
  priceLevel: number | null
  phone: string | null
  website: string | null
  businessStatus: string | null
  openingHours: object | null
  photos: Array<{ name: string; widthPx: number; heightPx: number }>
}

async function searchNearby(
  lat: number, lng: number, type: string
): Promise<RawGoogleVenue[]> {
  try {
    const res = await axios.post(BASE, {
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 5000.0
        }
      },
      includedTypes: [type],
      maxResultCount: 20
    }, {
      headers: {
        'X-Goog-Api-Key': config.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': FIELD_MASK,
        'Content-Type': 'application/json'
      }
    })

    return (res.data.places || []).map((p: any) => ({
      googlePlaceId: p.id,
      name: p.displayName?.text || '',
      address: p.formattedAddress || '',
      lat: p.location?.latitude,
      lng: p.location?.longitude,
      types: p.types || [],
      primaryType: p.primaryType || type,
      rating: p.rating || null,
      ratingCount: p.userRatingCount || null,
      priceLevel: p.priceLevel || null,
      phone: p.internationalPhoneNumber || null,
      website: p.websiteUri || null,
      businessStatus: p.businessStatus || null,
      openingHours: p.regularOpeningHours || null,
      photos: p.photos || []
    }))
  } catch (err: any) {
    logger.error({ err: err.message, lat, lng, type }, 'Google Places request failed')
    return []
  }
}

export async function ingestGooglePlaces(): Promise<RawGoogleVenue[]> {
  const results: RawGoogleVenue[] = []
  const seenIds = new Set<string>()

  logger.info({ cells: LIVERPOOL_GRID.length, types: VENUE_TYPES.length },
    'Starting Google Places grid scan')

  for (const cell of LIVERPOOL_GRID) {
    for (const type of VENUE_TYPES) {
      const batch = await searchNearby(cell.lat, cell.lng, type)
      for (const venue of batch) {
        if (!seenIds.has(venue.googlePlaceId)) {
          seenIds.add(venue.googlePlaceId)
          results.push(venue)
        }
      }
      // Google rate limit: max 10 requests/second
      await sleep(120)
    }
  }

  logger.info({ count: results.length }, 'Google Places scan complete')
  return results
}

/**
 * Get a photo URL for a Google place photo reference
 * Fetch once → store in R2 → never call this again for same venue
 */
export function getGooglePhotoUrl(photoName: string, maxWidth = 400): string {
  return `https://places.googleapis.com/v1/${photoName}/media` +
    `?maxWidthPx=${maxWidth}&key=${config.GOOGLE_PLACES_API_KEY}`
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
