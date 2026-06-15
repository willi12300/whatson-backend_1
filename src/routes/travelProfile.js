// src/routes/travelProfile.js
const express = require('express')
const { getProfile, applySignal, deriveStyle } = require('../services/travelProfile')
const logger = require('../utils/logger')
const router = express.Router()

// resolve a profile key from auth (preferred) or deviceId in body/query
function keyFrom(req) {
  if (req.userId) return { userId: req.userId }
  const deviceId = req.body?.deviceId || req.query?.deviceId
  return deviceId ? { deviceId } : null
}

// GET /profile/travel-style → the friendly "Your Sappo Style"
router.get('/travel-style', async (req, res, next) => {
  try {
    const key = keyFrom(req)
    if (!key) return res.json({ style: deriveStyle(null) })
    const profile = await getProfile(key)
    return res.json({ style: deriveStyle(profile), profile: publicProfile(profile) })
  } catch (e) { logger.error('[profile] style error:', e.message); next(e) }
})

// POST /profile/signal  { signal, deviceId?, categories? } → updates scores
router.post('/signal', async (req, res, next) => {
  try {
    const key = keyFrom(req)
    if (!key) return res.json({ ok: false, reason: 'no_identity' })
    const { signal, categories } = req.body || {}
    if (!signal) return res.status(400).json({ error: 'signal required' })
    const updated = await applySignal(key, signal, { categories: categories || [] })
    return res.json({ ok: true, style: deriveStyle(updated) })
  } catch (e) { logger.error('[profile] signal error:', e.message); next(e) }
})

function publicProfile(p) {
  if (!p) return null
  const { id, user_id, device_id, created_at, ...rest } = p
  return rest
}

module.exports = router
