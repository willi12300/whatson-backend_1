const express = require('express')
const axios = require('axios')
const logger = require('../utils/logger')

const router = express.Router()
const PHOTO_NAME = /^places\/[^/]+\/photos\/[^/]+$/
const refreshedPhotos = new Map()
const REFRESH_TTL_MS = 6 * 60 * 60 * 1000

function placeIdFromPhotoName(name) {
  return name.split('/')[1] || null
}

async function freshPhotoName(placeId, key) {
  const cached = refreshedPhotos.get(placeId)
  if (cached && cached.expiresAt > Date.now()) return cached.name

  const response = await axios.get(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'photos',
    },
    timeout: 15000,
  })
  const name = response.data?.photos?.[0]?.name
  if (!PHOTO_NAME.test(String(name || ''))) return null
  refreshedPhotos.set(placeId, { name, expiresAt: Date.now() + REFRESH_TTL_MS })
  return name
}

async function photoResponse(name, width, key) {
  // Asking Google for the signed URI first avoids forwarding credentials across
  // Google's redirect and gives us a clean 400 when a stored photo name expired.
  const media = await axios.get(`https://places.googleapis.com/v1/${name}/media`, {
    params: { maxWidthPx: width, skipHttpRedirect: true },
    headers: { 'X-Goog-Api-Key': key },
    timeout: 15000,
  })
  const photoUri = media.data?.photoUri
  if (!photoUri) throw Object.assign(new Error('missing_photo_uri'), { response: { status: 502 } })
  return axios.get(photoUri, {
    responseType: 'arraybuffer',
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: status => status >= 200 && status < 300,
  })
}

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
    let upstream
    try {
      upstream = await photoResponse(name, width, key)
    } catch (firstError) {
      if (firstError.response?.status !== 400) throw firstError
      const freshName = await freshPhotoName(placeIdFromPhotoName(name), key)
      if (!freshName) throw firstError
      upstream = await photoResponse(freshName, width, key)
    }

    const contentType = String(upstream.headers['content-type'] || '')
    if (!contentType.startsWith('image/')) {
      return res.status(502).json({ error: 'invalid_photo_response' })
    }

    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'public, max-age=3600')
    if (upstream.headers.etag) res.set('ETag', upstream.headers.etag)
    res.send(Buffer.from(upstream.data))
  } catch (err) {
    logger.error('[media] Google photo failed:', err.response?.status || err.message)
    if (!res.headersSent) res.status(err.response?.status === 404 ? 404 : 502).json({ error: 'photo_unavailable' })
  }
})

module.exports = router
