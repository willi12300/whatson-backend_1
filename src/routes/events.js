const express = require('express')
const { query } = require('../db/pool')
const router = express.Router()

function typeWhere(type, idx) {
  const hay = `LOWER(COALESCE(e.category,'') || ' ' || COALESCE(e.genre,'') || ' ' || COALESCE(e.name,'') || ' ' || COALESCE(e.description,''))`
  const patterns = {
    music: ['music','concert','live','band','gig','festival','jazz','rock','pop','soul','indie','acoustic'],
    comedy: ['comedy','comedian','stand up','stand-up'],
    theatre: ['theatre','musical','play','drama','opera','ballet'],
    club: ['club','rave','dj','nightlife','dance','house','techno','dnb','drum and bass'],
    food: ['food','drink','brunch','bottomless','beer','wine','cocktail','market'],
    family: ['family','kids','children','child'],
  }
  const list = patterns[String(type || '').toLowerCase()]
  if (!list) return null
  return `(${list.map((_, i) => `${hay} LIKE $${idx + i}`).join(' OR ')})`
}

router.get('/', async (req, res, next) => {
  try {
    const { city, category, type, q, from, to, free, limit = 100 } = req.query
    const params = [], where = [`e.status='active'`]
    if (city) { params.push(city); where.push(`v.city=$${params.length}`) }
    if (category) { params.push(category); where.push(`LOWER(e.category)=LOWER($${params.length})`) }
    if (type && type !== 'all' && type !== 'free') {
      const patterns = {
        music: ['music','concert','live','band','gig','festival','jazz','rock','pop','soul','indie','acoustic'],
        comedy: ['comedy','comedian','stand up','stand-up'],
        theatre: ['theatre','musical','play','drama','opera','ballet'],
        club: ['club','rave','dj','nightlife','dance','house','techno','dnb','drum and bass'],
        food: ['food','drink','brunch','bottomless','beer','wine','cocktail','market'],
        family: ['family','kids','children','child'],
      }[String(type).toLowerCase()]
      if (patterns?.length) {
        const start = params.length + 1
        patterns.forEach(x => params.push(`%${x}%`))
        const hay = `LOWER(COALESCE(e.category,'') || ' ' || COALESCE(e.genre,'') || ' ' || COALESCE(e.name,'') || ' ' || COALESCE(e.description,''))`
        where.push(`(${patterns.map((_, i) => `${hay} LIKE $${start + i}`).join(' OR ')})`)
      }
    }
    if (free === 'true' || type === 'free') where.push(`(e.is_free=true OR COALESCE(e.min_price, 999999)=0 OR LOWER(e.name) LIKE '%free%')`)
    if (q) { params.push(`%${String(q).toLowerCase()}%`); where.push(`LOWER(e.name || ' ' || COALESCE(e.description,'') || ' ' || COALESCE(e.category,'') || ' ' || COALESCE(e.genre,'')) LIKE $${params.length}`) }
    if (from) { params.push(from); where.push(`e.starts_at>=$${params.length}`) } else where.push(`e.starts_at>=now()`)
    if (to) { params.push(to); where.push(`e.starts_at<=$${params.length}`) }
    params.push(Math.min(parseInt(limit) || 100, 500))
    const { rows } = await query(`SELECT e.id,e.name,e.description,e.image_url,e.category,e.genre,e.starts_at,e.ends_at,e.is_free,e.min_price,e.ticket_url,v.id AS venue_id,v.name AS venue_name,v.lat,v.lng,v.address AS venue_address,v.cover_photo AS venue_photo FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE ${where.join(' AND ')} ORDER BY e.starts_at ASC LIMIT $${params.length}`, params)
    res.json({ count: rows.length, events: rows })
  } catch (err) { next(err) }
})

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT e.*,v.name AS venue_name,v.lat,v.lng,v.address AS venue_address,v.cover_photo AS venue_photo FROM events e LEFT JOIN venues v ON v.id=e.venue_id WHERE e.id=$1`, [req.params.id])
    if (!rows.length) return res.status(404).json({ error: 'Event not found' })
    const sources = await query(`SELECT provider,provider_id FROM event_sources WHERE event_id=$1`, [req.params.id])
    res.json({ ...rows[0], sources: sources.rows })
  } catch (err) { next(err) }
})

module.exports = router
