const express = require('express')
const { recommendationEngine } = require('../services/recommendationEngine')

const router = express.Router()
const MODES = new Set(['tell_sappo', 'guide_me', 'surprise_me', 'refine'])

router.post('/experience', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const mode = body.mode || 'tell_sappo'
    if (!MODES.has(mode)) return res.status(400).json({ error: 'Unsupported recommendation mode' })
    if (!body.location && body.lat == null && body.lng == null && !body.city) {
      return res.status(400).json({ error: 'Location is required' })
    }
    const result = await recommendationEngine({ ...body, mode, userId: req.userId || body.userId || null })
    res.status(result.experience ? 200 : 422).json(result)
  } catch (error) { next(error) }
})

module.exports = router
