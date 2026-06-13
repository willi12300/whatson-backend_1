// src/scripts/preflight.js
// Run this BEFORE your first sync to check everything is wired up correctly.
// Usage: node src/scripts/preflight.js

const { config } = require('../config')
const { pool } = require('../db/pool')
const axios = require('axios')

const checks = []
function ok(name, msg) { checks.push({ name, status: '✅', msg }) }
function fail(name, msg) { checks.push({ name, status: '❌', msg }) }
function warn(name, msg) { checks.push({ name, status: '⚠️ ', msg }) }

async function run() {
  console.log('\n🔍 What\'sOn backend preflight check\n' + '='.repeat(40))

  // 1. Env vars present
  config.databaseUrl ? ok('DATABASE_URL', 'set') : fail('DATABASE_URL', 'MISSING')
  config.google.key ? ok('Google key', 'set') : fail('Google key', 'MISSING')
  config.foursquare.key ? ok('Foursquare key', 'set') : fail('Foursquare key', 'MISSING')
  config.skiddle.key ? ok('Skiddle key', 'set') : fail('Skiddle key', 'MISSING')
  config.eventbrite.token ? ok('Eventbrite token', 'set') : warn('Eventbrite token', 'missing (optional)')

  // 2. Database connection
  try {
    await pool.query('SELECT 1')
    ok('Database', 'connected')
    // check tables exist
    const t = await pool.query(`SELECT count(*) FROM information_schema.tables WHERE table_name IN ('venues','events','categories','venue_sources','event_sources')`)
    const n = parseInt(t.rows[0].count)
    n === 5 ? ok('Tables', 'all 5 present') : warn('Tables', `${n}/5 found — run "npm run migrate"`)
  } catch (e) {
    fail('Database', e.message + ' — is Postgres running? Did you run migrate?')
  }

  // 3. Google Places live test (1 cheap call)
  if (config.google.key) {
    try {
      const r = await axios.post('https://places.googleapis.com/v1/places:searchNearby',
        { locationRestriction: { circle: { center: { latitude: 53.4084, longitude: -2.9916 }, radius: 500 } }, includedTypes: ['bar'], maxResultCount: 1 },
        { headers: { 'X-Goog-Api-Key': config.google.key, 'X-Goog-FieldMask': 'places.id', 'Content-Type': 'application/json' }, timeout: 10000 })
      ok('Google API', `working (${(r.data.places||[]).length} test result)`)
    } catch (e) {
      fail('Google API', e.response?.data?.error?.message || e.message)
    }
  }

  // 4. Foursquare live test
  if (config.foursquare.key) {
    try {
      await axios.get('https://api.foursquare.com/v3/places/search',
        { params: { ll: '53.4084,-2.9916', radius: 500, limit: 1 }, headers: { Authorization: config.foursquare.key }, timeout: 10000 })
      ok('Foursquare API', 'working')
    } catch (e) {
      fail('Foursquare API', e.response?.data?.message || e.message)
    }
  }

  // 5. Skiddle live test
  if (config.skiddle.key) {
    try {
      await axios.get('https://www.skiddle.com/api/v1/events/', { params: { api_key: config.skiddle.key, latitude: 53.4084, longitude: -2.9916, radius: 5, limit: 1 }, timeout: 10000 })
      ok('Skiddle API', 'working')
    } catch (e) {
      fail('Skiddle API', e.response?.data?.error || e.message)
    }
  }

  // print results
  console.log('')
  checks.forEach(c => console.log(`${c.status} ${c.name.padEnd(18)} ${c.msg}`))
  const failed = checks.filter(c => c.status === '❌').length
  console.log('='.repeat(40))
  if (failed === 0) {
    console.log('🎉 All critical checks passed! You\'re ready to run:  npm run sync:liverpool\n')
  } else {
    console.log(`\n${failed} critical check(s) failed. Fix those above before syncing.\n`)
  }

  await pool.end()
  process.exit(failed === 0 ? 0 : 1)
}

run().catch(async e => { console.error(e); await pool.end(); process.exit(1) })
