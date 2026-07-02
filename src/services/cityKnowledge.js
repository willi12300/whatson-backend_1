// src/services/cityKnowledge.js
// Builds a compact-but-rich digest of what a city ACTUALLY contains, so the
// concierge AI can chat with real knowledge instead of generic guesses — e.g.
// name genuine local spots, ask questions that fit what's available, and not
// over-promise things the DB doesn't have.
//
// IMPORTANT: this grounds the CONVERSATION. The actual plan/suggestion cards
// are still built by the engine from live data — so a stray AI name-drop can
// never corrupt a plan. Worst case, chat mentions something a card doesn't.

const { query } = require('../db/pool')
const logger = require('../utils/logger')

// Short-lived cache so we don't re-query on every chat message.
const cache = new Map()   // cityName -> { text, fetchedAt }
const TTL_MS = 10 * 60 * 1000

// Map raw category_slug values into the friendly buckets the AI talks in.
function bucketOf(slug) {
  const s = String(slug || '').toLowerCase()
  if (/(restaurant|food|cafe|brunch|breakfast|bakery|diner|bistro|eatery|kitchen)/.test(s)) return 'food'
  if (/(bar|pub|cocktail|wine|brewery|taproom)/.test(s)) return 'bars'
  if (/(club|nightclub|nightlife)/.test(s)) return 'nightlife'
  if (/(museum|gallery|art)/.test(s)) return 'culture'
  if (/(landmark|attraction|historic|monument|church|cathedral|castle|tourist)/.test(s)) return 'landmarks'
  if (/(park|garden|nature|trail|viewpoint|waterfront|beach|scenic)/.test(s)) return 'outdoors'
  if (/(theatre|theater|cinema|comedy|music_venue|live)/.test(s)) return 'entertainment'
  if (/(coffee)/.test(s)) return 'coffee'
  return 'other'
}

const BUCKET_LABEL = {
  food: 'food & restaurants', bars: 'bars & pubs', nightlife: 'nightlife',
  culture: 'museums & galleries', landmarks: 'landmarks & sights',
  outdoors: 'parks & outdoors', entertainment: 'theatre & live entertainment',
  coffee: 'coffee', other: 'other',
}

function parseTags(val) {
  if (Array.isArray(val)) return val
  if (typeof val === 'string') { try { const p = JSON.parse(val); return Array.isArray(p) ? p : [] } catch { return [] } }
  return []
}

// Build the digest text for a city. Returns a compact multi-line string ready
// to drop into the system prompt, or '' if we have little/no data (in which
// case the AI just behaves as before — no false grounding).
async function getCityKnowledge(cityName) {
  if (!cityName) return ''
  const key = cityName.toLowerCase()
  const hit = cache.get(key)
  if (hit && (Date.now() - hit.fetchedAt) < TTL_MS) return hit.text

  try {
    const { rows } = await query(
      `SELECT name, category_slug, rating, rating_count, gem_tags
         FROM venues
        WHERE city = $1 AND name IS NOT NULL
          AND business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'
        ORDER BY rating_count DESC NULLS LAST
        LIMIT 600`,
      [cityName]
    )
    if (!rows.length) { cache.set(key, { text: '', fetchedAt: Date.now() }); return '' }

    // Bucket + collect counts and candidate highlights.
    const counts = {}
    const byBucket = {}
    for (const v of rows) {
      const b = bucketOf(v.category_slug)
      counts[b] = (counts[b] || 0) + 1
      ;(byBucket[b] = byBucket[b] || []).push(v)
    }

    // For each bucket, pick a few standout names: prefer gem-tagged, well-rated,
    // with a healthy review count (avoids thin-signal picks).
    function highlightsFor(bucket, n) {
      const list = (byBucket[bucket] || [])
        .map(v => {
          const tags = parseTags(v.gem_tags)
          const rating = Number(v.rating) || 0
          const reviews = Number(v.rating_count) || 0
          // score: gem tags matter most, then rating (needs enough reviews), then popularity
          let s = 0
          if (tags.includes('hidden_gem')) s += 40
          if (tags.includes('local_favourite')) s += 30
          if (tags.length) s += Math.min(tags.length * 4, 16)
          if (reviews >= 40) s += (rating - 3.6) * 20
          s += Math.min(reviews / 200, 6)
          return { name: v.name, tags, rating, reviews, s }
        })
        .sort((a, b) => b.s - a.s)
        .slice(0, n)
      return list
    }

    // Order buckets by how well-represented they are.
    const ordered = Object.keys(counts).filter(b => b !== 'other').sort((a, b) => counts[b] - counts[a])

    const lines = []
    lines.push(`WHAT ${cityName.toUpperCase()} ACTUALLY HAS (use this to talk like a local who knows the city — you may name these real places; do NOT invent venues that aren't plausibly here):`)

    // Coverage summary line.
    const coverage = ordered.map(b => `${BUCKET_LABEL[b]} (${counts[b]})`).join(', ')
    if (coverage) lines.push(`Coverage: ${coverage}.`)

    // Per-category highlights (the "richer" grounding).
    for (const b of ordered.slice(0, 7)) {
      const hi = highlightsFor(b, 5)
      if (!hi.length) continue
      const names = hi.map(h => {
        const gem = h.tags.includes('hidden_gem') ? ' (hidden gem)' : (h.tags.includes('local_favourite') ? ' (local favourite)' : '')
        return `${h.name}${gem}`
      }).join(', ')
      lines.push(`- ${BUCKET_LABEL[b]}: ${names}`)
    }

    // A dedicated hidden-gems line across the whole city (these delight users).
    const gems = rows
      .filter(v => parseTags(v.gem_tags).includes('hidden_gem'))
      .slice(0, 8).map(v => v.name)
    if (gems.length) lines.push(`Notable hidden gems: ${gems.join(', ')}.`)

    lines.push(`If the user wants something this city is light on, say so honestly and offer the closest good alternative. Never claim a place exists if you're unsure — keep names to the ones above or clearly say "something like".`)

    const text = '\n\n' + lines.join('\n')
    cache.set(key, { text, fetchedAt: Date.now() })
    return text
  } catch (e) {
    logger.error('[cityKnowledge] failed for ' + cityName + ': ' + e.message)
    return ''   // fail open — AI just behaves as before
  }
}

function clearCache() { cache.clear() }

module.exports = { getCityKnowledge, clearCache, bucketOf }
