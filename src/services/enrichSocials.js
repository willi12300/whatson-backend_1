// src/services/enrichSocials.js
// Visits each venue's OWN website (the one they published) and reads the
// Instagram / Facebook links they put in their own page. This is reading a
// venue's public, self-published links — not scraping Instagram itself.

const axios = require('axios')
const { query } = require('../db/pool')
const logger = require('../utils/logger')
const { sleep } = require('../utils/helpers')

// Pull instagram/facebook handles out of raw HTML
function extractSocials(html) {
  const out = {}
  // instagram.com/<handle>
  const ig = html.match(/https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)/i)
  if (ig && !['p', 'reel', 'explore', 'accounts'].includes(ig[1].toLowerCase())) {
    out.instagram = `https://instagram.com/${ig[1]}`
  }
  // facebook.com/<page>
  const fb = html.match(/https?:\/\/(?:www\.)?facebook\.com\/([A-Za-z0-9_.\-]+)/i)
  if (fb && !['sharer', 'plugins', 'tr', 'dialog'].includes(fb[1].toLowerCase())) {
    out.facebook = `https://facebook.com/${fb[1]}`
  }
  return out
}

async function enrichCity(cityName, maxVenues = 300) {
  // add columns if they don't exist yet
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS instagram TEXT`)
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS facebook TEXT`)
  await query(`ALTER TABLE venues ADD COLUMN IF NOT EXISTS socials_checked BOOLEAN DEFAULT FALSE`)

  // venues with a website we haven't checked yet
  const { rows } = await query(
    `SELECT id, name, website FROM venues
     WHERE city = $1 AND website IS NOT NULL AND website <> '' AND socials_checked = FALSE
     LIMIT $2`,
    [cityName, maxVenues]
  )

  logger.info(`Enrich: ${rows.length} ${cityName} venues with websites to check`)
  let found = 0

  for (const v of rows) {
    try {
      const res = await axios.get(v.website, {
        timeout: 8000,
        maxRedirects: 3,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WhatsOnBot/1.0)' },
        validateStatus: s => s < 400,
      })
      const socials = extractSocials(typeof res.data === 'string' ? res.data : '')
      if (socials.instagram || socials.facebook) {
        found++
        await query(
          `UPDATE venues SET instagram = COALESCE($1, instagram), facebook = COALESCE($2, facebook), socials_checked = TRUE WHERE id = $3`,
          [socials.instagram || null, socials.facebook || null, v.id]
        )
      } else {
        await query(`UPDATE venues SET socials_checked = TRUE WHERE id = $1`, [v.id])
      }
    } catch (err) {
      // site down / blocked / timeout — mark checked so we don't retry forever
      await query(`UPDATE venues SET socials_checked = TRUE WHERE id = $1`, [v.id])
    }
    await sleep(200) // be polite
  }

  logger.info(`Enrich done for ${cityName}: found socials for ${found} venues`)
  return { checked: rows.length, found }
}

module.exports = { enrichCity }
