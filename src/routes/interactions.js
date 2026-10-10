const express = require('express')
const { recordInteraction, recordShownBatch, getUserSignals } = require('../services/behaviorLearning')
const { query } = require('../db/pool')
const router = express.Router()

// POST /interactions
// Body: { action, itemType, venueId, eventId, itemId, itemName, category, city, source, context, deviceId, metadata }
router.post('/', async (req, res) => {
  const body = req.body || {}
  const result = await recordInteraction({ ...body, userId: req.userId || null })
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

// Aggregate Swipe interest, not star reviews. Count people/accounts where known,
// otherwise anonymous devices. Repeat saves never inflate these unique counts.
router.get('/venue-likes', async (req, res, next) => {
  const ids=[...new Set(String(req.query.venueIds||'').split(',').filter(x=>/^\d+$/.test(x)).map(Number))].filter(Number.isSafeInteger).filter(x=>x>0).slice(0,100)
  if(!ids.length)return res.status(400).json({error:'venueIds_required'})
  try {
    const {rows}=await query(`
      WITH device_accounts AS (
        SELECT DISTINCT ON (device_id) device_id, user_id
        FROM user_interactions WHERE user_id IS NOT NULL AND device_id IS NOT NULL
        ORDER BY device_id, created_at DESC, id DESC
      ), signals AS (
        SELECT i.*, COALESCE('user:' || i.user_id::text, 'user:' || a.user_id::text, 'device:' || i.device_id) AS owner
        FROM user_interactions i LEFT JOIN device_accounts a USING(device_id)
        WHERE i.context='swipe' AND i.venue_id=ANY($1::int[])
          AND (i.user_id IS NOT NULL OR i.device_id IS NOT NULL)
      ), saves AS (
        SELECT DISTINCT ON (venue_id,owner) venue_id,owner,action
        FROM signals WHERE action IN ('saved','unsaved')
        ORDER BY venue_id,owner,created_at DESC,id DESC
      ), totals AS (
        SELECT venue_id,
          COUNT(DISTINCT owner) FILTER (WHERE action='saved')::int AS unique_savers_ever,
          COUNT(DISTINCT owner) FILTER (WHERE action='added_to_plan')::int AS unique_planners_ever,
          COUNT(DISTINCT owner) FILTER (WHERE action IN ('saved','added_to_plan'))::int AS unique_matches_ever,
          COUNT(DISTINCT user_id)::int AS signed_in_accounts
        FROM signals GROUP BY venue_id
      )
      SELECT t.*, (SELECT COUNT(*)::int FROM saves s WHERE s.venue_id=t.venue_id AND s.action='saved') AS active_savers
      FROM totals t ORDER BY t.venue_id`,[ids])
    const byId=new Map(rows.map(r=>[Number(r.venue_id),r]))
    res.json({venues:ids.map(id=>byId.get(id)||{venue_id:id,unique_savers_ever:0,unique_planners_ever:0,unique_matches_ever:0,signed_in_accounts:0,active_savers:0}),counting:'Verified accounts when available; otherwise anonymous devices. These are interest signals, not reviews.'})
  }catch(err){next(err)}
})

module.exports = router

