#!/usr/bin/env node
const fs=require('node:fs')
const {identityName}=require('../src/services/venueIdentity')
const {assessVenue}=require('../src/services/venueNameAudit')
const fetch=async url=>{const r=await require('axios').get(url,{timeout:60000,validateStatus:()=>true});return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.data}}
const BASE=process.env.SAPPO_API_BASE||'https://whatson-backend1-production.up.railway.app'
function photoPlaceIds(v){const ids=new Set();if(v.google_place_id)ids.add(v.google_place_id);for(const p of [v.cover_photo,...(v.photos||[])]){try{const u=new URL(typeof p==='string'?p:p?.url);const name=u.searchParams.get('name')||decodeURIComponent(u.pathname);const id=name.match(/places\/([^/]+)\/photos\//)?.[1];if(id)ids.add(id)}catch{}}return [...ids]}
function auditNames(rows,extended){
 const providers=new Map()
 for(const v of rows)for(const id of photoPlaceIds(v)){if(!providers.has(id))providers.set(id,[]);providers.get(id).push(v)}
 return rows.map(v=>{
  const source=v.provider_identity,assessment=assessVenue({...v,provider_identities:source?.name?[{provider:'google',...source}]:[]})
  const peers=[...new Set(photoPlaceIds(v).flatMap(id=>(providers.get(id)||[]).filter(other=>other.id!==v.id&&identityName(other.name)!==identityName(v.name)).map(other=>other.id)))]
  const reasons=[]
  if([7091,7253].includes(Number(v.id)))reasons.push('Confirmed mixed business identities; reviewed quarantine')
  if(assessment.status==='identity_conflict')reasons.push('Cached provider name/location conflicts')
  if(peers.length)reasons.push('Different venue names share the same Google identity/photo source; review required')
  if(!/[\p{L}]/u.test(v.name||'')||/^https?:/i.test(v.name||'')||!String(v.name||'').trim())reasons.push('Numeric-only or malformed business name; corroboration required')
  return {id:v.id,name:v.name,city:v.city,lat:v.lat,lng:v.lng,status:[7091,7253].includes(Number(v.id))?'identity_conflict':reasons.length?'needs_review':assessment.status,flagged:reasons.length>0,reason:reasons.join('; ')||assessment.reason,provider_name:source?.name||null,shared_identity_venue_ids:peers,provider_coverage:extended?'cached source snapshot':'not available; live backend lacks source snapshot'}
 })
}
async function catalogue(){let rows=[],after=0,extended=true
 for(;;){const r=await fetch(BASE+'/venue-link-audit/catalogue?limit=2000&after='+after,{signal:AbortSignal.timeout(30000)});if(r.status===404&&after===0){extended=false;break}if(!r.ok)throw Error('Source snapshot failed: '+r.status);const d=await r.json();rows.push(...d.venues);if(!d.has_more)break;after=d.next_after}
 if(!extended){let offset=0;for(;;){const r=await fetch(BASE+'/venues?limit=2000&catalogueOnly=true&offset='+offset,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Catalogue incomplete: '+r.status);const d=await r.json();if(!Array.isArray(d.venues))throw Error('Invalid catalogue response');rows.push(...d.venues);console.log('Read',rows.length);if(!d.has_more)break;if(!(d.next_offset>offset))throw Error('Pagination did not advance');offset=d.next_offset}}
 if(!rows.length||new Set(rows.map(v=>v.id)).size!==rows.length)throw Error('Empty or duplicated catalogue snapshot');return {rows,extended}
}
async function main(){const {rows,extended}=await catalogue(),venues=auditNames(rows,extended),counts={venues:venues.length,provider_agreement:0,identity_conflict:0,needs_review:0,flagged:0};for(const v of venues){counts[v.status]++;if(v.flagged)counts.flagged++}
 const report={checked_at:new Date().toISOString(),coverage:{all_catalogue_names:true,cached_provider_names:extended,independently_verified_all_names:false},counts,limitations:'Automated screening is not independent certification of every name. Uncorroborated records require review; no automatic renames.',venues}
 fs.mkdirSync('reports',{recursive:true});fs.writeFileSync('reports/venue-names-summary.json',JSON.stringify({...report,venues:undefined},null,2)+'\n');fs.writeFileSync('reports/venue-names.json',JSON.stringify(report,null,2)+'\n');const fields=['id','name','city','status','flagged','reason','provider_name','shared_identity_venue_ids'];const quote=s=>'"'+String(Array.isArray(s)?s.join('|'):s??'').replace(/"/g,'""')+'"';fs.writeFileSync('reports/venue-names.csv',fields.join(',')+'\n'+venues.map(v=>fields.map(k=>quote(v[k])).join(',')).join('\n')+'\n');console.log(JSON.stringify({counts,coverage:report.coverage}))}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1})
module.exports={auditNames,photoPlaceIds}
