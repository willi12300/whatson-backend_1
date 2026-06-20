// src/services/behaviorLearning.js
// Lightweight behaviour learning for SAPPO. This is not heavy ML: it is a robust
// signal layer that lets the decision engine learn from actions such as shown,
// opened profile, added to plan, shared and directions tapped.

const { query } = require('../db/pool')
const logger = require('../utils/logger')

const ACTION_WEIGHTS = {
  shown: 0.15,
  clicked: 1.5,
  opened_profile: 2,
  added_to_plan: 6,
  saved: 5,
  shared: 5,
  directions: 8,
  dismissed: -2,
  ignored: -1,
}

function cleanId(v) {
  if (v == null || v === '') return null
  const s = String(v)
  if (/^\d+$/.test(s)) return Number(s)
  return null
}
function signalKey(prefix, value) {
  if (!value) return null
  return `${prefix}:${String(value).toLowerCase().trim().replace(/\s+/g, '_')}`
}
function itemKey(item = {}) {
  const id = item.venue_id || item.venueId || item.id || item.item_id || item.event_id || item.eventId
  const type = item.item_type || item.type || (item.event_id || item.eventId ? 'event' : 'venue')
  return `${type}:${id || (item.item_name || item.name || item.title || '').toLowerCase()}`
}

async function recordInteraction(input = {}) {
  const action = String(input.action || '').toLowerCase().trim()
  if (!action) return { ok: false, error: 'missing_action' }

  const itemType = input.itemType || input.item_type || input.type || (input.eventId || input.event_id ? 'event' : 'venue')
  const venueId = cleanId(input.venueId ?? input.venue_id)
  const eventId = cleanId(input.eventId ?? input.event_id)
  const itemId = String(input.itemId ?? input.item_id ?? venueId ?? eventId ?? '') || null
  const weight = ACTION_WEIGHTS[action] ?? 0

  try {
    await query(
      `INSERT INTO user_interactions
       (user_id, device_id, item_type, item_id, venue_id, event_id, item_name, action, category_slug, city, source, context, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [
        input.userId || null,
        input.deviceId || input.device_id || null,
        itemType,
        itemId,
        venueId,
        eventId,
        input.itemName || input.item_name || input.name || input.title || null,
        action,
        input.category || input.category_slug || null,
        input.city || null,
        input.source || null,
        input.context || null,
        JSON.stringify(input.metadata || {}),
      ]
    )

    if (venueId) {
      await query(
        `INSERT INTO venue_popularity_signals (venue_id, times_shown, times_clicked, times_opened, times_added, times_saved, times_shared, times_directions, times_dismissed, last_interaction_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (venue_id) DO UPDATE SET
           times_shown      = venue_popularity_signals.times_shown + EXCLUDED.times_shown,
           times_clicked    = venue_popularity_signals.times_clicked + EXCLUDED.times_clicked,
           times_opened     = venue_popularity_signals.times_opened + EXCLUDED.times_opened,
           times_added      = venue_popularity_signals.times_added + EXCLUDED.times_added,
           times_saved      = venue_popularity_signals.times_saved + EXCLUDED.times_saved,
           times_shared     = venue_popularity_signals.times_shared + EXCLUDED.times_shared,
           times_directions = venue_popularity_signals.times_directions + EXCLUDED.times_directions,
           times_dismissed  = venue_popularity_signals.times_dismissed + EXCLUDED.times_dismissed,
           last_interaction_at = now()`,
        [
          venueId,
          action === 'shown' ? 1 : 0,
          action === 'clicked' ? 1 : 0,
          action === 'opened_profile' ? 1 : 0,
          action === 'added_to_plan' ? 1 : 0,
          action === 'saved' ? 1 : 0,
          action === 'shared' ? 1 : 0,
          action === 'directions' ? 1 : 0,
          (action === 'dismissed' || action === 'ignored') ? 1 : 0,
        ]
      )
    }

    if (eventId) {
      await query(
        `INSERT INTO event_popularity_signals (event_id, times_shown, times_clicked, times_opened, times_added, times_saved, times_shared, times_directions, times_dismissed, last_interaction_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (event_id) DO UPDATE SET
           times_shown      = event_popularity_signals.times_shown + EXCLUDED.times_shown,
           times_clicked    = event_popularity_signals.times_clicked + EXCLUDED.times_clicked,
           times_opened     = event_popularity_signals.times_opened + EXCLUDED.times_opened,
           times_added      = event_popularity_signals.times_added + EXCLUDED.times_added,
           times_saved      = event_popularity_signals.times_saved + EXCLUDED.times_saved,
           times_shared     = event_popularity_signals.times_shared + EXCLUDED.times_shared,
           times_directions = event_popularity_signals.times_directions + EXCLUDED.times_directions,
           times_dismissed  = event_popularity_signals.times_dismissed + EXCLUDED.times_dismissed,
           last_interaction_at = now()`,
        [
          eventId,
          action === 'shown' ? 1 : 0,
          action === 'clicked' ? 1 : 0,
          action === 'opened_profile' ? 1 : 0,
          action === 'added_to_plan' ? 1 : 0,
          action === 'saved' ? 1 : 0,
          action === 'shared' ? 1 : 0,
          action === 'directions' ? 1 : 0,
          (action === 'dismissed' || action === 'ignored') ? 1 : 0,
        ]
      )
    }

    // Personal preference learning: categories/cities/sources the user acts on get gentle boosts.
    const ownerKey = input.userId ? `user:${input.userId}` : ((input.deviceId || input.device_id) ? `device:${input.deviceId || input.device_id}` : null)
    const keys = [
      signalKey('category', input.category || input.category_slug),
      signalKey('city', input.city),
      signalKey('source', input.source),
      signalKey('context', input.context),
    ].filter(Boolean)
    if (ownerKey && keys.length && weight !== 0) {
      for (const key of keys) {
        await query(
          `INSERT INTO user_preference_signals (owner_key, signal_key, signal_value, updated_at)
           VALUES ($1,$2,$3,now())
           ON CONFLICT (owner_key, signal_key) DO UPDATE SET
             signal_value = GREATEST(-20, LEAST(50, user_preference_signals.signal_value + EXCLUDED.signal_value)),
             updated_at = now()`,
          [ownerKey, key, weight]
        )
      }
    }
    return { ok: true }
  } catch (e) {
    logger.error('[learning] record failed:', e.message)
    return { ok: false, error: e.message }
  }
}

async function recordShownBatch({ userId = null, deviceId = null, items = [], context = null, city = null } = {}) {
  const safe = (items || []).slice(0, 30)
  for (const item of safe) {
    recordInteraction({
      userId, deviceId,
      action: 'shown', context, city: city || item.city,
      itemType: item.type || item.item_type || (item.event_id || item.eventId ? 'event' : 'venue'),
      venueId: item.venueId || item.venue_id || (item.type === 'venue' ? item.id : null),
      eventId: item.eventId || item.event_id || (item.type === 'event' ? item.id : null),
      itemId: item.id || item.item_id,
      itemName: item.title || item.name,
      category: item.category_slug || item.category,
      source: item.source,
    }).catch(() => {})
  }
}

async function getUserSignals({ userId = null, deviceId = null } = {}) {
  const out = { categoryBoost: {}, cityBoost: {}, sourceBoost: {}, raw: {} }
  try {
    let rows = []
    const ownerKey = userId ? `user:${userId}` : (deviceId ? `device:${deviceId}` : null)
    if (ownerKey) {
      const r = await query(`SELECT signal_key, signal_value FROM user_preference_signals WHERE owner_key=$1 ORDER BY updated_at DESC LIMIT 200`, [ownerKey])
      rows = r.rows
    }
    for (const r of rows) {
      out.raw[r.signal_key] = Number(r.signal_value || 0)
      const [prefix, val] = String(r.signal_key).split(':')
      if (prefix === 'category') out.categoryBoost[val] = Number(r.signal_value || 0)
      if (prefix === 'city') out.cityBoost[val] = Number(r.signal_value || 0)
      if (prefix === 'source') out.sourceBoost[val] = Number(r.signal_value || 0)
    }
  } catch (e) { logger.error('[learning] get user signals failed:', e.message) }
  return out
}

async function getVenueSignalMap(venueIds = []) {
  const ids = [...new Set((venueIds || []).map(cleanId).filter(Boolean))]
  if (!ids.length) return new Map()
  try {
    const { rows } = await query(`SELECT * FROM venue_popularity_signals WHERE venue_id = ANY($1)`, [ids])
    return new Map(rows.map(r => [Number(r.venue_id), r]))
  } catch (e) { logger.error('[learning] venue signal map failed:', e.message); return new Map() }
}

function venueLearningScore(card = {}, signals = null, userSignals = null) {
  let score = 0
  const s = signals || {}
  // Global proof that SAPPO users actually act on it. Capped so it never dominates.
  score += Math.min(Number(s.times_added || 0) * 1.5, 12)
  score += Math.min(Number(s.times_directions || 0) * 2, 14)
  score += Math.min(Number(s.times_shared || 0) * 1.2, 8)
  score += Math.min(Number(s.times_opened || 0) * 0.25, 8)
  score -= Math.min(Number(s.times_dismissed || 0) * 1.5, 10)
  // CTR style nudge: if shown lots but nobody opens/adds, cool it down.
  const shown = Number(s.times_shown || 0)
  const positive = Number(s.times_added || 0) + Number(s.times_directions || 0) + Number(s.times_saved || 0) + Number(s.times_shared || 0)
  if (shown >= 20 && positive === 0) score -= 8
  if (shown >= 20 && positive / shown > 0.12) score += 8

  const cat = String(card.category_slug || card.category || '').toLowerCase().replace(/\s+/g, '_')
  if (cat && userSignals?.categoryBoost?.[cat]) score += Math.max(-8, Math.min(12, userSignals.categoryBoost[cat] * 0.6))
  const source = String(card.source || '').toLowerCase().replace(/\s+/g, '_')
  if (source && userSignals?.sourceBoost?.[source]) score += Math.max(-4, Math.min(6, userSignals.sourceBoost[source] * 0.3))
  return score
}

module.exports = {
  ACTION_WEIGHTS,
  recordInteraction,
  recordShownBatch,
  getUserSignals,
  getVenueSignalMap,
  venueLearningScore,
  itemKey,
}
