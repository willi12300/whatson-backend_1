const {distanceMeters}=require('../utils/helpers')
const normal=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim()
const generic=new Set('the and of at club nightclub music venue restaurant restaurants bar bars pub cafe coffee shop bistro italian hotel inn ltd limited liverpool manchester wales barcelona'.split(' '))
function providerIdentity(venue,details){
 const a=normal(venue.name),b=normal(details.name)
 if(!a||!b)return {matched:false,reason:'missing_name'}
 const words=s=>new Set(s.split(' ').filter(w=>w.length>2&&!generic.has(w)))
 const aw=words(a),bw=words(b),shared=[...aw].filter(w=>bw.has(w))
 const kind=s=>s.split(' ').filter(w=>['pub','club','nightclub','restaurant','cafe','hotel'].includes(w)).map(w=>w==='nightclub'?'club':w)
 const ak=kind(a),bk=kind(b)
 if(ak.length&&bk.length&&!ak.some(k=>bk.includes(k)))return {matched:false,reason:'different_name'}
 const nameMatch=a.replace(/^the /,'')===b.replace(/^the /,'')||(shared.length>0&&shared.length/Math.max(aw.size,bw.size)>=.75)
 const coords=[venue.lat,venue.lng,details.lat,details.lng]
 const distance=coords.every(n=>n!=null&&n!==''&&Number.isFinite(Number(n)))?distanceMeters(+venue.lat,+venue.lng,+details.lat,+details.lng):null
 if(!nameMatch)return {matched:false,reason:'different_name',distance}
 if(distance!=null&&distance>200)return {matched:false,reason:'different_location',distance}
 if(distance==null)return {matched:false,reason:'location_not_confirmed'}
 return {matched:true,reason:'name_and_location',distance}
}
module.exports={providerIdentity,normal}
