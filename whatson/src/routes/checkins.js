const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()

// Haversine in metres
function dist(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = d => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(a))
}

const XP_PER_CHECKIN = 25

async function awardXP(deviceId, amount) {
  await query(
    `INSERT INTO profiles (device_id, xp) VALUES ($1,$2)
     ON CONFLICT (device_id) DO UPDATE SET xp = profiles.xp + $2, updated_at = now()`,
    [deviceId, amount]
  )
  const { rows } = await query(`SELECT xp FROM profiles WHERE device_id=$1`, [deviceId])
  const xp = rows[0]?.xp || 0
  const level = Math.floor(xp / 200) + 1   // 200xp per level
  await query(`UPDATE profiles SET level=$1 WHERE device_id=$2`, [level, deviceId])
  return { xp, level }
}

// POST /checkins  { deviceId, venueId, lat?, lng? }
router.post('/', async (req, res, next) => {
  try {
    const { deviceId, venueId, lat, lng, accuracy } = req.body || {}
    if (!deviceId || !venueId) return res.status(400).json({ error: 'deviceId and venueId required' })

    // Location is REQUIRED — no coords, no check-in.
    if (lat == null || lng == null) {
      return res.status(400).json({ error: 'location_required', message: 'Location is needed to check in. Please allow location access.' })
    }

    // Look up the venue and measure how far the user is.
    const { rows } = await query(`SELECT lat, lng, name FROM venues WHERE id=$1`, [venueId])
    if (!rows.length) return res.status(404).json({ error: 'venue_not_found' })

    const CHECKIN_RADIUS_M = 50    // must be within 50m of the venue
    const d = dist(lat, lng, rows[0].lat, rows[0].lng)

    // Reject if too far away. Allow a little slack for GPS inaccuracy (capped small
    // so it can't swamp the tighter radius).
    const slack = Math.min(accuracy || 0, 25)   // phone GPS accuracy, capped at 25m
    if (d > CHECKIN_RADIUS_M + slack) {
      return res.status(403).json({
        error: 'too_far',
        message: `You're too far from ${rows[0].name} to check in. Get within ${CHECKIN_RADIUS_M}m.`,
        distance: Math.round(d),
        required: CHECKIN_RADIUS_M,
      })
    }

    // Passed — this is a verified, on-location check-in.
    await query(
      `INSERT INTO check_ins (device_id, venue_id, lat, lng, gps_verified) VALUES ($1,$2,$3,$4,TRUE)`,
      [deviceId, venueId, lat, lng]
    )
    const { xp, level } = await awardXP(deviceId, XP_PER_CHECKIN)

    // first-checkin badge
    const { rows: cnt } = await query(`SELECT COUNT(*) FROM check_ins WHERE device_id=$1`, [deviceId])
    if (parseInt(cnt[0].count) === 1) {
      await query(`INSERT INTO badges (device_id, badge_key, label) VALUES ($1,'first_checkin','First Steps') ON CONFLICT DO NOTHING`, [deviceId])
    }

    res.json({ ok: true, gpsVerified: true, distance: Math.round(d), xpAwarded: XP_PER_CHECKIN, xp, level })
  } catch (err) { next(err) }
})

// GET /checkins/:deviceId  — history
router.get('/:deviceId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.venue_id, c.gps_verified, c.created_at, v.name AS venue_name, v.category_slug
       FROM check_ins c LEFT JOIN venues v ON v.id = c.venue_id
       WHERE c.device_id=$1 ORDER BY c.created_at DESC LIMIT 100`,
      [req.params.deviceId]
    )
    res.json({ checkins: rows })
  } catch (err) { next(err) }
})

module.exports = router
