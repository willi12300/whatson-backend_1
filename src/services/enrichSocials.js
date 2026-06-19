// src/services/enrichSocials.js
// Visits each venue's OWN website (the one they published) and reads the
// Instagram / Facebook links they put in their own page. This is reading a
// venue's public, self-published links — not scraping Instagram itself.

const axios = require('axios')
const { query } = require('../db/pool')
const logger = require('../utils/logger')
const { sleep } = require('../utils/helpers')

async function ensureSocialColumns() {
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS instagram TEXT`).catch(() => {})
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS facebook TEXT`).catch(() => {})
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS socials_checked BOOLEAN DEFAULT FALSE`).catch(() => {})
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS socials_last_checked TIMESTAMPTZ`).catch(() => {})
}

// Pull instagram/facebook/menu links out of raw HTML from a venue's own website.
function extractSocials(html) {
  const out = {}
  const body = String(html || '')

  // instagram.com/<handle>
  const ig = body.match(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i)
  if (ig && !['p', 'reel', 'explore', 'accounts'].includes(ig[1].toLowerCase())) {
    out.instagram = `https://instagram.com/${ig[1]}`
  }

  // facebook.com/<page>
  const fb = body.match(/https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9_.\-]+)/i)
  if (fb && !['sharer', 'plugins', 'tr', 'dialog'].includes(fb[1].toLowerCase())) {
    out.facebook = `https://facebook.com/${fb[1]}`
  }

  // menu links from common href patterns on the venue's own website.
  const menu = body.match(/href=["']([^"']*(?:menu|food|drink|brunch|breakfast)[^"']*)["']/i)
  if (menu?.[1]) out.menu_url = menu[1]

  return out
}

function absolutiseUrl(url, base) {
  if (!url) return null
  try { return new URL(url, base).toString() } catch { return url }
}

async function enrichVenueSocials(venueId, { force = false } = {}) {
  await ensureSocialColumns()
  const { rows } = await query(`SELECT id, name, website, instagram, facebook, menu_url, socials_checked FROM venues WHERE id=$1`, [venueId])
  if (!rows.length) return { found: false, reason: 'venue_not_found' }
  const v = rows[0]
  if (!v.website) {
    await query(`UPDATE venues SET socials_checked=TRUE, socials_last_checked=now() WHERE id=$1`, [venueId]).catch(() => {})
    return { found: false, reason: 'no_website' }
  }
  if (!force && v.socials_checked && (v.instagram || v.facebook)) {
    return { found: true, skipped: true, instagram: v.instagram, facebook: v.facebook, menu_url: v.menu_url }
  }

  try {
    const res = await axios.get(v.website, {
      timeout: 8000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SappoBot/1.0; +https://sappo.app)' },
      validateStatus: s => s < 400,
    })
    const socials = extractSocials(typeof res.data === 'string' ? res.data : '')
    const menuUrl = absolutiseUrl(socials.menu_url, v.website)
    await query(
      `UPDATE venues SET
         instagram = COALESCE($1, instagram),
         facebook = COALESCE($2, facebook),
         menu_url = COALESCE($3, menu_url),
         socials_checked = TRUE,
         socials_last_checked = now()
       WHERE id = $4`,
      [socials.instagram || null, socials.facebook || null, menuUrl || null, venueId]
    )
    return {
      found: !!(socials.instagram || socials.facebook || menuUrl),
      instagram: socials.instagram || null,
      facebook: socials.facebook || null,
      menu_url: menuUrl || null,
    }
  } catch (err) {
    await query(`UPDATE venues SET socials_checked=TRUE, socials_last_checked=now() WHERE id=$1`, [venueId]).catch(() => {})
    return { found: false, reason: err.message }
  }
}

async function enrichCity(cityName, maxVenues = 300) {
  await ensureSocialColumns()

  const { rows } = await query(
    `SELECT id, name, website FROM venues
     WHERE city = $1 AND website IS NOT NULL AND website <> '' AND COALESCE(socials_checked, FALSE) = FALSE
     LIMIT $2`,
    [cityName, maxVenues]
  )

  logger.info(`Enrich: ${rows.length} ${cityName} venues with websites to check`)
  let found = 0

  for (const v of rows) {
    const out = await enrichVenueSocials(v.id)
    if (out.found) found++
    await sleep(200)
  }

  logger.info(`Enrich done for ${cityName}: found socials for ${found} venues`)
  return { checked: rows.length, found }
}

module.exports = { enrichCity, enrichVenueSocials, extractSocials }
