// Source snapshots are separate from venue records and never attach across identity changes.
function normalise(value){return String(value||'').toLowerCase().replace(/^the\s+/,'').replace(/[^a-z0-9]/g,'')}
function distance(lat,lng,otherLat,otherLng){
 if([lat,lng,otherLat,otherLng].some(v=>v==null||v===''||!Number.isFinite(Number(v))))return Infinity
 const rad=x=>Number(x)*Math.PI/180,dlat=rad(otherLat)-rad(lat),dlng=rad(otherLng)-rad(lng)
 const a=Math.sin(dlat/2)**2+Math.cos(rad(lat))*Math.cos(rad(otherLat))*Math.sin(dlng/2)**2
 return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))
}
function samePlace(source,venue){return String(source.id)===String(venue.id)&&source.name===venue.name&&(source.website||null)===(venue.website||null)&&(source.address||null)===(venue.address||null)}
function usable(paragraphs){return Array.isArray(paragraphs)&&paragraphs.length>0&&paragraphs.join(' ').split(/\s+/).length>=14&&!/permanently closed|has closed|cookie policy|access denied|enable javascript|page not found|may include summary|list entry \d|\d{1,2}:\d{2}|now open|^welcome to|^official website/i.test(paragraphs.join(' '))}
function sourceFor(venue,records,now=Date.now()){
 const r=records.find(r=>samePlace(r,venue))
 const age=r?now-Date.parse(r.checked_at):Infinity
 return r&&age>=0&&age<30*86400000&&usable(r.paragraphs)?{status:'ready',paragraphs:r.paragraphs,source_url:r.source_url,source_label:r.source_label,checked_at:r.checked_at}:null
}
module.exports={normalise,distance,samePlace,usable,sourceFor}
