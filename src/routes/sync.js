const express = require('express')
const { config, CITIES } = require('../config')
const { syncCity } = require('../services/sync')
const { query } = require('../db/pool')
const logger = require('../utils/logger')
const router = express.Router()

function checkSecret(req, res, next) {
  const provided = req.headers['x-sync-secret'] || req.query.secret
  if (provided !== config.syncSecret) return res.status(401).json({ error: 'Unauthorized — add ?secret=YOUR_SYNC_SECRET to the URL' })
  next()
}

// Changed to GET so you can trigger it straight from the browser
router.get('/liverpool', checkSecret, (req, res) => {
  res.json({ message: 'Liverpool sync started. Check /sync/status for progress.' })
  syncCity(CITIES.liverpool).catch(err => logger.error('Liverpool sync error:', err.message))
})

router.get('/city/:city', checkSecret, (req, res) => {
  const preset = CITIES[req.params.city.toLowerCase()]
  if (!preset) return res.status(404).json({ error: `Unknown city. Available: ${Object.keys(CITIES).join(', ')}` })
  res.json({ message: `${preset.name} sync started.` })
  syncCity(preset).catch(err => logger.error('Sync error:', err.message))
})

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 10`)
    res.json({ runs: rows })
  } catch (err) { next(err) }
})

// CLEAN UP bad OSM data. Deletes ONLY venues whose sources are OSM-only
// (no Google source) — so Google-quality venues are kept untouched.
// SAFETY: dry-run by default. Add &confirm=true to actually delete.
//   GET /sync/cleanup-osm?secret=...&city=Liverpool          → preview (counts only)
//   GET /sync/cleanup-osm?secret=...&city=Liverpool&confirm=true → delete
router.get('/cleanup-osm', checkSecret, async (req, res, next) => {
  try {
    const city = req.query.city || null
    const confirm = req.query.confirm === 'true'

    // venues that HAVE an osm source AND do NOT have a google source
    const cityFilter = city ? `AND v.city = $1` : ''
    const params = city ? [city] : []
    const targetSql = `
      SELECT v.id, v.name, v.category_slug, v.city
      FROM venues v
      WHERE EXISTS (SELECT 1 FROM venue_sources s WHERE s.venue_id = v.id AND s.provider = 'osm')
        AND NOT EXISTS (SELECT 1 FROM venue_sources s WHERE s.venue_id = v.id AND s.provider = 'google')
        ${cityFilter}`

    const target = await query(targetSql, params)
    const totalInCity = city
      ? (await query(`SELECT COUNT(*)::int AS n FROM venues WHERE city = $1`, [city])).rows[0].n
      : (await query(`SELECT COUNT(*)::int AS n FROM venues`)).rows[0].n

    if (!confirm) {
      return res.json({
        mode: 'DRY RUN (nothing deleted)',
        city: city || 'all',
        wouldDelete: target.rows.length,
        totalVenuesInScope: totalInCity,
        wouldKeep: totalInCity - target.rows.length,
        sample: target.rows.slice(0, 15).map(r => r.name),
        toDelete: 'Add &confirm=true to the URL to actually delete these.',
      })
    }

    // delete (CASCADE removes their venue_sources rows automatically)
    const ids = target.rows.map(r => r.id)
    let deleted = 0
    if (ids.length) {
      const del = await query(`DELETE FROM venues WHERE id = ANY($1)`, [ids])
      deleted = del.rowCount
    }
    logger.info(`[cleanup-osm] deleted ${deleted} OSM-only venues (city: ${city || 'all'})`)
    return res.json({
      mode: 'DELETED',
      city: city || 'all',
      deleted,
      remaining: totalInCity - deleted,
      note: 'Only OSM-only venues removed. Venues with a Google source were kept.',
    })
  } catch (err) { next(err) }
})

module.exports = router
