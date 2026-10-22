const audit=require('../../data/venue-link-audit.json')
const {normal}=require('./providerIdentity')
const records=new Map(audit.venues.map(v=>[String(v.id),v]))
const fields=['website','website_url','websiteUrl','url','menu_url','menuUrl','booking_url','bookingUrl','reservation_url','reservations_url','instagram','instagram_url','facebook','facebook_url']
function urlKey(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;u.hash='';return u.href.replace(/\/$/,'')}catch{return null}}
function applyVenueLinkPolicy(venue){
 const record=records.get(String(venue.id)),matches=record&&normal(record.name)===normal(venue.name)
 const quarantine=matches&&record.quarantine_identity
 const checked=matches?record.links||[]:[]
 const out={...venue},statuses={}
 for(const field of fields){
  if(!out[field])continue
  const key=urlKey(out[field]),review=checked.find(l=>urlKey(l.url)===key&&l.fields?.includes(field))
  const allowed=!quarantine&&key&&(!audit.enforce_verified||review?.status==='verified')
  if(!allowed)out[field]=null
  statuses[field]={status:allowed?(review?.status||'not_audited'):quarantine?'identity_mismatch':review?.status||'needs_review',reason:quarantine?record.reason:review?.reason||'Venue ownership not confirmed'}
 }
 if(quarantine){
  for(const field of ['google_place_id','google_maps_url','maps_url','phone','opening_hours','price_level','rating','rating_count','google_rating','google_reviews','google_review_count','tripadvisor_rating','tripadvisor_review_count','description','profile_description','long_description','summary','menu_summary','google_review_sample','top_review','tripadvisor_top_review','offer'])out[field]=null
  for(const field of ['photos','heroImages','googleReviewSample','menu_items','food_sources','food_keywords','sources'])out[field]=[]
  out.cover_photo=null;out.business_status=null;out.open_now=null;out.tags=[];out.vibe_tags=[];out.why_chosen=[];out.whyChosen=[];out.sappo_score=null;out.dog_access={status:'unknown'};out.link_identity_status='quarantined'
 }
 // These alternate provider fields can otherwise recreate hidden links downstream.
 if(audit.enforce_verified||quarantine){out.socials={};out.social_links={};out.menus=[];out.menu_links=[];out.menu={};out.googleMapsUrl=out.google_maps_url}
 out.link_verification={checked_at:audit.checked_at,status:quarantine?'identity_mismatch':matches?'audited':'not_audited',fields:statuses}
 return out
}
function sanitiseVenueLinks(value){
 if(Array.isArray(value))return value.map(sanitiseVenueLinks)
 if(!value||typeof value!=='object'||value instanceof Date||Buffer.isBuffer(value))return value
 let result=Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitiseVenueLinks(v)]))
 if(result.id!=null&&typeof result.name==='string'&&('category_slug'in result)&&!result.eventId&&result.itemType!=='event'&&result.category_slug!=='event')result=applyVenueLinkPolicy(result)
 return result
}
module.exports={applyVenueLinkPolicy,sanitiseVenueLinks,urlKey}
