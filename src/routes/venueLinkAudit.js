const express=require('express'),{query}=require('../db/pool')
const router=express.Router()
// Read-only public catalogue snapshot. No enrichment calls, raw provider payloads or secrets.
router.get('/catalogue',async(req,res,next)=>{try{
 const after=Math.max(0,Number.parseInt(req.query.after)||0),limit=Math.max(1,Math.min(Number.parseInt(req.query.limit)||1000,2000))
 const {rows}=await query(`SELECT v.id,v.name,v.city,v.address,v.lat,v.lng,v.category_slug,v.website,v.menu_url,v.google_place_id,
 to_jsonb(v)->>'instagram' AS instagram,to_jsonb(v)->>'facebook' AS facebook,to_jsonb(v)->>'booking_url' AS booking_url,
 (SELECT jsonb_build_object('name',COALESCE(s.raw->'displayName'->>'text',CASE WHEN s.raw->>'name' NOT LIKE 'places/%' THEN s.raw->>'name' END),'website',COALESCE(s.raw->>'websiteUri',s.raw->>'website'),'lat',s.raw->'location'->'latitude','lng',s.raw->'location'->'longitude') FROM venue_sources s WHERE s.venue_id=v.id AND s.provider='google' LIMIT 1) AS provider_identity
 FROM venues v WHERE v.id>$1 ORDER BY v.id LIMIT $2`,[after,limit+1])
 const items=rows.slice(0,limit);res.set('Cache-Control','no-store');res.json({venues:items,has_more:rows.length>limit,next_after:items.at(-1)?.id||after})
 }catch(e){next(e)}})
router.get('/names',(req,res)=>{const report=require('../services/venueNameAudit').nameAuditReport();const after=Math.max(0,Number.parseInt(req.query.after)||0),limit=Math.max(1,Math.min(Number.parseInt(req.query.limit)||1000,2000));const rows=report.venues.filter(v=>v.id>after);const venues=rows.slice(0,limit);res.set('Cache-Control','no-store');res.json({...report,venues,has_more:rows.length>limit,next_after:venues.at(-1)?.id||after})})
module.exports=router
