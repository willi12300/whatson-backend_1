const router=require('express').Router()
const {venueDescription,eventDescription}=require('../services/profileDescriptions')
router.get('/:type/:id',async(req,res,next)=>{
  if(!/^\d+$/.test(req.params.id)||!['venue','event'].includes(req.params.type))return res.status(400).json({error:'Invalid profile'})
  try{
    const result=await(req.params.type==='venue'?venueDescription(req.params.id):eventDescription(req.params.id))
    if(!result)return res.status(404).json({error:'Profile not found'})
    res.json(result)
  }catch(error){next(error)}
})
module.exports=router
