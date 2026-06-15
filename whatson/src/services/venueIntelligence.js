// src/services/venueIntelligence.js
// Derives readable pricing + light menu hints from data we already hold legally
// (Google price_level, category, website). No scraping. Safe to run repeatedly.

const { query } = require('../db/pool')
const { spendFor } = require('./costEstimate')
const logger = require('../utils/logger')

const FOOD_CATS = ['restaurant', 'cafe']

// Turn a price_level (1-4) + category into a readable range + average spend.
function derivePricing(cat, priceLevel) {
  if (!priceLevel) return null
  const [lo, hi] = spendFor(cat, priceLevel)
  return {
    price_range: `£${lo}-${hi}`,
    average_spend_estimate: Math.round((lo + hi) / 2),
    min_price: lo,
    max_price: hi,
    pricing_source: 'google_price_level',
  }
}

// For food venues with a website, treat the website as a menu link (many restaurants
// link their menu from the homepage). We do NOT fetch or scrape it — just store the link.
function deriveMenu(cat, website) {
  if (!FOOD_CATS.includes(cat) || !website) return null
  return { menu_url: website }
}

// Enrich all venues for a city (or all). Returns counts.
async function enrichVenueIntelligence(city = null) {
  const params = []
  let where = `WHERE price_level IS NOT NULL`
  if (city) { params.push(city); where += ` AND city = $1` }
  const { rows } = await query(`SELECT id, category_slug, price_level, website FROM venues ${where}`, params)

  let priced = 0, menus = 0
  for (const v of rows) {
    const pricing = derivePricing(v.category_slug, v.price_level)
    const menu = deriveMenu(v.category_slug, v.website)
    if (pricing) {
      await query(
        `UPDATE venues SET price_range=$1, average_spend_estimate=$2, min_price=$3, max_price=$4, pricing_source=$5 WHERE id=$6`,
        [pricing.price_range, pricing.average_spend_estimate, pricing.min_price, pricing.max_price, pricing.pricing_source, v.id]
      )
      priced++
    }
    if (menu) {
      await query(`UPDATE venues SET menu_url=COALESCE(menu_url, $1) WHERE id=$2`, [menu.menu_url, v.id])
      menus++
    }
  }
  logger.info(`Venue intelligence: priced ${priced}, menu links ${menus} (city: ${city || 'all'})`)
  return { priced, menus }
}

module.exports = { enrichVenueIntelligence, derivePricing }
