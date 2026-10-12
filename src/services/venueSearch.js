const foodEvidence = require('../../data/venue-food-evidence.json')
const normalise = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const aliases = { burgers:'burger', pizzas:'pizza', coffees:'coffee', cafes:'cafe', restaurants:'restaurant', pubs:'pub', bars:'bar' }
function searchWords(value) { return [...new Set(normalise(value).split(/\s+/).filter(Boolean).map(word=>aliases[word]||word))].slice(0,12) }
function withFoodEvidence(venue) {
  const entries=foodEvidence.filter(entry=>String(entry.id)===String(venue.id)&&normalise(entry.name)===normalise(venue.name))
  return {...venue,food_keywords:[...new Set(entries.flatMap(entry=>entry.keywords))],food_sources:entries.map(({label,source,checked_at,keywords})=>({label,url:source,checked_at,keywords}))}
}
function venueSearchClause(value, params) {
  const words=searchWords(value)
  if(!words.length)return 'FALSE'
  // Every word must match actual searchable data or a checked food feature.
  // Parameters keep user text out of SQL, and tokenisation removes LIKE wildcards.
  return words.map(word=>{
    params.push(`%${word}%`)
    const textIndex=params.length
    const relevant=foodEvidence.filter(entry=>entry.keywords.includes(word))
    const evidence=relevant.map(entry=>{
      params.push(entry.id);const idIndex=params.length
      params.push(entry.name.toLowerCase());const nameIndex=params.length
      return `(id=$${idIndex} AND LOWER(name)=$${nameIndex})`
    })
    return `(CONCAT_WS(' ',name,address,category_slug,cuisine_type,menu_summary,dietary_options) ILIKE $${textIndex}${evidence.length?' OR '+evidence.join(' OR '):''})`
  }).join(' AND ')
}
module.exports={searchWords,withFoodEvidence,venueSearchClause}
