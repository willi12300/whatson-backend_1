require('dotenv').config()

// Railway sometimes provides the DB url under different names
const databaseUrl = 
  process.env.DATABASE_URL ||
  process.env.DATABASE_PRIVATE_URL ||
  process.env.DATABASE_PUBLIC_URL ||
  null

const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl,
  google:      { key: process.env.GOOGLE_PLACES_API_KEY },
  foursquare:  { key: process.env.FOURSQUARE_API_KEY },
  skiddle:     { key: process.env.SKIDDLE_API_KEY },
  eventbrite:  { token: process.env.EVENTBRITE_TOKEN },
  syncSecret:  process.env.SYNC_SECRET || 'dev_secret',
}

if (!config.databaseUrl) {
  console.warn('[WARN] No database URL found in environment variables.')
  console.warn('[WARN] Set DATABASE_URL in Railway Variables tab.')
} else {
  console.log('[INFO] Database URL found.')
}

const CITIES = {
  liverpool: {
    name: 'Liverpool',
    lat: 53.4084,
    lng: -2.9916,
    radiusMeters: 6000,
    radiusMiles: 5,
    bbox: { south: 53.34, west: -3.02, north: 53.46, east: -2.91 },
  },
  manchester: {
    name: 'Manchester',
    lat: 53.4808,
    lng: -2.2426,
    radiusMeters: 6000,
    radiusMiles: 5,
    bbox: { south: 53.42, west: -2.31, north: 53.52, east: -2.18 },
  },
  london: {
    name: 'London',
    lat: 51.5074,
    lng: -0.1278,
    radiusMeters: 6000,
    radiusMiles: 5,
    bbox: { south: 51.45, west: -0.22, north: 51.56, east: -0.04 },
  },
}

module.exports = { config, CITIES }
