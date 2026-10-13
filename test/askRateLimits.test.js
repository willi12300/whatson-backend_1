const test=require('node:test'),assert=require('node:assert/strict'),express=require('express')
test('respins have an independent allowance and do not spend the AI request allowance',async()=>{
 const router=require('../src/routes/askSappo'),app=express();app.use(express.json());app.use('/ask-sappo',router)
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/ask-sappo`
 try{
  // Invalid payloads stop before DB/Google/Gemini, but exercise real middleware.
  for(let i=0;i<12;i++){const r=await fetch(base+'/respin',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,400);assert.equal(r.headers.get('ratelimit-limit'),'60')}
  const ai=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(ai.status,400);assert.equal(ai.headers.get('ratelimit-limit'),'8');assert.equal(ai.headers.get('ratelimit-remaining'),'7')
  for(let i=0;i<7;i++)await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
  assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,429)
  assert.equal((await fetch(base+'/respin',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400)
 }finally{await new Promise(r=>server.close(r))}
})
