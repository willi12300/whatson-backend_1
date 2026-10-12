#!/usr/bin/env node
// Free published excerpts only. Rebuild separately from canonical venue profiles.
const fs=require('fs'),axios=require('axios')
const {extractVenueDescription,text,excerpt}=require('../src/services/profileDescriptions')
const {normalise,samePlace,distance,usable}=require('../src/services/descriptionSources')
const API=process.env.SAPPO_PUBLIC_API||'https://whatson-backend1-production.up.railway.app'
const out='data/venue-descriptions.json',checked=new Date().toISOString()
async function fetch(url){try{const r=await axios.get(url,{timeout:7000,maxRedirects:0,maxContentLength:2*1024*1024});return String(r.data)}catch{return null}}
async function pool(items,fn){let i=0;await Promise.all(Array.from({length:6},async()=>{while(i<items.length)await fn(items[i++])}))}
function structured(html){const values=[];function walk(v){if(Array.isArray(v))return v.forEach(walk);if(!v||typeof v!=='object')return;values.push(v);if(v['@graph'])walk(v['@graph'])}for(const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{walk(JSON.parse(m[1]))}catch{}}return values}
function record(v,paragraphs,url,label){return {id:v.id,name:v.name,website:v.website||null,address:v.address||null,lat:v.lat,lng:v.lng,paragraphs,source_url:url,source_label:label,checked_at:checked}}
async function main(){
 const catalogueArg=process.argv.indexOf('--catalogue')
 const catalogue=catalogueArg>=0?JSON.parse(fs.readFileSync(process.argv[catalogueArg+1])):(await axios.get(API+'/venues?city=Liverpool&limit=2000',{timeout:30000})).data
 const venues=Array.isArray(catalogue)?catalogue:catalogue.venues
 if(!Array.isArray(venues))throw Error('No catalogue')
 const records=new Map(),old=fs.existsSync(out)?JSON.parse(fs.readFileSync(out)).venues:[]
 for(const r of old){const v=venues.find(v=>String(v.id)===String(r.id));if(v&&samePlace(r,v)&&usable(r.paragraphs)&&r.source_label!=='Creative Tourist'&&Date.now()-Date.parse(r.checked_at)<30*86400000)records.set(v.id,r)}
 const names=new Map();for(const v of venues){const key=normalise(v.name);names.set(key,[...(names.get(key)||[]),v])}
 const links=[]
 await pool(['','2','3','4'],async suffix=>{const xml=await fetch('https://www.creativetourist.com/venue-sitemap'+suffix+'.xml');for(const m of (xml||'').matchAll(/<loc>(.*?)<\/loc>/g)){const url=m[1],slug=url.split('/').filter(Boolean).at(-1).replace(/-/g,' ');if(names.has(normalise(slug)))links.push({url,candidates:names.get(normalise(slug))})}})
 let guides=0,websites=0,done=0
 await pool(links,async({url,candidates})=>{
  const html=await fetch(url);if(!html)return
  const objects=structured(html)
  const published=objects.find(p=>p.dateModified||p.datePublished)
  const modified=published?.dateModified||published?.datePublished
  const place=objects.find(p=>p.geo&&p.description&&p.name)
  if(!place)return
  const matched=candidates.filter(v=>normalise(place.name)===normalise(v.name)&&distance(v.lat,v.lng,place.geo.latitude,place.geo.longitude)<500).sort((a,b)=>distance(a.lat,a.lng,place.geo.latitude,place.geo.longitude)-distance(b.lat,b.lng,place.geo.latitude,place.geo.longitude))
  // Ambiguous or co-located branches are left for their own website.
  if(!matched.length||matched.length>1&&distance(matched[1].lat,matched[1].lng,place.geo.latitude,place.geo.longitude)<100)return
  const v=matched[0]
  const landmark=/park|museum|gallery|historic|culture|outdoor|garden|cathedral|library/.test(String(v.category_slug))
  if(!landmark&&(!modified||Date.now()-Date.parse(modified)>365*86400000))return
  const article=(html.split('<div id="booking"></div>')[1]||'').split(/<h[23]\b/)[0]
  const body=[...article.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m=>text(m[1])).find(p=>p.length>100&&!/\d{1,2}:\d{2}|now open|permanently closed|has closed|cookies?|subscribe|newsletter/i.test(p))
  const paragraphs=body?[excerpt(body)]:extractVenueDescription(html,place.name)
  if(usable(paragraphs)){records.set(v.id,{...record(v,paragraphs,url,'Creative Tourist'),published_at:modified});guides++}
 })
 console.log('Matched local guides:',guides)
 const indexed=require('../data/venue-search-index.json').venues.filter(v=>v.status!=='unreadable_or_unavailable')
 await pool(indexed,async item=>{
  const v=venues.find(v=>String(v.id)===String(item.id));if(!v||v.website!==item.website||records.has(v.id))return
  const html=await fetch(v.website)
  if(html){
   let source=v.website,paragraphs=extractVenueDescription(html,v.name,true)
   if((paragraphs[0]?.length||0)<280){
    const href=[...html.matchAll(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1/gi)].map(m=>m[2]).find(h=>/\/(?:about(?:-us)?|our-story)\/?(?:\?|$)/i.test(h))
    if(href){const about=new URL(href,v.website);if(about.hostname===new URL(v.website).hostname){const page=await fetch(about.href);if(page){const richer=extractVenueDescription(page,v.name,true);if((richer[0]?.length||0)>(paragraphs[0]?.length||0)){paragraphs=richer;source=about.href}}}}
   }
   if(usable(paragraphs)){records.set(v.id,record(v,paragraphs,source,'Venue website'));websites++}
  }
  if(++done%100===0)console.log('Website checks:',done,'descriptions:',websites)
 })
 // Individually checked landmarks whose catalogue names differ from source titles.
 const seeds=[
  {id:121,name:'The Otterspool Promenade',paragraphs:['Follow the Mersey along this broad riverside promenade in south Liverpool, with views across the water towards the Wirral. It links with Otterspool Park’s woodland paths and the nearby Festival Gardens, giving you room for a walk, a cycle or a longer stretch beside the river.'],source_url:'https://www.creativetourist.com/venue/otterspool-promenade/',source_label:'Creative Tourist'},
  {id:6250,name:'Sefton Park Obelisk',paragraphs:['This tall granite obelisk is a memorial to Samuel Smith MP, completed in 1909 by sculptor C. J. Allen. The Grade II-listed monument has sculpted relief panels, a bronze inscription and drinking fountains built into its base. It stands near Sefton Park’s principal entrance, opposite Lodge Lane.'],source_url:'https://historicengland.org.uk/listing/the-list/list-entry/1062528',source_label:'Historic England'},
 ]
 for(const seed of seeds){const v=venues.find(v=>v.id===seed.id&&v.name===seed.name);if(v)records.set(v.id,{...record(v,seed.paragraphs,seed.source_url,seed.source_label),checked_at:'2026-10-12T00:00:00Z',editorial:true})}
 const result={checked_at:checked,method:'Published venue websites and geographically matched local guides; no AI or paid requests',venues:[...records.values()].filter(r=>usable(r.paragraphs)).sort((a,b)=>a.id-b.id)}
 fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log('Saved descriptions:',result.venues.length,'official websites:',websites)
}
main().catch(error=>{console.error(error.message);process.exitCode=1})
