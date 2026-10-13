const test=require('node:test'),assert=require('node:assert/strict')
const {cleanIntent,matches,buildOuting,weatherFor}=require('../src/services/askSappo')
const hours={periods:[{open:{day:0,hour:0}}]}
const startAt='2026-10-13T13:00:00Z',sunset='2026-10-13T17:20:00Z'
const venue=(id,name,category_slug,lat=53.4084,lng=-2.9916,opening_hours=hours)=>({id,name,category_slug,lat,lng,opening_hours,address:'Liverpool',rating:4.5,rating_count:100})
const venues=[venue(1,'A real cafe','cafe'),venue(2,'Sefton Park','park',53.407,-2.99),venue(3,'Pier Head','landmark',53.406,-2.989),venue(4,'Park Cafe','cafe'),venue(5,'Sefton Park Obelisk','park')]
const weather={meta:{source:'live',stale:false},sunsets:[sunset],hourly:[{time:startAt,temp:15,rainChance:60}]}
const deps={startAt,origin:{lat:53.4084,lng:-2.9916},weather,weatherAt:async()=>weather,walkingRoute:async()=>({durationSeconds:300,distanceMeters:400})}
test('AI intent is allowlisted, bounded and sunset is last',()=>{assert.deepEqual(cleanIntent({roles:['sunset','coffee','invented','coffee','walk'],minutes:999}),{roles:['coffee','walk','sunset'],lessWalking:false,longWalk:false,minutes:360});assert.deepEqual(cleanIntent(null).roles,[])})
test('walks exclude miscategorised monuments and cafes named after parks',()=>{assert.equal(matches(venues[3],'walk'),false);assert.equal(matches(venues[4],'walk'),false)})
test('outing uses only catalogue venues, checks timing, anchors sunset and keeps route provenance',async()=>{
 const p=await buildOuting({...deps,venues,intent:cleanIntent({roles:['coffee','walk','sunset'],minutes:300})})
 assert.deepEqual(p.stops.map(s=>s.id),[1,2,3]);assert.equal(p.stops[2].sunsetAt,new Date(sunset).toISOString());assert.equal(p.stops[2].arrivalAt,'2026-10-13T16:55:00.000Z');assert.equal(p.stops[0].travelKind,'google_walking')
})
test('closed venues excluded and unknown hours explicitly labelled; route failures are estimates',async()=>{
 const closed={periods:[{open:{day:2,hour:8},close:{day:2,hour:9}}]}
 const p=await buildOuting({...deps,venues:[venue(6,'Closed cafe','cafe',53.4084,-2.9916,closed),venue(7,'Unknown cafe','cafe',53.4084,-2.9916,null)],walkingRoute:async()=>{throw Error('unavailable')},intent:cleanIntent({roles:['coffee'],minutes:180})})
 assert.equal(p.stops.length,1);assert.equal(p.stops[0].id,7);assert.equal(p.stops[0].hoursStatus,'check_hours');assert.equal(p.stops[0].travelKind,'estimate')
})
test('no imaginary sunsets or weather: unavailable/stale forecast and short outings handled',async()=>{
 assert.equal(weatherFor({...weather,meta:{source:'fallback'}},new Date(startAt)),null);assert.equal(weatherFor({...weather,meta:{source:'live',stale:true}},new Date(startAt)),null)
 const p=await buildOuting({...deps,venues,intent:cleanIntent({roles:['sunset'],minutes:90})});assert.equal(p.stops.length,0);assert.match(p.missing[0],/Sunset falls outside/)
})
test('long walks favour substantial parks or waterfronts, rather than small city gardens',async()=>{
 const p=await buildOuting({...deps,venues:[venue(9,'Chavasse Park','park'),venue(10,'Sefton Park','park',53.4,-2.99)],intent:cleanIntent({roles:['walk'],longWalk:true,minutes:180})});assert.equal(p.stops[0].id,10);assert.equal(p.stops[0].durationMinutes,80)
})
