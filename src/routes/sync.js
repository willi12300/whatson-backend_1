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

// FIND & MERGE DUPLICATE venues (same place saved twice from different sources).
// Two venues are duplicates if they're very close together AND have very similar names.
// Keeps the richer record (more data), moves the other's sources onto it, deletes the dupe.
// SAFETY: dry-run by default. Add &confirm=true to actually merge.
//   GET /sync/dedupe?secret=...&city=Liverpool            → preview
//   GET /sync/dedupe?secret=...&city=Liverpool&confirm=true → merge
router.get('/dedupe', checkSecret, async (req, res, next) => {
  try {
    const { distanceMeters, normaliseName, jaroWinkler } = require('../utils/helpers')
    const city = req.query.city || null
    const confirm = req.query.confirm === 'true'
    const maxMetres = parseInt(req.query.metres || '75')      // how close to consider same place
    const minNameSim = parseFloat(req.query.sim || '0.88')    // name similarity threshold

    const params = []
    let where = 'lat IS NOT NULL AND lng IS NOT NULL'
    if (city) { params.push(city); where += ` AND city = $${params.length}` }
    const { rows: venues } = await query(
      `SELECT id, name, lat, lng, rating, rating_count, google_place_id, cover_photo,
              (CASE WHEN cover_photo IS NOT NULL THEN 1 ELSE 0 END
               + CASE WHEN google_place_id IS NOT NULL THEN 1 ELSE 0 END
               + CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END) AS richness
       FROM venues WHERE ${where}`,
      params
    )

    // Match within the selected set. Two tiers:
    //  1. Same google_place_id → PROVABLY the same real place (Google's identity).
    //     No distance/name check needed — this is bulletproof.
    //  2. No shared place id → fall back to the name + distance heuristic, for
    //     venues that aren't both enriched with a place id.
    // Comparison is O(n²); run this PER CITY (pass &city=).
    const pairs = []
    const usedAsDupe = new Set()
    const arr = venues.slice().sort((a, b) => b.richness - a.richness)  // richest first = keepers

    // ── Tier 1: exact Google Place ID matches ──
    // A shared google_place_id USUALLY means the same real place — but not
    // always. Bad enrichment can stamp the same place id on multiple different
    // branches (e.g. 9 different Costa cafés all matched to one "Costa" id).
    // A genuine duplicate is always in the SAME physical spot, so we still
    // require the pair to be physically close. A shared place id on venues far
    // apart is a DATA ERROR (different branches), not a duplicate — we skip and
    // surface it so it can be re-enriched with correct per-branch ids.
    // A true duplicate is essentially the SAME spot (same building/entrance),
    // so we keep this tight — ~60m. Two same-named venues further apart than
    // this sharing one place id are branches with a wrongly-shared id, not dupes.
    const PLACE_ID_MAX_METRES = 60
    const badPlaceIdGroups = []
    const byPlaceId = new Map()
    for (const v of arr) {
      if (!v.google_place_id) continue
      if (!byPlaceId.has(v.google_place_id)) byPlaceId.set(v.google_place_id, [])
      byPlaceId.get(v.google_place_id).push(v)
    }
    for (const [pid, group] of byPlaceId) {
      if (group.length < 2) continue
      const keeper = group[0]   // already richest-first
      for (let k = 1; k < group.length; k++) {
        const dupe = group[k]
        if (usedAsDupe.has(dupe.id)) continue
        const d = distanceMeters(keeper.lat, keeper.lng, dupe.lat, dupe.lng)
        if (d > PLACE_ID_MAX_METRES) {
          // Same place id but far apart → almost certainly different branches
          // sharing a wrong id. Do NOT merge; flag for review/re-enrichment.
          badPlaceIdGroups.push({ google_place_id: pid, keep: { id: keeper.id, name: keeper.name }, suspect: { id: dupe.id, name: dupe.name }, metres: Math.round(d) })
          continue
        }
        pairs.push({ keep: { id: keeper.id, name: keeper.name }, remove: { id: dupe.id, name: dupe.name }, metres: Math.round(d), nameSim: null, matchType: 'place_id' })
        usedAsDupe.add(dupe.id)
      }
    }

    // ── Tier 2: name + distance heuristic (for the rest) ──
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i]
      if (usedAsDupe.has(a.id)) continue
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j]
        if (usedAsDupe.has(b.id)) continue
        // Skip pairs already decided by place id, and never merge two venues
        // that have DIFFERENT known place ids (Google says they're different).
        if (a.google_place_id && b.google_place_id && a.google_place_id !== b.google_place_id) continue
        const d = distanceMeters(a.lat, a.lng, b.lat, b.lng)
        if (d > maxMetres) continue
        const sim = jaroWinkler(normaliseName(a.name || ''), normaliseName(b.name || ''))
        if (sim >= minNameSim) {
          pairs.push({ keep: { id: a.id, name: a.name }, remove: { id: b.id, name: b.name }, metres: Math.round(d), nameSim: +sim.toFixed(2), matchType: 'name_distance' })
          usedAsDupe.add(b.id)   // b gets merged into a
        }
      }
    }

    if (!confirm) {
      // Show all pairs by default on dry-run so you can review every merge
      // before committing. Override with &sample=N to limit.
      const sampleN = req.query.sample ? Math.max(1, parseInt(req.query.sample)) : pairs.length
      return res.json({
        mode: 'DRY RUN (nothing merged)',
        city: city || 'all',
        duplicatePairsFound: pairs.length,
        sample: pairs.slice(0, sampleN),
        badPlaceIdGroupsFound: badPlaceIdGroups.length,
        badPlaceIdGroups: badPlaceIdGroups.slice(0, 100),
        badPlaceIdNote: badPlaceIdGroups.length
          ? 'These venues share a google_place_id but are far apart — almost certainly DIFFERENT branches wrongly given the same id. They were NOT merged. Re-enrich them to get correct per-branch place ids.'
          : undefined,
        toMerge: 'Add &confirm=true to merge. The "keep" (richer) venue stays; "remove" is merged into it.',
      })
    }

    // Optional: &exclude=7191,7370,7116 skips specific "remove" venue IDs so you
    // can merge everything EXCEPT a few pairs you want to review/keep separate.
    const excludeIds = new Set(
      String(req.query.exclude || '')
        .split(',')
        .map(s => parseInt(s.trim()))
        .filter(n => Number.isFinite(n))
    )

    let merged = 0, skipped = 0
    // Fields worth preserving from a duplicate before we delete it. If the
    // keeper is missing any of these but the dupe has it, copy it across — so
    // "keep the richer one" becomes "keep the UNION of both" and we never throw
    // away photos, ratings, TripAdvisor data, gem tags, hours, socials, etc.
    const PRESERVE = [
      'cover_photo', 'photos', 'google_place_id', 'google_maps_url', 'google_review_sample',
      'rating', 'rating_count', 'price_level', 'opening_hours', 'website',
      'tripadvisor_location_id', 'tripadvisor_rating', 'tripadvisor_review_count',
      'tripadvisor_ranking', 'tripadvisor_url', 'tripadvisor_top_review', 'tripadvisor_last_checked',
      'gem_tags', 'gem_cautions', 'gem_tags_checked', 'google_last_checked', 'profile_last_enriched',
      'instagram', 'facebook', 'menu_url', 'cuisine_type', 'price_range', 'average_spend_estimate',
    ]
    for (const p of pairs) {
      if (excludeIds.has(p.remove.id)) { skipped++; continue }
      try {
        // Pull both rows so we can gap-fill the keeper from the dupe.
        const [keepRow, dupeRow] = await Promise.all([
          query(`SELECT * FROM venues WHERE id=$1`, [p.keep.id]).then(r => r.rows[0]),
          query(`SELECT * FROM venues WHERE id=$1`, [p.remove.id]).then(r => r.rows[0]),
        ])
        if (keepRow && dupeRow) {
          const isEmpty = (v) => v == null || v === '' ||
            (Array.isArray(v) && v.length === 0) ||
            (typeof v === 'string' && (v === '[]' || v === '{}'))
          const sets = [], vals = []
          for (const col of PRESERVE) {
            if (isEmpty(keepRow[col]) && !isEmpty(dupeRow[col])) {
              vals.push(dupeRow[col])
              sets.push(`${col}=$${vals.length}`)
            }
          }
          if (sets.length) {
            vals.push(p.keep.id)
            await query(`UPDATE venues SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals).catch(e => logger.error('[dedupe] gap-fill failed:', e.message))
          }
        }
        // Move the dupe's sources onto the keeper, then delete the dupe.
        await query(`UPDATE venue_sources SET venue_id = $1 WHERE venue_id = $2`, [p.keep.id, p.remove.id]).catch(() => {})
        await query(`DELETE FROM venues WHERE id = $1`, [p.remove.id])
        merged++
      } catch (e) { logger.error('[dedupe] merge failed:', e.message) }
    }
    logger.info(`[dedupe] merged ${merged} duplicate venues (city: ${city || 'all'}${skipped ? `, skipped ${skipped}` : ''})`)
    return res.json({ mode: 'MERGED', city: city || 'all', merged, skipped, note: 'Richer venue kept; any fields it was missing were filled in from the duplicate before removal (non-destructive union merge).' })
  } catch (err) { next(err) }
})

// GET /sync/reset-bad-place-ids?secret=...&city=Liverpool             → preview
// GET /sync/reset-bad-place-ids?secret=...&city=Liverpool&confirm=true → apply
//
// Finds venues that SHARE a google_place_id with other venues that are far
// away — i.e. different branches/places wrongly given the same id during
// enrichment (e.g. 9 Costa branches all on one "Costa" id). For each such
// group it KEEPS the id on the richest/most-central member and NULLs it on the
// others, so the next enrichment re-matches them from name+address and lands on
// the correct per-branch place. Nulling an id is safe: it just triggers a fresh
// match. Dry-run by default.
router.get('/reset-bad-place-ids', checkSecret, async (req, res, next) => {
  try {
    const { distanceMeters } = require('../utils/helpers')
    const city = req.query.city || null
    const confirm = req.query.confirm === 'true'
    const maxMetres = parseInt(req.query.metres || '60')   // same "same-spot" bar as dedupe

    const params = []
    let where = "google_place_id IS NOT NULL AND lat IS NOT NULL AND lng IS NOT NULL"
    if (city) { params.push(city); where += ` AND city = $${params.length}` }
    const { rows } = await query(
      `SELECT id, name, lat, lng, google_place_id, rating_count,
              (CASE WHEN rating IS NOT NULL THEN 1 ELSE 0 END
               + CASE WHEN cover_photo IS NOT NULL THEN 1 ELSE 0 END) AS richness
         FROM venues WHERE ${where}`,
      params
    )

    // Group by place id; a group is "bad" if any member is > maxMetres from the
    // group's anchor (the richest member).
    const groups = new Map()
    for (const v of rows) {
      if (!groups.has(v.google_place_id)) groups.set(v.google_place_id, [])
      groups.get(v.google_place_id).push(v)
    }

    const toReset = []   // venues whose (wrong) id we will null
    for (const [pid, members] of groups) {
      if (members.length < 2) continue
      members.sort((a, b) => (b.richness - a.richness) || ((b.rating_count || 0) - (a.rating_count || 0)))
      const anchor = members[0]
      const farApart = members.slice(1).some(m => distanceMeters(anchor.lat, anchor.lng, m.lat, m.lng) > maxMetres)
      if (!farApart) continue   // all clustered = genuine, leave alone
      // Keep the id on the anchor, reset it on everyone else in the group.
      for (const m of members) {
        if (m.id === anchor.id) continue
        toReset.push({ id: m.id, name: m.name, google_place_id: pid, keptOn: { id: anchor.id, name: anchor.name } })
      }
    }

    if (!confirm) {
      return res.json({
        mode: 'DRY RUN (nothing changed)',
        city: city || 'all',
        venuesToReset: toReset.length,
        sample: toReset.slice(0, 100),
        note: 'These venues share a place id with a far-away venue (wrong id). Add &confirm=true to NULL their google_place_id so the next enrichment re-matches them correctly. The richest member of each group keeps the id.',
      })
    }

    let reset = 0
    for (const r of toReset) {
      // Null the wrong id + related google fields so enrichment does a fresh match.
      await query(
        `UPDATE venues SET google_place_id=NULL, google_last_checked=NULL, google_status='needs_rematch' WHERE id=$1`,
        [r.id]
      ).then(() => reset++).catch(e => logger.error('[reset-bad-place-ids] failed for ' + r.id + ': ' + e.message))
    }
    logger.info(`[reset-bad-place-ids] reset ${reset} venues (city: ${city || 'all'})`)
    return res.json({
      mode: 'RESET',
      city: city || 'all',
      reset,
      note: 'Wrong place ids cleared. Now run enrich-google (repeat until scanned:0) to re-match these venues to their correct Google listing.',
    })
  } catch (err) { next(err) }
})

module.exports = router
