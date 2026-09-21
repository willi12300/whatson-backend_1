const { query } = require('../db/pool')
const { distanceMeters } = require('../utils/helpers')
const { evaluateOpeningHours, isTimeAppropriate } = require('./openingHours')

function json(value, fallback=[]) { if (Array.isArray(value)) return value; try { return JSON.parse(value || '[]') } catch { return fallback } }
function scoreCandidate(v, role, context) {
  let score = (Number(v.rating)||0) * 10 + Math.min(Number(v.rating_count)||0, 500) / 100
  if (context.budget?.budget_level === 'cheap' && Number(v.price_level) <= 2) score += 8
  if (context.lat != null && v.lat != null) score += Math.max(0, 12 - distanceMeters(context.lat,context.lng,v.lat,v.lng)/1000)
  return score
}
async function candidatesForRole(role, context, { excludeIds = [], arrivalAt = new Date() } = {}) {
  const cats = json(role.venue_categories)
  const params = [context.city, cats, role.minimum_rating || 0]
  let sql = `SELECT id,name,category_slug,rating,rating_count,price_level,address,lat,lng,opening_hours,cover_photo,photos FROM venues WHERE city=$1 AND category_slug=ANY($2::text[]) AND COALESCE(rating,0)>=$3 AND business_status IS DISTINCT FROM 'CLOSED_PERMANENTLY'`
  if (excludeIds.length) { params.push(excludeIds); sql += ` AND id <> ALL($${params.length}::bigint[])` }
  const { rows } = await query(sql + ' LIMIT 100', params)
  return rows.map(v => ({ ...v, availability:evaluateOpeningHours(v.opening_hours, arrivalAt,{city:context.city,durationMinutes:role.duration_minutes||60}), _score:scoreCandidate(v,role,context) }))
   .filter(v => v.availability.eligible && isTimeAppropriate(v,arrivalAt,{city:context.city}))
   .sort((a,b)=>b._score-a._score)
}
module.exports = { candidatesForRole, scoreCandidate }
