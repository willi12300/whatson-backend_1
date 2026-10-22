const {distanceMeters}=require('../utils/helpers')
const normal=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim()
const generic=new Set('the and of at restaurant restaurants bar bars pub cafe coffee shop bistro italian hotel inn ltd limited liverpool manchester wales barcelona'.split(' '))
function providerIdentity(venue,details){
 const a=normal(venue.name),b=normal(details.name)
 if(!a||!b)return {matched:false,reason:'missing_name'}
 const words=s=>new Set(s.split(' ').filter(w=>w.length>2&&!generic.has(w)))
 const aw=words(a),bw=words(b),shared=[...aw].filter(w=>bw.has(w))
 const nameMatch=a===b||(Math.min(a.length,b.length)>=6&&(a.includes(b)||b.includes(a)))||(shared.length>0&&shared.length/Math.min(aw.size,bw.size)>=.75)
 const coords=[venue.lat,venue.lng,details.lat,details.lng]
 const distance=coords.every(n=>n!=null&&n!==''&&Number.isFinite(Number(n)))?distanceMeters(+venue.lat,+venue.lng,+details.lat,+details.lng):null
 if(!nameMatch)return {matched:false,reason:'different_name',distance}
 if(distance!=null&&distance>200)return {matched:false,reason:'different_location',distance}
 if(distance==null)return {matched:false,reason:'location_not_confirmed'}
 return {matched:true,reason:'name_and_location',distance}
}
module.exports={providerIdentity,normal}
