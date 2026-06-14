const express = require('express')
const { query } = require('../db/pool')
const { getMission } = require('../services/generateMission')
const { seedMissions } = require('../services/seedMissions')
const { generateMission } = require('../services/generateMission')
const { config } = require('../config')
const logger = require('../utils/logger')
const router = express.Router()

function dist(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180
  const dLat = r(c - a), dLng = r(d - b)
  const h = Math.sin(dLat/2)**2 + Math.cos(r(a))*Math.cos(r(c))*Math.sin(dLng/2)**2
  return 2 * R * Math.asin(Math.sqrt(h))
}
function checkSecret(req) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  return provided === config.syncSecret
}

// GET /missions?city=Liverpool[&type=daily]  — curated, active missions grouped
router.get('/', async (req, res, next) => {
  try {
    const { city, type } = req.query
    const params = [], where = ['active = TRUE']
    if (city) { params.push(city); where.push(`city = $${params.length}`) }
    if (type) { params.push(type); where.push(`type = $${params.length}`) }
    // time-window filter for daily/weekly
    where.push(`(starts_at IS NULL OR starts_at <= now())`)
    where.push(`(ends_at IS NULL OR ends_at >= now())`)
    const { rows } = await query(
      `SELECT m.*, (SELECT COUNT(*) FROM mission_stops s WHERE s.mission_id=m.id) AS stop_count
       FROM missions m WHERE ${where.join(' AND ')}
       ORDER BY CASE type WHEN 'featured' THEN 0 WHEN 'daily' THEN 1 WHEN 'weekly' THEN 2 ELSE 3 END, m.created_at DESC`,
      params
    )
    res.json({ missions: rows })
  } catch (err) { next(err) }
})

// GET /missions/users/me/missions?deviceId=  (before /:id to avoid collision)
router.get('/users/me/missions', async (req, res, next) => {
  try {
    const { deviceId } = req.query
    if (!deviceId) return res.json({ missions: [] })
    const { rows } = await query(
      `SELECT um.*, m.title, m.city, m.badge_name, m.reward_xp, m.type,
              (SELECT COUNT(*) FROM mission_stops s WHERE s.mission_id=m.id) AS stop_count,
              (SELECT COUNT(*) FROM mission_checkins c WHERE c.device_id=um.device_id AND c.mission_id=m.id AND c.verified=TRUE) AS done_count
       FROM user_missions um JOIN missions m ON m.id=um.mission_id
       WHERE um.device_id=$1 ORDER BY um.started_at DESC`, [deviceId]
    )
    res.json({ missions: rows })
  } catch (err) { next(err) }
})

// GET /missions/users/me/badges?deviceId=
router.get('/users/me/badges', async (req, res, next) => {
  try {
    const { deviceId } = req.query
    if (!deviceId) return res.json({ badges: [] })
    const { rows } = await query(`SELECT badge_name, mission_id, awarded_at FROM user_badges WHERE device_id=$1 ORDER BY awarded_at DESC`, [deviceId])
    res.json({ badges: rows })
  } catch (err) { next(err) }
})

// GET /missions/:id[?deviceId=]
router.get('/:id', async (req, res, next) => {
  try {
    const mission = await getMission(req.params.id)
    if (!mission) return res.status(404).json({ error: 'not_found' })
    const { deviceId } = req.query
    if (deviceId) {
      const um = await query(`SELECT * FROM user_missions WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
      const ck = await query(`SELECT mission_stop_id FROM mission_checkins WHERE device_id=$1 AND mission_id=$2 AND verified=TRUE`, [deviceId, req.params.id])
      mission.userMission = um.rows[0] || null
      mission.completedStops = ck.rows.map(r => r.mission_stop_id)
    }
    res.json(mission)
  } catch (err) { next(err) }
})

// POST /missions/:id/start { deviceId }
router.post('/:id/start', async (req, res, next) => {
  try {
    const { deviceId } = req.body || {}
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    await query(
      `INSERT INTO user_missions (device_id, mission_id, status) VALUES ($1,$2,'in_progress')
       ON CONFLICT (device_id, mission_id) DO NOTHING`, [deviceId, req.params.id]
    )
    const um = await query(`SELECT * FROM user_missions WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
    res.json({ ok: true, userMission: um.rows[0] })
  } catch (err) { next(err) }
})

// POST /missions/:id/stops/:stopId/checkin { deviceId, lat, lng, accuracy, photoUrl? }
router.post('/:id/stops/:stopId/checkin', async (req, res, next) => {
  try {
    const { deviceId, lat, lng, accuracy, photoUrl } = req.body || {}
    if (!deviceId) return res.status(400).json({ error: 'deviceId required' })
    if (lat == null || lng == null) return res.status(400).json({ error: 'location_required', message: 'Allow location to check in.' })

    const sRows = await query(`SELECT * FROM mission_stops WHERE id=$1 AND mission_id=$2`, [req.params.stopId, req.params.id])
    if (!sRows.rows.length) return res.status(404).json({ error: 'stop_not_found' })
    const stop = sRows.rows[0]

    const radius = stop.required_radius_meters || stop.checkin_radius_m || 50
    const d = dist(lat, lng, stop.lat, stop.lng)
    const slack = Math.min(accuracy || 0, 25)
    if (d > radius + slack) {
      return res.status(403).json({ error: 'too_far', message: `You're ${Math.round(d)}m away — get within ${radius}m.`, distance: Math.round(d), required: radius })
    }
    if (stop.photo_required && !photoUrl) {
      return res.status(400).json({ error: 'photo_required', message: 'This stop needs a photo to complete.' })
    }

    const method = photoUrl ? 'gps_photo' : 'gps'
    await query(
      `INSERT INTO mission_checkins (device_id, mission_id, mission_stop_id, latitude, longitude, accuracy, photo_url, verified, verification_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,$8)
       ON CONFLICT (device_id, mission_stop_id) DO UPDATE SET verified=TRUE, photo_url=COALESCE(EXCLUDED.photo_url, mission_checkins.photo_url), created_at=now()`,
      [deviceId, req.params.id, req.params.stopId, lat, lng, accuracy ?? null, photoUrl ?? null, method]
    )
    // stop XP
    await query(`INSERT INTO profiles (device_id, xp) VALUES ($1,25) ON CONFLICT (device_id) DO UPDATE SET xp=profiles.xp+25, updated_at=now()`, [deviceId])

    // all stops done?
    const all = await query(`SELECT id FROM mission_stops WHERE mission_id=$1`, [req.params.id])
    const done = await query(`SELECT mission_stop_id FROM mission_checkins WHERE device_id=$1 AND mission_id=$2 AND verified=TRUE`, [deviceId, req.params.id])
    const doneSet = new Set(done.rows.map(r => r.mission_stop_id))
    const allDone = all.rows.every(s => doneSet.has(s.id))

    let reward = null
    if (allDone) {
      const already = await query(`SELECT status FROM user_missions WHERE device_id=$1 AND mission_id=$2`, [deviceId, req.params.id])
      if (already.rows[0]?.status !== 'completed') {
        const m = await query(`SELECT * FROM missions WHERE id=$1`, [req.params.id])
        const mission = m.rows[0]
        await query(`UPDATE user_missions SET status='completed', completed_at=now(), xp_awarded=$1 WHERE device_id=$2 AND mission_id=$3`, [mission.reward_xp, deviceId, req.params.id])
        await query(`INSERT INTO profiles (device_id, xp) VALUES ($1,$2) ON CONFLICT (device_id) DO UPDATE SET xp=profiles.xp+$2, updated_at=now()`, [deviceId, mission.reward_xp])
        if (mission.badge_name) {
          await query(`INSERT INTO user_badges (device_id, badge_name, mission_id) VALUES ($1,$2,$3) ON CONFLICT (device_id, badge_name) DO NOTHING`, [deviceId, mission.badge_name, mission.id])
          await query(`INSERT INTO badges (device_id, badge_key, label) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [deviceId, (mission.badge_key || mission.badge_name.toLowerCase().replace(/[^a-z0-9]+/g,'_')), mission.badge_name])
        }
        reward = { xp: mission.reward_xp, badge: mission.badge_name }
      }
    }

    const pr = await query(`SELECT xp FROM profiles WHERE device_id=$1`, [deviceId])
    const xp = pr.rows[0]?.xp || 0
    const level = Math.floor(xp / 200) + 1
    await query(`UPDATE profiles SET level=$1 WHERE device_id=$2`, [level, deviceId])

    res.json({ ok: true, stopCompleted: true, missionComplete: allDone, reward, xp, level, distance: Math.round(d) })
  } catch (err) { logger.error('mission stop checkin:', err.message); next(err) }
})

// --- Admin (secret-protected) ---

// POST /missions/admin/seed?secret=  — seed curated missions
router.post('/admin/seed', async (req, res, next) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'unauthorized' })
    const result = await seedMissions()
    res.json({ ok: true, ...result })
  } catch (err) { next(err) }
})

// POST /missions/admin/generate?secret=  — Gemini-generate a curated mission
router.post('/admin/generate', async (req, res, next) => {
  try {
    if (!checkSecret(req)) return res.status(401).json({ error: 'unauthorized' })
    const { city, theme, duration, type } = req.body || {}
    if (!city) return res.status(400).json({ error: 'city required' })
    const result = await generateMission({ city, theme, duration })
    if (result?.error) return res.status(422).json(result)
    if (type && result.id) await query(`UPDATE missions SET type=$1 WHERE id=$2`, [type, result.id])
    res.json(result)
  } catch (err) { next(err) }
})

module.exports = router
