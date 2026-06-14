const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()

// GET /profile/:deviceId  — XP, level, badges, checkin count
router.get('/:deviceId', async (req, res, next) => {
  try {
    const d = req.params.deviceId
    const prof = await query(`SELECT xp, level FROM profiles WHERE device_id=$1`, [d])
    const badges = await query(`SELECT badge_key, label, earned_at FROM badges WHERE device_id=$1 ORDER BY earned_at DESC`, [d])
    const checkins = await query(`SELECT COUNT(*) FROM check_ins WHERE device_id=$1`, [d])
    const xp = prof.rows[0]?.xp || 0
    const level = prof.rows[0]?.level || 1
    res.json({
      xp, level,
      nextLevelXp: level * 200,
      badges: badges.rows,
      checkinCount: parseInt(checkins.rows[0].count),
    })
  } catch (err) { next(err) }
})

module.exports = router
