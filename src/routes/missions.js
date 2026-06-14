const express = require('express')
const { query } = require('../db/pool')
const { generateMission, getMission } = require('../services/generateMission')
const logger = require('../utils/logger')
const router = express.Router()

// Haversine metres
function dist(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a))*Math.cos(r(c))*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// POST /missions/generate  { city, theme, duration, group_type, interests }
router.post('/generate', async (req, res, next) => {
  try {
    const { city, theme, duration, group_type, interests } = req.body || {}
    if (!city) return res.status(400).json({ error: 'city required' })
    const result = await generateMission({ city, theme, duration, group_type, interests })
    if (result?.error) return res.status(422).json(result)
    res.json(result)
  } catch (err) { logger.error('generate mission:', err.message); next(err) }
})

// GET /missions?city=Liverpool  — list missions for a city
router.get('/', async (req, res, next) => {
  try {
    const { city } = req.query
    const params = [], where = []
    if (city) { params.push(city); where.push(`city = $${params.length}`) }
    const { rows } = await query(
      `SELECT m.*, (SELECT COUNT(*) FROM mission_stops s WHERE s.mission_id=m.id) AS stop_count
       FROM missions m ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.created_at DESC LIMIT 50`, params
    )
    res.json({ missions: rows })
  } catch (err) { next(err) }
})

// GET /missions/:id  — full mission with stops + optional progress
router.get('/:id', async (req, res, next) => {
  try {
    const mission = await getMission(req.params.id)
    if (!mission) return res.status(404).json({ error: 'not_found' })
    const { deviceId } = req.query
    if (deviceId) {
      const p = await query(`SELECT * FROM mission_progress WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
      mission.progress = p.rows[0] || null
    }
    res.json(mission)
  } catch (err) { next(err) }
})

// POST /missions/:id/start  { deviceId }
router.post('/:id/start', async (req, res, next) => {
  try {
    const { deviceId } = req.body || {}
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    await query(
      `INSERT INTO mission_progress (device_id, mission_id) VALUES ($1,$2)
       ON CONFLICT (device_id, mission_id) DO NOTHING`,
      [deviceId, req.params.id]
    )
    // award a small "started" XP once
    await query(
      `INSERT INTO profiles (device_id, xp) VALUES ($1, 10)
       ON CONFLICT (device_id) DO UPDATE SET xp = profiles.xp + 0`, [deviceId]
    )
    const p = await query(`SELECT * FROM mission_progress WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
    res.json({ ok: true, progress: p.rows[0] })
  } catch (err) { next(err) }
})

// POST /missions/:id/checkin  { deviceId, stopId, lat, lng, accuracy }
// Verifies GPS proximity to the stop, marks it complete, completes mission if all done.
router.post('/:id/checkin', async (req, res, next) => {
  try {
    const { deviceId, stopId, lat, lng, accuracy } = req.body || {}
    if (!deviceId || !stopId) return res.status(400).json({ error: 'deviceId and stopId required' })
    if (lat == null || lng == null) return res.status(400).json({ error: 'location_required', message: 'Allow location to check in.' })

    const stopRows = await query(`SELECT * FROM mission_stops WHERE id=$1 AND mission_id=$2`, [stopId, req.params.id])
    if (!stopRows.rows.length) return res.status(404).json({ error: 'stop_not_found' })
    const stop = stopRows.rows[0]

    const radius = stop.checkin_radius_m || 50
    const d = dist(lat, lng, stop.lat, stop.lng)
    const slack = Math.min(accuracy || 0, 25)
    if (d > radius + slack) {
      return res.status(403).json({ error: 'too_far', message: `You're ${Math.round(d)}m away — get within ${radius}m.`, distance: Math.round(d), required: radius })
    }

    // record the venue check-in too (verified)
    await query(`INSERT INTO check_ins (device_id, venue_id, lat, lng, gps_verified) VALUES ($1,$2,$3,$4,TRUE)`,
      [deviceId, stop.venue_id, lat, lng])

    // mark stop complete in progress
    await query(
      `INSERT INTO mission_progress (device_id, mission_id, completed_stops)
       VALUES ($1,$2, $3::jsonb)
       ON CONFLICT (device_id, mission_id) DO UPDATE
         SET completed_stops = (
           SELECT jsonb_agg(DISTINCT e) FROM jsonb_array_elements(mission_progress.completed_stops || $3::jsonb) e
         )`,
      [deviceId, req.params.id, JSON.stringify([parseInt(stopId)])]
    )

    // award XP for the stop
    await query(`INSERT INTO profiles (device_id, xp) VALUES ($1,25) ON CONFLICT (device_id) DO UPDATE SET xp = profiles.xp + 25, updated_at=now()`, [deviceId])

    // check if mission now complete
    const allStops = await query(`SELECT id FROM mission_stops WHERE mission_id=$1`, [req.params.id])
    const prog = await query(`SELECT completed_stops FROM mission_progress WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
    const done = new Set((prog.rows[0]?.completed_stops || []).map(Number))
    const allDone = allStops.rows.every(s => done.has(s.id))

    let reward = null
    if (allDone) {
      const m = await query(`SELECT * FROM missions WHERE id=$1`, [req.params.id])
      const mission = m.rows[0]
      // only award once
      const already = await query(`SELECT completed FROM mission_progress WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
      if (!already.rows[0]?.completed) {
        await query(`UPDATE mission_progress SET completed=TRUE, completed_at=now() WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
        await query(`INSERT INTO profiles (device_id, xp) VALUES ($1,$2) ON CONFLICT (device_id) DO UPDATE SET xp = profiles.xp + $2, updated_at=now()`, [deviceId, mission.reward_xp || 200])
        if (mission.badge_key) {
          await query(`INSERT INTO badges (device_id, badge_key, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
            [deviceId, mission.badge_key, mission.badge_name || 'Explorer'])
        }
        reward = { xp: mission.reward_xp || 200, badge: mission.badge_name, badgeKey: mission.badge_key }
      }
    }

    // recompute level
    const pr = await query(`SELECT xp FROM profiles WHERE device_id=$1`, [deviceId])
    const xp = pr.rows[0]?.xp || 0
    const level = Math.floor(xp / 200) + 1
    await query(`UPDATE profiles SET level=$1 WHERE device_id=$2`, [level, deviceId])

    res.json({ ok: true, stopCompleted: true, missionComplete: allDone, reward, xp, level, distance: Math.round(d) })
  } catch (err) { logger.error('mission checkin:', err.message); next(err) }
})

// GET /missions/progress/:deviceId — all missions a device has started/completed
router.get('/progress/:deviceId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT mp.*, m.title, m.city, m.badge_name, m.reward_xp,
              (SELECT COUNT(*) FROM mission_stops s WHERE s.mission_id=m.id) AS stop_count
       FROM mission_progress mp JOIN missions m ON m.id = mp.mission_id
       WHERE mp.device_id=$1 ORDER BY mp.started_at DESC`,
      [req.params.deviceId]
    )
    res.json({ missions: rows })
  } catch (err) { next(err) }
})

module.exports = router
