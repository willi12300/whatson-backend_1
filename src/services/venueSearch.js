const foodEvidence = require('../../data/venue-food-evidence.json')
const websiteIndex = require('../../data/venue-search-index.json')
const FOOD_WORDS = new Set('burger pizza curry taco sandwich steak pasta noodle ramen sushi dumpling kebab falafel chicken seafood fish pie brunch breakfast pancake waffle vegan vegetarian gluten coffee cake pastry tapas burrito wrap salad soup roast bbq barbecue wings fries chips dessert icecream gelato beer wine cocktail cider ale'.split(' '))
const normalise = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
const aliases = { burgers:'burger', pizzas:'pizza', coffees:'coffee', cafes:'cafe', restaurants:'restaurant', pubs:'pub', bars:'bar',curries:'curry',sandwiches:'sandwich',pastries:'pastry',fish:'fish',chips:'chips',fries:'fries',tapas:'tapas',hummus:'hummus',bbq:'barbecue' }
function canonicalWord(word) {return aliases[word]||((word.endsWith('s')&&!word.endsWith('ss')&&word.length>3)?word.slice(0,-1):word)}
// Directory pages contain neighbouring venue lists: their page-wide words are
// not evidence about this venue (e.g. CAMRA White Star mentions McCooley's).
function searchableWebsiteDocument(document) {
 try {const u=new URL(document.url);return ['http:','https:'].includes(u.protocol)&&!['camra.org.uk','tripadvisor.com','tripadvisor.co.uk','google.com'].some(host=>u.hostname===host||u.hostname.endsWith('.'+host))}catch{return false}
}
const indexedVenues = new Map(websiteIndex.venues.filter(venue=>venue.documents?.some(searchableWebsiteDocument)).map(venue=>[String(venue.id),{...venue,documents:venue.documents.filter(searchableWebsiteDocument).map(document=>{const words=new Set(document.terms.map(canonicalWord));return {...document,words,foodKeywords:[...words].filter(word=>FOOD_WORDS.has(word))}})}]))
function searchWords(value) { return [...new Set(normalise(value).split(/\s+/).filter(Boolean).map(canonicalWord))].slice(0,12) }
function matchingDocuments(venue,word) {
  const entry=indexedVenues.get(String(venue.id))
  if(!entry||normalise(entry.name)!==normalise(venue.name))return []
  return entry.documents.filter(document=>document.words.has(word))
}
function foodCapable(venue) {
  return /restaurant|cafe|coffee|pub|bar|diner|food|kitchen|grill|saloon|pizzeria/.test(normalise(venue.category_slug)+' '+normalise(venue.name))
}
function withFoodEvidence(venue,search='') {
  const entries=foodEvidence.filter(entry=>String(entry.id)===String(venue.id)&&normalise(entry.name)===normalise(venue.name))
  const indexed=indexedVenues.get(String(venue.id))
  const documents=indexed&&normalise(indexed.name)===normalise(venue.name)?indexed.documents:[]
  const foodSources=foodCapable(venue)?documents.map(document=>({label:document.kind==='menu'?'Menu information':'Website information',url:document.url,checked_at:websiteIndex.checked_at,kind:document.kind,keywords:document.foodKeywords})).filter(source=>source.keywords.length):[]
  const words=searchWords(search),matching=words.length?documents.filter(document=>words.some(word=>document.words.has(word))):[]
  matching.sort((a,b)=>(b.kind==='menu')-(a.kind==='menu'))
  return {...venue,food_keywords:[...new Set([...entries.flatMap(entry=>entry.keywords),...foodSources.flatMap(source=>source.keywords)])],
    food_sources:[...entries.map(({label,source,checked_at,keywords})=>({label,url:source,checked_at,keywords})),...foodSources],
    ...(matching.length?{search_evidence:{query:normalise(search),url:matching[0].url,title:matching[0].title,kind:matching[0].kind,checked_at:websiteIndex.checked_at}}:{})}
}
function venueSearchClause(value, params) {
  const words=searchWords(value)
  if(!words.length)return 'FALSE'
  // Every word must match actual searchable data or a checked food feature.
  // Parameters keep user text out of SQL, and tokenisation removes LIKE wildcards.
  return words.map(word=>{
    params.push(`%${word}%`)
    const textIndex=params.length
    const curated=foodEvidence.filter(entry=>entry.keywords.includes(word))
    const fromWebsites=[...indexedVenues.values()].filter(venue=>!FOOD_WORDS.has(word)||foodCapable(venue)).filter(venue=>venue.documents.some(document=>document.words.has(word)))
    const relevant=[...curated,...fromWebsites]
    let evidence=''
    if(relevant.length) {
      params.push(relevant.map(entry=>entry.id));const ids=params.length
      params.push(relevant.map(entry=>entry.name.toLowerCase()));const names=params.length
      evidence=` OR (id,LOWER(name)) IN (SELECT * FROM unnest($${ids}::integer[],$${names}::text[]))`
    }
    return `(CONCAT_WS(' ',name,address,category_slug,cuisine_type,menu_summary,dietary_options) ILIKE $${textIndex}${evidence})`
  }).join(' AND ')
}
module.exports={searchableWebsiteDocument,searchWords,withFoodEvidence,venueSearchClause,matchingDocuments}
