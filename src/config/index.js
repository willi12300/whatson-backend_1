require('dotenv').config()

const databaseUrl =
  process.env.DATABASE_URL ||
  process.env.DATABASE_PRIVATE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  null

const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl,
  google:       { key: process.env.GOOGLE_PLACES_API_KEY },
  foursquare:   { key: process.env.FOURSQUARE_API_KEY },
  skiddle:      { key: process.env.SKIDDLE_API_KEY },
  eventbrite:   { token: process.env.EVENTBRITE_TOKEN },
  ticketmaster: { key: process.env.TICKETMASTER_API_KEY },
  syncSecret:   process.env.SYNC_SECRET || 'dev_secret',
}

if (!config.databaseUrl) {
  console.warn('[WARN] No database URL found in environment variables.')
} else {
  console.log('[INFO] Database URL found.')
}

// Helper to build a bbox roughly +/- ~6km around a centre point
function box(lat, lng, pad = 0.06) {
  return { south: lat - pad, west: lng - pad * 1.6, north: lat + pad, east: lng + pad * 1.6 }
}

const CITIES = {
  // ── UK (full coverage: venues + Skiddle events + Ticketmaster) ──
  liverpool:  { name: 'Liverpool',  lat: 53.4084, lng: -2.9916, radiusMeters: 6000, radiusMiles: 5, bbox: box(53.4084, -2.9916) },
  manchester: { name: 'Manchester', lat: 53.4808, lng: -2.2426, radiusMeters: 6000, radiusMiles: 5, bbox: box(53.4808, -2.2426) },
  london:     { name: 'London',     lat: 51.5074, lng: -0.1278, radiusMeters: 6000, radiusMiles: 5, bbox: box(51.5074, -0.1278) },
  birmingham: { name: 'Birmingham', lat: 52.4862, lng: -1.8904, radiusMeters: 6000, radiusMiles: 5, bbox: box(52.4862, -1.8904) },
  leeds:      { name: 'Leeds',      lat: 53.8008, lng: -1.5491, radiusMeters: 6000, radiusMiles: 5, bbox: box(53.8008, -1.5491) },
  glasgow:    { name: 'Glasgow',    lat: 55.8642, lng: -4.2518, radiusMeters: 6000, radiusMiles: 5, bbox: box(55.8642, -4.2518) },
  bristol:    { name: 'Bristol',    lat: 51.4545, lng: -2.5879, radiusMeters: 6000, radiusMiles: 5, bbox: box(51.4545, -2.5879) },
  edinburgh:  { name: 'Edinburgh',  lat: 55.9533, lng: -3.1883, radiusMeters: 6000, radiusMiles: 5, bbox: box(55.9533, -3.1883) },

  // ── International showcase (venues via Google+OSM, events via Ticketmaster) ──
  newyork:    { name: 'New York',   lat: 40.7128, lng: -74.0060, radiusMeters: 6000, radiusMiles: 5, bbox: box(40.7128, -74.0060) },
  losangeles: { name: 'Los Angeles',lat: 34.0522, lng: -118.2437, radiusMeters: 6000, radiusMiles: 5, bbox: box(34.0522, -118.2437) },
  berlin:     { name: 'Berlin',     lat: 52.5200, lng: 13.4050, radiusMeters: 6000, radiusMiles: 5, bbox: box(52.5200, 13.4050) },
  amsterdam:  { name: 'Amsterdam',  lat: 52.3676, lng: 4.9041, radiusMeters: 6000, radiusMiles: 5, bbox: box(52.3676, 4.9041) },
  barcelona:  { name: 'Barcelona',  lat: 41.3851, lng: 2.1734, radiusMeters: 6000, radiusMiles: 5, bbox: box(41.3851, 2.1734) },
  paris:      { name: 'Paris',      lat: 48.8566, lng: 2.3522, radiusMeters: 6000, radiusMiles: 5, bbox: box(48.8566, 2.3522) },
  dublin:     { name: 'Dublin',     lat: 53.3498, lng: -6.2603, radiusMeters: 6000, radiusMiles: 5, bbox: box(53.3498, -6.2603) },
  sydney:     { name: 'Sydney',     lat: -33.8688, lng: 151.2093, radiusMeters: 6000, radiusMiles: 5, bbox: box(-33.8688, 151.2093) },
}

module.exports = { config, CITIES }
