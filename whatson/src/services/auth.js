// src/services/auth.js
// Google ID-token verification + our own JWT sessions.

const { OAuth2Client } = require('google-auth-library')
const jwt = require('jsonwebtoken')
const { query } = require('../db/pool')
const logger = require('../utils/logger')

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const JWT_SECRET = process.env.JWT_SECRET || process.env.SYNC_SECRET || 'dev_jwt_secret'

const client = new OAuth2Client(GOOGLE_CLIENT_ID)

// Verify a Google ID token, upsert the user, return { user, token }
async function loginWithGoogle(idToken, deviceId) {
  if (!GOOGLE_CLIENT_ID) throw new Error('GOOGLE_CLIENT_ID not set on server')

  const ticket = await client.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID })
  const p = ticket.getPayload()
  // p: sub (google id), name, email, picture

  const { rows } = await query(
    `INSERT INTO users (google_id, name, email, avatar_url)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (google_id) DO UPDATE
       SET name=EXCLUDED.name, email=EXCLUDED.email, avatar_url=EXCLUDED.avatar_url, updated_at=now()
     RETURNING id, google_id, name, email, avatar_url, xp, level`,
    [p.sub, p.name || null, p.email || null, p.picture || null]
  )
  const user = rows[0]

  // claim any device-based progress into this account (one-time merge)
  if (deviceId) {
    await query(`UPDATE check_ins SET user_id=$1 WHERE device_id=$2 AND user_id IS NULL`, [user.id, deviceId]).catch(() => {})
    await query(`UPDATE badges SET user_id=$1 WHERE device_id=$2 AND user_id IS NULL`, [user.id, deviceId]).catch(() => {})
    // pull any device XP into the account
    const dev = await query(`SELECT xp FROM profiles WHERE device_id=$1`, [deviceId]).catch(() => ({ rows: [] }))
    if (dev.rows?.[0]?.xp) {
      await query(`UPDATE users SET xp = xp + $1, level = GREATEST(level, floor((xp+$1)/200)+1) WHERE id=$2`, [dev.rows[0].xp, user.id])
    }
  }

  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '60d' })
  return { user, token }
}

// Express middleware: attaches req.userId if a valid token is present.
// Does NOT block — routes decide if login is required.
function withAuth(req, res, next) {
  const h = req.headers.authorization
  if (h && h.startsWith('Bearer ')) {
    try { req.userId = jwt.verify(h.slice(7), JWT_SECRET).uid } catch {}
  }
  next()
}

// Use on routes that REQUIRE login
function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'login_required' })
  next()
}

module.exports = { loginWithGoogle, withAuth, requireAuth }
