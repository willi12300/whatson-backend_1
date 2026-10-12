const axios=require('axios'),crypto=require('crypto')
const {query}=require('../db/pool')
const index=require('../../data/venue-search-index.json')
const hosts=new Set(index.venues.map(v=>{try{return new URL(v.website).hostname.replace(/^www\./,'')}catch{return ''}}).filter(Boolean))
const inFlight=new Map()

function text(value) {
  return typeof value==='string'?value.replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<style\b[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim():''
}
function excerpt(value) {
  const clean=text(value)
  const words=clean.split(/\s+/)
  return words.length>100?words.slice(0,100).join(' ')+'…':clean
}
function publicVenueUrl(value) {
  try{
    const u=new URL(value)
    return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password&&!u.port&&hosts.has(u.hostname.replace(/^www\./,''))?u.href:null
  }catch{return null}
}
function identity(venue) {return crypto.createHash('sha256').update(JSON.stringify([2,venue.id,venue.name,venue.website])).digest('hex')}
function extractVenueDescription(html,name,about=false) {
  const candidates=[]
  const normal=value=>text(value).toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
  const expected=normal(name)
  const title=normal(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'')
  if(about && title.includes(expected)) {
    const main=html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]||html
    const paragraphs=[...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(match=>text(match[1])).filter(value=>value.length>120&&!/cookies?|privacy|newsletter|subscribe|copyright|gift cards?|terms and conditions/i.test(value))
    if(paragraphs.length)candidates.push(excerpt(paragraphs.slice(0,2).join(' ')))
  }
  function visit(value) {
    if(Array.isArray(value)){value.forEach(visit);return}
    if(!value||typeof value!=='object')return
    const type=String(value['@type']||'')
    const actual=normal(value.name),expected=normal(name)
    if(/Restaurant|Cafe|BarOrPub|LocalBusiness|Museum|Park|PerformingArtsTheater|TouristAttraction|Organization/.test(type)&&actual&&(expected.includes(actual)||actual.includes(expected))&&value.description)candidates.push(excerpt(value.description))
    if(value['@graph'])visit(value['@graph'])
  }
  for(const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{visit(JSON.parse(match[1]))}catch{}}
  for(const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs={};for(const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g))attrs[attr[1].toLowerCase()]=attr[3]
    if(['description','og:description'].includes((attrs.name||attrs.property||'').toLowerCase())&&(title.includes(expected)||normal(attrs.content).includes(expected)))candidates.push(excerpt(attrs.content))
  }
  return [...new Set(candidates)].filter(value=>value.length>=80&&!/cookie policy|accept cookies|access denied|captcha|just a moment|enable javascript/i.test(value)).sort((a,b)=>b.length-a.length).slice(0,1)
}

async function venueDescription(id) {
  const {rows}=await query('SELECT id,name,website FROM venues WHERE id=$1',[id])
  const venue=rows[0];if(!venue)return null
  const key=identity(venue),url=publicVenueUrl(venue.website)
  if(!url)return {status:'unavailable',paragraphs:[]}
  const cache=await query('SELECT source_url,paragraphs,checked_at FROM venue_description_sources WHERE venue_id=$1 AND identity_key=$2 AND expires_at>now()',[venue.id,key])
  if(cache.rows.length)return {status:cache.rows[0].paragraphs.length?'ready':'unavailable',...cache.rows[0]}
  if(inFlight.has(key))return inFlight.get(key)
  const work=(async()=>{
    let paragraphs=[],source=url
    try{
      let response
      for(let redirects=0;redirects<4;redirects++){
        response=await axios.get(source,{timeout:6000,maxRedirects:0,maxContentLength:2*1024*1024,validateStatus:status=>status<400})
        if(response.status<300)break
        const next=publicVenueUrl(new URL(response.headers.location,source).href)
        if(!next||new URL(next).hostname.replace(/^www\./,'')!==new URL(url).hostname.replace(/^www\./,''))throw new Error('Unrelated source redirect')
        source=next
      }
      if(response.status<300) {
        const html=String(response.data);paragraphs=extractVenueDescription(html,venue.name)
        if((paragraphs[0]?.length||0)<280) {
          const link=[...html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi)].map(match=>match[2]).find(href=>/\/(?:about(?:-us)?|our-story)\/?(?:\?|$)/i.test(href))
          const about=link&&publicVenueUrl(new URL(link,source).href)
          if(about&&new URL(about).hostname.replace(/^www\./,'')===new URL(source).hostname.replace(/^www\./,'')) {
            const page=await axios.get(about,{timeout:6000,maxRedirects:0,maxContentLength:2*1024*1024})
            const richer=extractVenueDescription(String(page.data),venue.name,true)
            if((richer[0]?.length||0)>(paragraphs[0]?.length||0)){paragraphs=richer;source=about}
          }
        }
      }
    }catch{}
    const checked=new Date().toISOString(),hash=crypto.createHash('sha256').update(paragraphs.join('\n')).digest('hex')
    // One row per venue: a changed identity replaces the old excerpt, not its profile.
    await query(`INSERT INTO venue_description_sources(venue_id,identity_key,source_url,paragraphs,content_hash,checked_at,expires_at) VALUES($1,$2,$3,$4,$5,now(),now()+interval '24 hours') ON CONFLICT(venue_id) DO UPDATE SET identity_key=EXCLUDED.identity_key,source_url=EXCLUDED.source_url,paragraphs=EXCLUDED.paragraphs,content_hash=EXCLUDED.content_hash,checked_at=EXCLUDED.checked_at,expires_at=EXCLUDED.expires_at`,[venue.id,key,source,JSON.stringify(paragraphs),hash])
    return {status:paragraphs.length?'ready':'unavailable',paragraphs,source_url:source,checked_at:checked}
  })().finally(()=>inFlight.delete(key))
  inFlight.set(key,work);return work
}

async function eventDescription(id) {
  const {rows}=await query(`SELECT e.description,e.ticket_url,es.provider,es.raw,e.updated_at FROM events e LEFT JOIN event_sources es ON es.event_id=e.id WHERE e.id=$1`,[id])
  if(!rows.length)return null
  const row=rows[0],raw=row.raw||{}
  const paragraphs=[...new Set([raw.info,raw.description,row.description].map(excerpt).filter(Boolean))]
  const lineup=(raw.artists||raw._embedded?.attractions||[]).map(artist=>text(artist.name||artist.artistname)).filter(Boolean)
  return {status:'ready',paragraphs:paragraphs.slice(0,2),notes:excerpt(raw.pleaseNote)||null,lineup:[...new Set(lineup)].slice(0,20),source_url:row.ticket_url,checked_at:row.updated_at,provider:row.provider}
}
module.exports={venueDescription,eventDescription,extractVenueDescription,identity,excerpt}
