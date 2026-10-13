const router=require('express').Router()
const rateLimit=require('express-rate-limit')
const {query}=require('../db/pool')
const {getWeather}=require('../clients/weather')
const {routeFor}=require('../clients/routes')
const {config}=require('../config')
const {buildOuting}=require('../services/askSappo')
const {interpret,status,availableModels}=require('../services/askInterpreter')
// Reading diagnostics does not call Gemini or disclose credentials/prompts.
router.get('/status',(req,res)=>res.json({provider:'Gemini',...status()}))
router.get('/models',async(req,res)=>{try{res.json({models:await availableModels()})}catch{res.status(503).json({error:'Model catalogue is unavailable.'})}})
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
  const {rows}=await query("SELECT id,name,address,category_slug,lat,lng,opening_hours,business_status,rating,rating_count,cover_photo FROM venues WHERE LOWER(city)='liverpool' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY rating_count DESC NULLS LAST LIMIT 2000")
  const weather=await getWeather(origin.lat,origin.lng).catch(()=>null)
  const plan=await buildOuting({venues:rows,intent,startAt:start,origin,weather,weatherAt:getWeather,walkingRoute:(a,b)=>config.google.key?routeFor('walking',a,b):Promise.resolve(null)})
  res.json({type:'plan',...plan,intent,mode:understood.mode,aiProvider:understood.provider,originLabel:b.lat!=null?'Your location':'Liverpool city centre',say:understood.mode==='basic'?'The AI is taking a breather, so this is a basic plan using SAPPO’s real places, timings and forecast.':'Here’s a starting point. We can tweak it together.'})
 }catch(e){next(e)}
})
module.exports=router
