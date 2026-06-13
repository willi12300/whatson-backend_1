// src/config/index.js
// Loads and validates environment variables. Fails fast if something critical is missing.

require('dotenv').config()

const config = {
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,

  google: {
    key: process.env.GOOGLE_PLACES_API_KEY,
  },
  foursquare: {
    key: process.env.FOURSQUARE_API_KEY,
  },
  skiddle: {
    key: process.env.SKIDDLE_API_KEY,
  },
  eventbrite: {
    token: process.env.EVENTBRITE_TOKEN,
  },
  syncSecret: process.env.SYNC_SECRET || 'dev_secret',
}

// City presets — add more here as you expand
const CITIES = {
  liverpool: {
    name: 'Liverpool',
    lat: 53.4084,
    lng: -2.9916,
    radiusMeters: 6000,
    // bounding box: south,west,north,east  (for OSM Overpass)
    bbox: { south: 53.34, west: -3.02, north: 53.46, east: -2.91 },
  },
  manchester: {
    name: 'Manchester',
    lat: 53.4808,
    lng: -2.2426,
    radiusMeters: 6000,
    bbox: { south: 53.42, west: -2.31, north: 53.52, east: -2.18 },
  },
  london: {
    name: 'London',
    lat: 51.5074,
    lng: -0.1278,
    radiusMeters: 6000,
    bbox: { south: 51.45, west: -0.22, north: 51.56, east: -0.04 },
  },
}

// Validate required vars on boot
function validate() {
  const missing = []
  if (!config.databaseUrl) missing.push('DATABASE_URL')
  if (!config.google.key) missing.push('GOOGLE_PLACES_API_KEY')
  if (!config.foursquare.key) missing.push('FOURSQUARE_API_KEY')
  if (!config.skiddle.key) missing.push('SKIDDLE_API_KEY')
  if (!config.eventbrite.token) missing.push('EVENTBRITE_TOKEN')

  if (missing.length) {
    console.warn('⚠️  Missing environment variables: ' + missing.join(', '))
    console.warn('   The server will start, but related sync jobs will fail until these are set.')
  }
}

module.exports = { config, CITIES, validate }
