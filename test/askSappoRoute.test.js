const test=require('node:test'),assert=require('node:assert/strict')
test('Gemini downtime returns a labelled real basic outing, rather than 503; validation still runs',async()=>{
 const db=require('../src/db/pool'),ai=require('../src/services/askInterpreter'),weather=require('../src/clients/weather'),routes=require('../src/clients/routes')
 const original={query:db.query,interpret:ai.interpret,getWeather:weather.getWeather,routeFor:routes.routeFor}
 const config=require('../src/config').config,oldKey=config.google.key
 let calls=0,queryCalls=0,routeCalls=[]
 db.query=async()=>{queryCalls++;return {rows:[{id:7,name:'A real café',category_slug:'cafe',lat:53.4084,lng:-2.9916,opening_hours:{periods:[{open:{day:0,hour:0}}]}}]}}
 ai.interpret=async()=>{calls++;return {intent:{roles:['coffee'],minutes:180},mode:'basic',provider:null,issue:'quota_exceeded'}}
 weather.getWeather=async()=>({meta:{source:'fallback'},hourly:[]})
 routes.routeFor=async(mode,a,b,departure)=>{routeCalls.push({mode,departure});return {durationSeconds:600,distanceMeters:1500}}
 try{
  const router=require('../src/routes/askSappo'),handler=router.stack.find(x=>x.route?.path==='/'&&x.route.methods.post).route.stack[0].handle
  let result,status=200;const res={status:n=>{status=n;return res},json:v=>{result=v}}
  await handler({body:{message:'Coffee',city:'Liverpool',startAt:new Date(Date.now()+3600000).toISOString(),minutes:180}},res,e=>{throw e})
  assert.equal(status,200);assert.equal(result.type,'plan');assert.equal(result.mode,'basic');assert.equal(result.aiProvider,null);assert.match(result.say,/basic plan/);assert.equal(result.stops[0].id,7);assert.equal(result.stops[0].weather,null)
  config.google.key='test-only'
  await handler({body:{message:'Coffee',city:'Liverpool',startAt:new Date(Date.now()+3600000).toISOString(),minutes:180,travelPreference:{mode:'transit',maxMinutes:15}}},res,e=>{throw e})
  assert.deepEqual(result.travelPreference,{mode:'transit',maxMinutes:15});assert.equal(result.stops[0].travelKind,'google_transit');assert.equal(routeCalls[0].mode,'transit');assert(Number.isFinite(new Date(routeCalls[0].departure).getTime()))
  await handler({body:{message:'Coffee',city:'Liverpool',startAt:'bad date'}},res,e=>{throw e});assert.equal(status,400);assert.equal(calls,2);assert.equal(queryCalls,2)
 }finally{config.google.key=oldKey;Object.assign(db,{query:original.query});Object.assign(ai,{interpret:original.interpret});Object.assign(weather,{getWeather:original.getWeather});Object.assign(routes,{routeFor:original.routeFor})}
})
