const express = require('express')
const { loginWithGoogle, requireAuth } = require('../services/auth')
const { query } = require('../db/pool')
const logger = require('../utils/logger')
const router = express.Router()

// POST /auth/google  { idToken, deviceId? }  → { user, token }
router.post('/google', async (req, res) => {
  try {
    const { idToken, deviceId } = req.body || {}
    if (!idToken) return res.status(400).json({ error: 'idToken required' })
    const { user, token } = await loginWithGoogle(idToken, deviceId)
    res.json({ user, token })
  } catch (err) {
    logger.error('Google login failed:', err.message)
    res.status(401).json({ error: 'auth_failed', detail: err.message })
  }
})

// GET /auth/me  → current user (requires Bearer token)
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, google_id, name, email, avatar_url, xp, level FROM users WHERE id=$1`,
      [req.userId]
    )
    if (!rows.length) return res.status(404).json({ error: 'not_found' })
    res.json({ user: rows[0] })
  } catch (err) { next(err) }
})

module.exports = router
