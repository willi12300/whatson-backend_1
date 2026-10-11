// Conservative identity matching: a nearby branch, cafe inside a museum, or
// similarly named pub must not be merged merely because it shares a website.
const { distanceMeters } = require('../utils/helpers')
function identityName(s='') { return String(s).normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’']/g,'').replace(/&/g,' and ').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/^the /,'') }
function categoryGroup(c='other') { if(['pub','bar','nightclub'].includes(c))return 'drinks';if(['park','garden'].includes(c))return 'park';return c }
function streetNumber(s='') {return String(s||'').match(/^\s*(\d+[a-z]?(?:\s*-\s*\d+[a-z]?)?)\b/i)?.[1]?.replace(/\s/g,'').toLowerCase()||null}
function sameVenue(a,b) {
 const name=identityName(a.name), other=identityName(b.name)
 if(!name||name!==other)return false
 if([a.lat,a.lng,b.lat,b.lng].some(x=>x==null||x===''||!Number.isFinite(Number(x))))return false
 if(distanceMeters(+a.lat,+a.lng,+b.lat,+b.lng)>35)return false
 const ca=categoryGroup(a.category_slug||a.category),cb=categoryGroup(b.category_slug||b.category)
 if(ca!=='other'&&cb!=='other'&&ca!==cb)return false
 const an=streetNumber(a.address),bn=streetNumber(b.address)
 if(an&&bn&&an!==bn)return false
 return true
}
async function canonicalVenueId(id,query) {
 if(!/^\d+$/.test(String(id||'')))return id
 const {rows}=await query('SELECT canonical_id FROM venue_aliases WHERE duplicate_id=$1',[Number(id)])
 return rows[0]?.canonical_id||id
}
async function findDuplicateVenue(v,query) {
 if(v.lat==null||v.lng==null)return null
 const lat=Number(v.lat),lng=Number(v.lng)
 if(!Number.isFinite(lat)||!Number.isFinite(lng))return null
 // Include neighbouring import areas instead of filtering by city label.
 const {rows}=await query(`SELECT v.*,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.original_name,'lat',a.original_lat,'lng',a.original_lng,'address',a.original_address,'category_slug',a.original_category)) FROM venue_aliases a WHERE a.canonical_id=v.id),'[]'::jsonb) AS identity_aliases
 FROM venues v WHERE (v.lat BETWEEN $1-0.0004 AND $1+0.0004 AND v.lng BETWEEN $2-0.001 AND $2+0.001)
 OR EXISTS(SELECT 1 FROM venue_aliases a WHERE a.canonical_id=v.id AND a.original_lat BETWEEN $1-0.0004 AND $1+0.0004 AND a.original_lng BETWEEN $2-0.001 AND $2+0.001) ORDER BY v.claimed DESC,v.id ASC`,[lat,lng])
 const matches=rows.filter(row=>sameVenue(row,v)||(row.identity_aliases||[]).some(alias=>sameVenue(alias,v)))
 return matches.length===1?matches[0]:null
}
module.exports={identityName,sameVenue,canonicalVenueId,findDuplicateVenue}
