const audit=require('../../data/venue-link-audit.json')
const {normal}=require('./providerIdentity')
const records=new Map(audit.venues.map(v=>[String(v.id),v]))
const fields=['website','website_url','websiteUrl','url','menu_url','menuUrl','booking_url','bookingUrl','reservation_url','reservations_url','instagram','instagram_url','facebook','facebook_url']
function urlKey(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;u.hash='';return u.href.replace(/\/$/,'')}catch{return null}}
const canonicalField=field=>({website_url:'website',websiteUrl:'website',url:'website',menuUrl:'menu_url',bookingUrl:'booking_url',reservation_url:'booking_url',reservations_url:'booking_url',instagram_url:'instagram',facebook_url:'facebook'}[field]||field)
const enforced=field=>audit.enforce_verified&&(!audit.enforce_verified_fields||audit.enforce_verified_fields.includes(canonicalField(field)))
function normaliseFieldURL(field,value){if(typeof value!=='string')return value;const raw=value.trim(),kind=canonicalField(field);if(['instagram','facebook'].includes(kind)&&/^@?[a-z0-9._]+$/i.test(raw)&&!raw.includes(kind+'.com'))return 'https://www.'+kind+'.com/'+raw.replace(/^@/,'');return /^[a-z][a-z0-9+.-]*:/i.test(raw)?raw:'https://'+raw}
function applyVenueLinkPolicy(venue){
 const record=records.get(String(venue.id)),matches=record&&normal(record.name)===normal(venue.name)
 const identityReview=require('./venueNameAudit').identityAuditRecord(venue)
 const quarantine=(matches&&record.quarantine_identity)||identityReview?.status==='identity_conflict'
 const quarantineReason=identityReview?.status==='identity_conflict'?identityReview.reason:record?.reason
 const checked=matches?record.links||[]:[]
 const out={...venue},statuses={}
 for(const field of fields){
  if(!out[field])continue
  out[field]=normaliseFieldURL(field,out[field])
  const key=urlKey(out[field]),review=checked.find(l=>urlKey(l.url)===key&&l.fields?.includes(canonicalField(field)))
  const allowed=!quarantine&&key&&(!enforced(field)||review?.status==='verified')
  if(!allowed)out[field]=null
  statuses[field]={status:allowed?(review?.status||'not_audited'):quarantine?'identity_mismatch':review?.status||'needs_review',reason:quarantine?quarantineReason:review?.reason||'Venue ownership not confirmed'}
 }
 if(quarantine){
  for(const field of Object.keys(out))if(/^(google|tripadvisor)/i.test(field))out[field]=null
  for(const field of ['image_url','photo_url','image','photo','coverPhoto','openingHours','openNow','topReview','description_source'])out[field]=null
  out.hero_images=[];out.images=[];out.gem_tags=[];out.gem_cautions=[]
  for(const field of ['google_place_id','google_maps_url','maps_url','phone','opening_hours','price_level','rating','rating_count','google_rating','google_reviews','google_review_count','tripadvisor_rating','tripadvisor_review_count','description','profile_description','long_description','summary','menu_summary','google_review_sample','top_review','tripadvisor_top_review','offer'])out[field]=null
  for(const field of ['photos','heroImages','googleReviewSample','menu_items','food_sources','food_keywords','sources'])out[field]=[]
  out.cover_photo=null;out.business_status=null;out.open_now=null;out.tags=[];out.vibe_tags=[];out.why_chosen=[];out.whyChosen=[];out.sappo_score=null;out.dog_access={status:'unknown'};out.link_identity_status='quarantined'
 }
 // These alternate provider fields can otherwise recreate hidden links downstream.
 if(enforced('menu_url')||quarantine){out.menus=[];out.menu_links=[];out.menu={}}
 if(enforced('instagram')||enforced('facebook')||quarantine){out.socials={};out.social_links={}}
 if(quarantine)out.googleMapsUrl=null
 out.name_verification=identityReview||{status:'not_audited'}
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
