const test=require('node:test'),assert=require('node:assert/strict')
test('background catalogue reads do not invoke paid discovery when an area has no venues',async()=>{
 const db=require('../src/db/pool'),google=require('../src/clients/google')
 const originalQuery=db.query,originalFetch=google.fetchVenues;let providerCalls=0
 db.query=async()=>({rows:[]});google.fetchVenues=async()=>{providerCalls++;return []}
 try{
  const router=require('../src/routes/venues'),handler=router.stack.find(layer=>layer.route?.path==='/').route.stack[0].handle
  let result;const response={json:value=>{result=value}},next=error=>{throw error}
  await handler({query:{lat:'53.4',lng:'-2.9',radius:'20000',limit:'2000',catalogueOnly:'true'}},response,next)
  assert.equal(result.count,0);assert.equal(providerCalls,0)
  await handler({query:{lat:'53.4',lng:'-2.9',radius:'20000',limit:'2000'}},response,next)
  assert.equal(providerCalls,1,'interactive discovery keeps its existing fallback')
 }finally{db.query=originalQuery;google.fetchVenues=originalFetch}
})
