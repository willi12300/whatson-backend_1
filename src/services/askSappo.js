const {distanceMeters} = require('../utils/helpers')
const {evaluateOpeningHours} = require('./openingHours')
const {sameVenue}=require('./venueIdentity')
const ROLES = ['coffee','walk','sunset','food','culture','drink']
const LABELS = {coffee:'Coffee first',walk:'Stretch your legs',sunset:'A sunset stop',food:'Something to eat',culture:'A little culture',drink:'A drink to finish'}
const WHY = {coffee:'A café stop for your outing.',walk:'An outdoor place to spend some time walking.',sunset:'A waterfront or open-view stop. Clouds and the exact viewpoint affect what you’ll see.',food:'A food stop along the way.',culture:'Time for a museum or gallery.',drink:'A pub or bar stop along the way.'}
function cleanIntent(raw) {
  const roles = [...new Set((Array.isArray(raw?.roles)?raw.roles:[]).filter(r=>ROLES.includes(r)))].slice(0,3)
  if (roles.includes('sunset')) roles.push(...roles.splice(roles.indexOf('sunset'),1))
  return {roles,lessWalking:raw?.lessWalking===true,longWalk:raw?.longWalk===true,minutes:Math.max(60,Math.min(360,Number(raw?.minutes)||180))}
}
function matches(v,role) {
  const c=String(v.category_slug||'').toLowerCase(),n=String(v.name||'').toLowerCase()
  if (/cemetery|grave|obelisk|memorial|plaque|statue|car park/.test(n)) return false
  if(role==='coffee')return /cafe|coffee_shop|bakery/.test(c)
  if(role==='walk')return /park|garden|nature/.test(c)||(/promenade/.test(n)&&!/cafe|restaurant|pub|bar/.test(c))
  if(role==='sunset')return /otterspool promenade|pier head|everton park|festival gardens|crosby beach/.test(n)&&!/cafe|restaurant|pub|bar|hotel/.test(c)
  if(role==='food')return /restaurant|food/.test(c)
  if(role==='culture')return /museum|gallery/.test(c)
  return /^(pub|bar)$/.test(c)
}
function usableWeather(w){return w?.meta?.source!=='fallback'&&!w?.meta?.stale&&Array.isArray(w?.hourly)&&w.hourly.length>0}
function weatherFor(w,at){
  if(!usableWeather(w))return null
  const h=w.hourly.find(x=>Math.abs(new Date(x.time)-at)<=30*60000)
  if(!h)return null
  return {time:h.time,temp:h.temp,condition:h.condition,rainChance:h.rainChance,windSpeed:h.windSpeed,source:'Open-Meteo',fetchedAt:w.fetched_at}
}
async function buildOuting({venues,intent,startAt,origin,weather,weatherAt,walkingRoute,lockedIds={},excludedIds=[],replacementCategory=null}) {
  const stops=[],missing=[],used=new Set(),start=new Date(startAt),end=start.getTime()+intent.minutes*60000
  const excluded=new Set(excludedIds.map(String)),reserved=new Set(Object.values(lockedIds).map(String))
  const rejected=venues.filter(v=>excluded.has(String(v.id)))
  let cursor=start.getTime(),previous=origin
  const sunset=usableWeather(weather)?(weather.sunsets||[]).map(x=>new Date(x)).find(x=>x>start&&x.getTime()<start.getTime()+24*3600000):null
  for(const role of intent.roles){
    const lockedId=lockedIds[role]
    if(role==='sunset'&&(!sunset||sunset.getTime()>end)){missing.push('Sunset falls outside this outing, or its forecast time isn’t available. Try a later start or more time.');continue}
    const duration=role==='walk'?(intent.longWalk?80:45):role==='coffee'?35:role==='sunset'?30:60
    const candidates=venues.filter(v=>!used.has(String(v.id))&&v.lat!=null&&v.lng!=null&&matches(v,role)&&!['CLOSED_PERMANENTLY','CLOSED_TEMPORARILY'].includes(v.business_status))
      .filter(v=>lockedId?String(v.id)===String(lockedId):!excluded.has(String(v.id))&&!reserved.has(String(v.id)))
      .filter(v=>lockedId||!rejected.some(r=>sameVenue(v,r)||(r.google_place_id&&r.google_place_id===v.google_place_id)))
      .filter(v=>lockedId||!replacementCategory||v.category_slug===replacementCategory)
      .filter(v=>role!=='walk'||!intent.longWalk||/sefton park|princes park|otterspool promenade|waterfront.*promenade|liverpool waterfront|everton park|festival gardens|crosby beach|newsham park|calderstones park/i.test(v.name))
      .map(v=>({v,d:distanceMeters(previous.lat,previous.lng,Number(v.lat),Number(v.lng))}))
      .filter(x=>x.d<=(intent.lessWalking?1600:5000))
      .sort((a,b)=>a.d-b.d).slice(0,40)
    let chosen
    for(const item of candidates){
      const travel=Math.max(2,Math.ceil(item.d*1.3/75)),arrival=role==='sunset'?Math.max(cursor+travel*60000,sunset.getTime()-25*60000):cursor+travel*60000
      const availability=evaluateOpeningHours(item.v.opening_hours,new Date(arrival),{city:'Liverpool',durationMinutes:duration})
      if(availability.status==='closed_at_arrival'||arrival+duration*60000>end)continue
      const score=item.d/1000+(availability.eligible?0:2)-((Number(item.v.rating)||3.8)*Math.min(Number(item.v.rating_count)||0,100)/100)*0.15
      if(!chosen||score<chosen.score)chosen={...item,score,travel,arrival,availability}
    }
    if(!chosen){missing.push(`I couldn’t find a suitable ${role} stop within your time and walking range.`);continue}
    let route=null
    try{route=await walkingRoute(previous,chosen.v)}catch{}
    const routed=Number(route?.durationSeconds)>0
    const travel=routed?Math.ceil(route.durationSeconds/60):chosen.travel
    const arrival=role==='sunset'?Math.max(cursor+travel*60000,sunset.getTime()-25*60000):cursor+travel*60000
    const availability=evaluateOpeningHours(chosen.v.opening_hours,new Date(arrival),{city:'Liverpool',durationMinutes:duration})
    if(availability.status==='closed_at_arrival'||arrival+duration*60000>end||(role==='sunset'&&arrival>sunset.getTime()-10*60000)){missing.push(`The ${role} stop wouldn’t fit once travel time was checked.`);continue}
    const v=chosen.v,wx=await weatherAt(Number(v.lat),Number(v.lng)).catch(()=>null)
    stops.push({id:v.id,venueId:v.id,name:v.name,address:v.address,category_slug:v.category_slug,cover_photo:v.cover_photo,rating:v.rating,rating_count:v.rating_count,lat:Number(v.lat),lng:Number(v.lng),role,label:LABELS[role],why:role==='walk'?'Time to explore this outdoor area. This is time at the place, rather than a mapped walking circuit.':WHY[role],arrivalAt:new Date(arrival).toISOString(),durationMinutes:duration,travelMinutes:travel,freeMinutes:Math.max(0,Math.floor((arrival-cursor)/60000)-travel),travelKind:routed?'google_walking':'estimate',distanceMeters:routed?route.distanceMeters:Math.round(chosen.d),hoursStatus:availability.eligible?'published_hours':'check_hours',weather:weatherFor(wx,new Date(arrival)),sunsetAt:role==='sunset'?sunset.toISOString():null,directionsUrl:`https://www.google.com/maps/dir/?api=1&origin=${previous.lat},${previous.lng}&destination=${v.lat},${v.lng}&travelmode=walking`})
    cursor=arrival+duration*60000;previous={lat:Number(v.lat),lng:Number(v.lng)};used.add(String(v.id))
  }
  return {stops,missing,title:'Your Liverpool outing',summary:stops.length?'A few stops that fit what you fancy. Open each profile before you head out.':'Let’s adjust this outing—try a different time or a shorter request.',startAt:start.toISOString(),finishAt:new Date(cursor).toISOString(),timezone:'Europe/London'}
}
module.exports={cleanIntent,matches,buildOuting,weatherFor}
