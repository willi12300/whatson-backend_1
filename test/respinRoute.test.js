const test=require('node:test'),assert=require('node:assert/strict')
test('respin validates catalogue identities, avoids AI, and rejects partial replacement plans',async()=>{
 const db=require('../src/db/pool'),ai=require('../src/services/askInterpreter'),wx=require('../src/clients/weather'),routes=require('../src/clients/routes')
 const original={query:db.query,interpret:ai.interpret,getWeather:wx.getWeather,routeFor:routes.routeFor}
 const venue=id=>({id,name:'Café '+id,category_slug:'cafe',lat:53.4084,lng:-2.9916,opening_hours:{periods:[{open:{day:0,hour:0}}]}})
 let calls=0
 db.query=async()=>({rows:[venue(7),venue(8)]});ai.interpret=async()=>{calls++;throw Error('Respin must not call Gemini')};wx.getWeather=async()=>null;routes.routeFor=async()=>null
 try{
  const router=require('../src/routes/askSappo'),handler=router.stack.find(x=>x.route?.path==='/respin').route.stack[0].handle
  const p={startAt:new Date(Date.now()+3600000).toISOString(),intent:{roles:['coffee'],minutes:180},origin:{lat:53.4084,lng:-2.9916},mode:'ai',stops:[{id:7,role:'coffee'}]}
  let status=200,result;const res={status:n=>{status=n;return res},json:v=>{result=v}}
  await handler({body:{plan:p,targetId:7,excludeIds:[7]}},res,e=>{throw e});assert.equal(status,200);assert.equal(result.stops[0].id,8);assert.equal(calls,0)
  await handler({body:{plan:p,targetId:7,excludeIds:[7,8]}},res,e=>{throw e});assert.equal(status,409);assert.match(result.error,/original plan/);assert.equal(p.stops[0].id,7)
  await handler({body:{plan:{...p,stops:[{id:999,role:'coffee'}]},targetId:999}},res,e=>{throw e});assert.equal(status,409);assert.equal(calls,0)
 }finally{db.query=original.query;ai.interpret=original.interpret;wx.getWeather=original.getWeather;routes.routeFor=original.routeFor}
})
