const test=require('node:test'),assert=require('node:assert/strict'),express=require('express')
const {config}=require('../src/config'),routes=require('../src/clients/routes')
let calls=0
routes.routeFor=async(mode,from,to)=>{calls++;if(mode==='driving')throw new Error('Provider unavailable');return {mode,durationSeconds:420,distanceMeters:700}}
const router=require('../src/routes/planTravel')
test('plan travel validates input and returns routed walking with unavailable driving without inventing times',async()=>{
 const original=config.google.key;config.google.key='test'
 const app=express();app.use(express.json());app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port
 try{
  const request=body=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  assert.equal((await request({stops:[{}]})).status,400)
  assert.equal((await request({stops:[{},{}],departureTime:'bad'})).status,400)
  let response=await (await request({stops:[{lat:53.4,lng:-2.98},{lat:53.401,lng:-2.98},{}]})).json()
  assert.equal(response.legs[0].walking.durationSeconds,420);assert.equal(response.legs[0].driving,null);assert.equal(response.legs[1].status,'missing_coordinates')
  assert.equal(calls,2)
  await request({stops:[{lat:53.4,lng:-2.98},{lat:53.401,lng:-2.98}]});assert.equal(calls,2)
  config.google.key='';response=await(await request({stops:[{lat:53,lng:-2},{lat:53.2,lng:-2}]})).json();assert.equal(response.legs[0].status,'unavailable');assert.equal(response.legs[0].driving,null)
 }finally{config.google.key=original;server.close()}
})
