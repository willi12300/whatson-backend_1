// src/services/seedMissions.js
// Curated, hand-defined missions. Seeds them into the DB, matching stops to real
// venues where possible (by name search), else using a fixed lat/lng landmark.
// Safe to run repeatedly — skips missions that already exist (by title+city).

const { query } = require('../db/pool')
const logger = require('../utils/logger')

// Curated mission definitions. Landmarks have explicit coords so they work even
// if not in the venues table. Venue-based stops try to match a real venue first.
const CURATED = [
  {
    title: 'Liverpool Beatles Trail',
    description: 'Walk in the footsteps of the Fab Four and unlock the Beatles Explorer badge.',
    city: 'Liverpool', type: 'featured', category: 'music', difficulty: 'medium',
    estimated_duration: '3-4 hours', reward_xp: 300, badge_name: 'Beatles Explorer',
    stops: [
      { title: 'The Beatles Statue', task_type: 'selfie', task_text: 'Take a selfie with the Beatles statue at the Pier Head.', lat: 53.4045, lng: -2.9966, radius: 60, photo_required: false },
      { title: 'The Cavern Club', task_type: 'photo', task_text: 'Snap a photo outside the world-famous Cavern Club.', venueSearch: 'Cavern Club', lat: 53.4068, lng: -2.9874, radius: 50, photo_required: false },
      { title: 'Penny Lane', task_type: 'landmark_photo', task_text: 'Photograph the famous Penny Lane street sign.', lat: 53.3835, lng: -2.9176, radius: 100, photo_required: false },
      { title: 'Strawberry Field', task_type: 'landmark_photo', task_text: 'Get a photo at the iconic Strawberry Field gates.', lat: 53.3811, lng: -2.9009, radius: 100, photo_required: false },
    ],
  },
  {
    title: 'Pub Legend',
    description: 'Prove your stamina on a tour of Liverpool\u2019s best-loved pubs.',
    city: 'Liverpool', type: 'permanent', category: 'nightlife', difficulty: 'easy',
    estimated_duration: '2-3 hours', reward_xp: 200, badge_name: 'Pub Legend',
    stops: [
      { title: 'A classic pub', task_type: 'checkin', task_text: 'Check in at a traditional Liverpool pub.', venueCategory: 'pub', radius: 50 },
      { title: 'A second round', task_type: 'checkin', task_text: 'Move on to your second pub of the night.', venueCategory: 'pub', radius: 50 },
      { title: 'Last orders', task_type: 'photo', task_text: 'Final pub \u2014 grab a photo with your crew.', venueCategory: 'pub', radius: 50 },
    ],
  },
  {
    title: 'Burger Hunter',
    description: 'Track down Liverpool\u2019s best burgers and earn your stripes.',
    city: 'Liverpool', type: 'weekly', category: 'food', difficulty: 'easy',
    estimated_duration: '2 hours', reward_xp: 150, badge_name: 'Burger Hunter',
    stops: [
      { title: 'Burger joint #1', task_type: 'food_photo', task_text: 'Photograph your burger at a top-rated spot.', venueCategory: 'restaurant', radius: 50 },
      { title: 'Burger joint #2', task_type: 'food_photo', task_text: 'Compare with a second burger contender.', venueCategory: 'restaurant', radius: 50 },
    ],
  },
  {
    title: 'Live Music Lover',
    description: 'Catch live music across the city and become a true fan.',
    city: 'Liverpool', type: 'permanent', category: 'music', difficulty: 'medium',
    estimated_duration: 'An evening', reward_xp: 200, badge_name: 'Live Music Lover',
    stops: [
      { title: 'A live music venue', task_type: 'checkin', task_text: 'Check in at a live music venue.', venueCategory: 'music_venue', radius: 50 },
      { title: 'Catch a set', task_type: 'photo', task_text: 'Grab a photo of the stage or the band.', venueCategory: 'music_venue', radius: 50 },
    ],
  },
]

async function findVenue(city, { venueSearch, venueCategory }) {
  if (venueSearch) {
    const r = await query(`SELECT id, lat, lng, name FROM venues WHERE city=$1 AND name ILIKE $2 LIMIT 1`, [city, `%${venueSearch}%`])
    if (r.rows.length) return r.rows[0]
  }
  if (venueCategory) {
    const r = await query(`SELECT id, lat, lng, name FROM venues WHERE city=$1 AND category_slug=$2 AND rating IS NOT NULL ORDER BY rating DESC LIMIT 1`, [city, venueCategory])
    if (r.rows.length) return r.rows[0]
  }
  return null
}

async function seedMissions() {
  let created = 0
  for (const def of CURATED) {
    const exists = await query(`SELECT id FROM missions WHERE title=$1 AND city=$2`, [def.title, def.city])
    if (exists.rows.length) continue

    const badgeKey = def.badge_name.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    const m = await query(
      `INSERT INTO missions (city, title, description, category, type, difficulty, estimated_duration, reward_xp, badge_name, badge_key, active, curated, generated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,TRUE,FALSE) RETURNING id`,
      [def.city, def.title, def.description, def.category, def.type, def.difficulty, def.estimated_duration, def.reward_xp, def.badge_name, badgeKey]
    )
    const missionId = m.rows[0].id

    let order = 1
    for (const s of def.stops) {
      let lat = s.lat, lng = s.lng, venueId = null, title = s.title
      const venue = await findVenue(def.city, s)
      if (venue) { venueId = venue.id; lat = venue.lat; lng = venue.lng; if (!s.lat) title = venue.name }
      await query(
        `INSERT INTO mission_stops (mission_id, venue_id, stop_order, title, description, task, task_type, lat, lng, required_radius_meters, checkin_radius_m, photo_required)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11)`,
        [missionId, venueId, order++, title, s.task_text, s.task_text, s.task_type, lat, lng, s.radius || 50, !!s.photo_required]
      )
    }
    created++
    logger.info(`Seeded mission: ${def.title}`)
  }
  return { created }
}

module.exports = { seedMissions }
