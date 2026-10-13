const router=require('express').Router()
const rateLimit=require('express-rate-limit')
const {query}=require('../db/pool')
const {getWeather}=require('../clients/weather')
const {routeFor}=require('../clients/routes')
const {config}=require('../config')
const {buildOuting,cleanIntent,matches}=require('../services/askSappo')
const {interpret,status,availableModels}=require('../services/askInterpreter')
// Reading diagnostics does not call Gemini or disclose credentials/prompts.
router.get('/status',(req,res)=>res.json({provider:'Gemini',...status()}))
router.get('/models',async(req,res)=>{try{res.json({models:await availableModels()})}catch{res.status(503).json({error:'Model catalogue is unavailable.'})}})
// Venue swaps do not call Gemini. Keep their allowance separate from AI chat.
router.use('/respin',rateLimit({windowMs:60*1000,max:60,standardHeaders:true,legacyHeaders:false,message:{error:'You’re swapping stops very quickly. Please wait a moment; your plan is still here.'},validate:{trustProxy:false}}))
router.post('/respin',async(req,res,next)=>{
 try{
  const b=req.body||{},p=b.plan||{},stops=p.stops,start=new Date(p.startAt),now=Date.now()
  if(!Array.isArray(stops)||!stops.length||stops.length>3||!stops.every(s=>/^\d+$/.test(String(s.id))&&typeof s.role==='string'))return res.status(400).json({error:'Open an outing first, then try another stop.'})
  if(!Number.isFinite(start.getTime())||start.getTime()<now-5*60000||start.getTime()>now+6*86400000)return res.status(400).json({error:'Choose a future start time before changing this outing.'})
  const origin={lat:Number(p.origin?.lat),lng:Number(p.origin?.lng)}
  if(!Number.isFinite(origin.lat)||!Number.isFinite(origin.lng)||Math.abs(origin.lat-53.4084)>0.15||Math.abs(origin.lng+2.9916)>0.25)return res.status(400).json({error:'This outing needs a starting point around Liverpool.'})
  const target=stops.find(s=>String(s.id)===String(b.targetId)),intent=cleanIntent({...p.intent,roles:stops.map(s=>s.role)})
  if(!target||intent.roles.length!==stops.length||new Set(stops.map(s=>String(s.id))).size!==stops.length)return res.status(400).json({error:'Choose a valid stop to swap.'})
  const {rows}=await query("SELECT id,name,address,category_slug,lat,lng,google_place_id,opening_hours,business_status,rating,rating_count,cover_photo FROM venues WHERE LOWER(city)='liverpool' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY rating_count DESC NULLS LAST LIMIT 5000")
  const current=stops.map(s=>rows.find(v=>String(v.id)===String(s.id)))
  if(current.some((v,i)=>!v||!matches(v,stops[i].role)))return res.status(409).json({error:'A stop in this outing has changed. Make a fresh plan before swapping it.'})
  const targetVenue=current[stops.indexOf(target)],lockedIds=Object.fromEntries(stops.filter(s=>s!==target).map(s=>[s.role,s.id]))
  const excludedIds=[target.id,...(Array.isArray(b.excludeIds)?b.excludeIds.filter(x=>/^\d+$/.test(String(x))).slice(-100):[])]
  const weather=await getWeather(origin.lat,origin.lng).catch(()=>null)
  let plan
  // Try at most three candidates; keep every other venue fixed and recheck all
  // legs/hours. No Gemini call is needed to replace a known activity.
  for(let attempt=0;attempt<3;attempt++){
   plan=await buildOuting({venues:rows,intent,startAt:start,origin,weather,weatherAt:getWeather,walkingRoute:(a,b)=>config.google.key?routeFor('walking',a,b):Promise.resolve(null),lockedIds,excludedIds,replacementCategory:targetVenue.category_slug})
   if(plan.stops.length===stops.length&&plan.stops.every(s=>s.role===target.role||String(s.id)===String(lockedIds[s.role])))return res.json({type:'plan',...plan,intent,origin,mode:p.mode==='basic'?'basic':'ai',aiProvider:p.mode==='basic'?null:'Gemini',originLabel:p.originLabel==='Your location'?'Your location':'Liverpool city centre',say:'A different stop, with the rest of your outing kept in place. I’ve checked the timings again.'})
   const replacement=plan.stops.find(s=>s.role===target.role);if(!replacement)break;excludedIds.push(replacement.id)
  }
  return res.status(409).json({error:'I couldn’t find another suitable place that fits this outing. Your original plan is still here—try more time or less walking.'})
 }catch(e){next(e)}
})
router.use(rateLimit({windowMs:60*1000,max:8,standardHeaders:true,legacyHeaders:false,message:{error:'Give SAPPO a moment, then try again.'},validate:{trustProxy:false}}))
router.post('/',async(req,res,next)=>{
 try{
  const b=req.body||{},message=typeof b.message==='string'?b.message.trim():''
  if(!message||message.length>600)return res.status(400).json({error:'Tell SAPPO what you fancy in up to 600 characters.'})
  if(String(b.city||'Liverpool').toLowerCase()!=='liverpool')return res.status(400).json({error:'Ask SAPPO is trying Liverpool first. Choose Liverpool to give it a go.'})
  const start=new Date(b.startAt),now=Date.now()
  if(!Number.isFinite(start.getTime())||start.getTime()<now-5*60000||start.getTime()>now+6*86400000)return res.status(400).json({error:'Choose a start time within the next six days.'})
  const origin=b.lat!=null&&b.lng!=null?{lat:Number(b.lat),lng:Number(b.lng)}:{lat:53.4084,lng:-2.9916}
  if(!Number.isFinite(origin.lat)||!Number.isFinite(origin.lng)||Math.abs(origin.lat-53.4084)>0.15||Math.abs(origin.lng+2.9916)>0.25)return res.status(400).json({error:'This trial plans outings around Liverpool. Use the city centre as your starting point.'})
  const history=Array.isArray(b.history)?b.history.filter(x=>typeof x==='string').slice(-3).map(x=>x.slice(0,600)):[]
  const understood=await interpret({message,history,minutes:b.minutes||180}),intent=understood.intent
  if(!intent||!intent.roles.length)return res.json({type:'clarify',mode:understood.mode,say:understood.mode==='basic'?'The AI is taking a breather. I can still help with a simple coffee, walk and sunset outing—try that, or come back for a more detailed request.':'For this first trial, try coffee, food, a park walk, culture, drinks or sunset. Events will come later.'})
  intent.minutes=Math.max(60,Math.min(360,Number(b.minutes)||intent.minutes))
  const {rows}=await query("SELECT id,name,address,category_slug,lat,lng,google_place_id,opening_hours,business_status,rating,rating_count,cover_photo FROM venues WHERE LOWER(city)='liverpool' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY rating_count DESC NULLS LAST LIMIT 2000")
  const weather=await getWeather(origin.lat,origin.lng).catch(()=>null)
  const plan=await buildOuting({venues:rows,intent,startAt:start,origin,weather,weatherAt:getWeather,walkingRoute:(a,b)=>config.google.key?routeFor('walking',a,b):Promise.resolve(null)})
  res.json({type:'plan',...plan,intent,origin,mode:understood.mode,aiProvider:understood.provider,originLabel:b.lat!=null?'Your location':'Liverpool city centre',say:understood.mode==='basic'?'The AI is taking a breather, so this is a basic plan using SAPPO’s real places, timings and forecast.':'Here’s a starting point. We can tweak it together.'})
 }catch(e){next(e)}
})
module.exports=router
