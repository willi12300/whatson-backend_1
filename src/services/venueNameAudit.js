// Check cached provider identities before any cached enrichment is served.
// A conflicting provider must never rename the catalogue venue automatically.
const {providerIdentity}=require('./providerIdentity')
const {normal}=require('./providerIdentity')
const reviewed=new Map(require('../../data/venue-link-audit.json').venues.filter(v=>v.quarantine_identity).map(v=>[String(v.id),v]))
let records=new Map(),checkedAt=null
function assessVenue(v){
 const known=reviewed.get(String(v.id))
 if(known&&normal(known.name)===normal(v.name))return {id:v.id,name:v.name,status:'identity_conflict',reason:known.reason,checks:[]}
 const sources=Array.isArray(v.provider_identities)?v.provider_identities:[]
 const checks=sources.map(s=>({provider:s.provider,name:s.name,...providerIdentity(v,s)}))
 const conflicts=checks.filter(s=>['different_name','different_location'].includes(s.reason))
 return {id:v.id,name:v.name,status:conflicts.length?'identity_conflict':checks.length&&checks.every(s=>s.matched)?'provider_agreement':'needs_review',reason:conflicts.length?'Cached provider name or location conflicts with catalogue venue':checks.length?'Provider comparison completed; ownership is not independently certified':'No cached provider identity available',checks}
}
async function refreshVenueNameAudit(query){
 const {rows}=await query(`SELECT v.id,v.name,v.lat,v.lng,COALESCE(jsonb_agg(jsonb_build_object(
 'provider',s.provider,'name',COALESCE(s.raw->'displayName'->>'text',CASE WHEN s.raw->>'name' NOT LIKE 'places/%' THEN s.raw->>'name' END),
 'lat',COALESCE(s.raw->'location'->'latitude',s.raw->'geometry'->'location'->'lat'),
 'lng',COALESCE(s.raw->'location'->'longitude',s.raw->'geometry'->'location'->'lng')))
 FILTER(WHERE s.provider='google'),'[]'::jsonb) AS provider_identities
 FROM venues v LEFT JOIN venue_sources s ON s.venue_id=v.id GROUP BY v.id ORDER BY v.id`)
 records=new Map(rows.map(v=>[String(v.id),assessVenue(v)]));checkedAt=new Date().toISOString()
 return nameAuditReport()
}
function identityAuditRecord(v){const r=records.get(String(v.id));return r&&normal(r.name)===normal(v.name)?r:null}
function nameAuditReport(){const counts={venues:records.size,provider_agreement:0,identity_conflict:0,needs_review:0};for(const r of records.values())counts[r.status]++;return {checked_at:checkedAt,counts,method:'All catalogue records compared with every cached Google name/location. Provider agreement is not independent ownership verification.',venues:[...records.values()]}}
module.exports={assessVenue,refreshVenueNameAudit,identityAuditRecord,nameAuditReport}
