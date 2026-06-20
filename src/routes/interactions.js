const express = require('express')
const { recordInteraction, recordShownBatch, getUserSignals } = require('../services/behaviorLearning')
const router = express.Router()

// POST /interactions
// Body: { action, itemType, venueId, eventId, itemId, itemName, category, city, source, context, deviceId, metadata }
router.post('/', async (req, res) => {
  const body = req.body || {}
  const result = await recordInteraction({ ...body, userId: req.userId || body.userId || null })
  res.json(result)
})

// POST /interactions/batch-shown
// Body: { deviceId, context, city, items:[cards...] }
router.post('/batch-shown', async (req, res) => {
  const { deviceId, context, city, items = [] } = req.body || {}
  await recordShownBatch({ userId: req.userId || null, deviceId, context, city, items })
  res.json({ ok: true, recorded: Math.min((items || []).length, 30) })
})

// GET /interactions/preferences?deviceId=...
router.get('/preferences', async (req, res) => {
  const signals = await getUserSignals({ userId: req.userId || null, deviceId: req.query.deviceId || null })
  res.json({ preferences: signals })
})

module.exports = router
