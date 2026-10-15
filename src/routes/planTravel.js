const router=require('express').Router()
const rateLimit=require('express-rate-limit')
const {config}=require('../config')
const {routeFor}=require('../clients/routes')
const cache=new Map()
const point=value=>value&&value.lat!==''&&value.lng!==''&&value.lat!=null&&value.lng!=null&&Number.isFinite(Number(value.lat))&&Number.isFinite(Number(value.lng))&&Math.abs(Number(value.lat))<=90&&Math.abs(Number(value.lng))<=180?{lat:Number(value.lat),lng:Number(value.lng)}:null
router.use(rateLimit({windowMs:60000,max:15,standardHeaders:true,legacyHeaders:false,validate:{trustProxy:false}}))
router.post('/',async(req,res)=>{
 const {stops,departureTime}=req.body||{}
 if(!Array.isArray(stops)||stops.length<2||stops.length>12)return res.status(400).json({error:'Provide between 2 and 12 ordered stops.'})
 const parsed=departureTime==null?Date.now():Date.parse(departureTime)
 if(!Number.isFinite(parsed))return res.status(400).json({error:'Invalid departure time.'})
 const departure=new Date(Math.max(Date.now()+60000,parsed)).toISOString()
 const legs=[]
 // Keep concurrency bounded; a single route failing never discards the itinerary.
 for(let i=0;i<stops.length-1;i++){
  const from=point(stops[i]),to=point(stops[i+1])
  if(!from||!to){legs.push({index:i,status:'missing_coordinates',walking:null,driving:null});continue}
  if(!config.google.key){legs.push({index:i,status:'unavailable',walking:null,driving:null});continue}
  const key=JSON.stringify([from,to,Math.floor(+new Date(departure)/1800000)])
  let result=cache.get(key)
  if(!result||Date.now()-result.at>10*60000){
   const values=await Promise.allSettled(['walking','driving'].map(mode=>routeFor(mode,from,to,departure)))
   const clean=v=>v.status==='fulfilled'&&v.value&&Number.isFinite(v.value.durationSeconds)&&v.value.durationSeconds>0&&Number.isFinite(v.value.distanceMeters)&&v.value.distanceMeters>=0?v.value:null
   result={at:Date.now(),walking:clean(values[0]),driving:clean(values[1])}
   if(result.walking||result.driving){cache.set(key,result);if(cache.size>500)cache.delete(cache.keys().next().value)}
  }
  legs.push({index:i,status:result.walking||result.driving?'available':'unavailable',provider:'Google Routes',fetchedAt:new Date(result.at).toISOString(),walking:result.walking,driving:result.driving})
 }
 res.json({legs,departureTime:departure})
})
module.exports=router
