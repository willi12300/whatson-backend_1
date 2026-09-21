const { estimateItinerarySchedule, isTimeAppropriate } = require('./openingHours')
function validateExperience(template, stops, context = {}) {
 const ids = new Set(), categories = new Set(), issues=[]
 if ((stops||[]).length !== (template.stops||[]).filter(s=>s.required).length) issues.push('missing_required_stop')
 for (const stop of stops||[]) { if (!stop?.id) issues.push('missing_venue'); if(ids.has(String(stop.id)))issues.push('duplicate_venue'); ids.add(String(stop.id)); if(categories.has(stop.category_slug) && !stop.intentionalDuplicate) issues.push('duplicate_category'); categories.add(stop.category_slug) }
 const schedule=estimateItinerarySchedule(stops,{startAt:context.now||new Date(),origin:context.lat!=null?{lat:context.lat,lng:context.lng}:null,city:context.city})
 schedule.forEach(s=>{if(!s.availability.eligible)issues.push(`closed:${s.id}`);if(!isTimeAppropriate(s,new Date(s.estimatedArrivalAt),{city:context.city}))issues.push(`wrong_time:${s.id}`)})
 const duration=schedule.length ? new Date(schedule.at(-1).estimatedArrivalAt).getTime()-(context.now||new Date()).getTime()+schedule.at(-1).visitDurationMinutes*60000 : 0
 if (template.duration_minutes && duration > template.duration_minutes * 1.65 * 60000) issues.push('duration_exceeded')
 return { valid:!issues.length,issues,schedule,estimatedDurationMinutes:Math.round(duration/60000) }
}
module.exports = { validateExperience }
