const express = require('express')
const axios = require('axios')
const logger = require('../utils/logger')

const router = express.Router()
const PHOTO_NAME = /^places\/[^/]+\/photos\/[^/]+$/

// GET /media/google-photo?name=places/.../photos/...&width=900
// Keeps GOOGLE_PLACES_API_KEY on Railway rather than exposing it in the app.
router.get('/google-photo', async (req, res) => {
  const key = process.env.GOOGLE_PLACES_API_KEY
  const name = String(req.query.name || '')
  const requestedWidth = Number(req.query.width)
  const width = Number.isFinite(requestedWidth)
    ? Math.max(100, Math.min(Math.round(requestedWidth), 1600))
    : 900

  if (!key) return res.status(503).json({ error: 'photo_service_unavailable' })
  if (!PHOTO_NAME.test(name)) return res.status(400).json({ error: 'invalid_photo_name' })

  try {
    const upstream = await axios.get(`https://places.googleapis.com/v1/${name}/media`, {
      params: { maxWidthPx: width },
      headers: { 'X-Goog-Api-Key': key },
      responseType: 'stream',
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: status => status >= 200 && status < 400,
    })

    const contentType = String(upstream.headers['content-type'] || '')
    if (!contentType.startsWith('image/')) {
      upstream.data.destroy()
      return res.status(502).json({ error: 'invalid_photo_response' })
    }

    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'public, max-age=3600')
    if (upstream.headers.etag) res.set('ETag', upstream.headers.etag)
    upstream.data.on('error', err => {
      logger.error('[media] Google photo stream failed:', err.message)
      if (!res.headersSent) res.status(502).end()
      else res.destroy(err)
    })
    upstream.data.pipe(res)
  } catch (err) {
    logger.error('[media] Google photo failed:', err.response?.status || err.message)
    if (!res.headersSent) res.status(err.response?.status === 404 ? 404 : 502).json({ error: 'photo_unavailable' })
  }
})

module.exports = router
