const { estimateItinerarySchedule } = require('./openingHours')
const { validateExperience } = require('./experienceValidationService')
async function assembleExperience(template, context, candidateProvider) {
 const stops=[], used=[]
 for (const role of template.stops || []) {
  const schedule=estimateItinerarySchedule(stops,{startAt:context.now||new Date(),origin:context.lat!=null?{lat:context.lat,lng:context.lng}:null,city:context.city})
  const arrivalAt=schedule.length ? new Date(schedule.at(-1).estimatedArrivalAt).getTime()+schedule.at(-1).visitDurationMinutes*60000 : new Date((context.now||new Date()).getTime()+5*60000)
  const candidates=await candidateProvider(role,context,{excludeIds:used,arrivalAt:new Date(arrivalAt)})
  const picked=candidates[0]
  if (!picked) { if (role.required) return { valid:false, reason:`no_candidate:${role.role}`,stops }; continue }
  stops.push({...picked,role:role.role,duration_minutes:role.duration_minutes||60}); used.push(picked.id)
 }
 const validation=validateExperience(template,stops,context)
 return {...validation,stops}
}
module.exports = { assembleExperience }
