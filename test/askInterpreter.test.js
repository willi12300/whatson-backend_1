const test=require('node:test'),assert=require('node:assert/strict')
const {basicIntent,classifyFailure,createInterpreter}=require('../src/services/askInterpreter')
const request={message:'Coffee, a long walk and somewhere nice for sunset',minutes:300}
const quotaError=()=>({response:{status:429,data:{error:{message:'private project/key value',details:[{'@type':'type.googleapis.com/google.rpc.QuotaFailure',violations:[{quotaMetric:'generativelanguage.googleapis.com/generate_content_free_tier_requests'}]},{'@type':'type.googleapis.com/google.rpc.RetryInfo',retryDelay:'45s'}]}}}})
test('diagnostics identify quota failures without exposing provider messages, keys or projects',()=>{
 const f=classifyFailure(quotaError());assert.equal(f.kind,'quota_exceeded');assert.equal(f.httpStatus,429);assert.equal(f.retrySeconds,60);assert.equal(f.quotaMetrics.length,1);assert(!JSON.stringify(f).includes('private'))
 assert.equal(classifyFailure({response:{status:400,data:{error:{details:[{reason:'API_KEY_INVALID'}]}}}}).kind,'invalid_key')
})
test('supported outings and simple refinements work without AI; unsupported constraints are not guessed',()=>{
 assert.deepEqual(basicIntent(request.message).roles,['coffee','walk','sunset']);assert.equal(basicIntent('Less walking',[request.message]).lessWalking,true)
 assert.equal(basicIntent('No coffee, just walk'),null);assert.equal(basicIntent('Vegan lunch'),null);assert.equal(basicIntent('Concert tickets then drinks'),null)
})
test('429 produces a labelled basic plan intent and suppresses calls until retry time',async()=>{
 let calls=0,clock=Date.parse('2026-10-13T12:00:00Z');const i=createInterpreter({key:()=> 'private-key',now:()=>clock,log:()=>{},post:async()=>{calls++;throw quotaError()}})
 const first=await i.interpret(request);assert.equal(first.mode,'basic');assert.equal(first.issue,'quota_exceeded');assert.equal(calls,1)
 await i.interpret({...request,message:'Coffee and a walk'});assert.equal(calls,1);assert.equal(i.status().kind,'quota_exceeded');assert(!JSON.stringify(i.status()).includes('private-key'))
 clock+=61000;await i.interpret(request);assert.equal(calls,2)
})
test('duplicate requests share one Gemini call and successful intents are cached',async()=>{
 let calls=0,release;const wait=new Promise(r=>release=r),i=createInterpreter({key:()=> 'test-key',log:()=>{},post:async()=>{calls++;await wait;return {data:{candidates:[{content:{parts:[{text:JSON.stringify({roles:['coffee','walk'],minutes:180})}]}}]}}}})
 const a=i.interpret(request),b=i.interpret(request);release();assert.equal((await a).mode,'ai');assert.equal((await b).mode,'ai');assert.equal(calls,1)
 assert.equal((await i.interpret(request)).cached,true);assert.equal(calls,1);assert.equal(i.status().state,'ready')
})
test('missing keys and malformed model replies still support basic requests honestly',async()=>{
 const noKey=createInterpreter({key:()=>null,post:()=>{throw Error('must not call')}});assert.equal((await noKey.interpret(request)).mode,'basic')
 const malformed=createInterpreter({key:()=> 'test-key',log:()=>{},post:async()=>({data:{candidates:[]}})});assert.equal((await malformed.interpret(request)).issue,'invalid_response');assert.equal(malformed.status().kind,'invalid_response')
})
