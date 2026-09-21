const { listTemplates } = require('./experienceTemplateService')
const { rankTemplates } = require('./templateScoringService')
const { candidatesForRole } = require('./venueCandidateService')
const { assembleExperience } = require('./experienceAssembler')
const { generateJSON } = require('../clients/gemini')
const { estimatePlanCost } = require('./costEstimate')
const { apiHours } = require('./openingHours')
const { getTravel } = require('./travelProvider')
const { selectFirstBuildableTemplate } = require('./templateSelectionService')

async function polish(template, stops, context) {
 const ids=stops.map(s=>s.id).join(', ')
 const ai=await generateJSON(`You are SAPPO. The backend has already selected this valid ${template.title} in ${context.city}. Stops: ${stops.map(s=>`${s.name} (${s.role})`).join(' → ')}. Return JSON ONLY with title, summary, reasoning, tip. Do not change, add, remove, reorder, search for, or mention venue IDs.`,{temperature:.55})
 return ai||{}
}
async function buildTemplateExperience(context) {
 const templates=await listTemplates()
 if (!templates.length) return { error:'no_templates' }
 const ranked=rankTemplates(templates,context)
 const selection = await selectFirstBuildableTemplate(ranked, template => assembleExperience(template, context, candidatesForRole))
 if (selection) {
  const { template, assembled } = selection
  const stops=assembled.stops.map((s,index)=>({ ...s, order:index+1, label:s.role, why:`Chosen for the ${s.role.toLowerCase()} part of this experience.`, ...apiHours(s.opening_hours,{city:context.city}), arrival:{...assembled.schedule[index].availability,estimatedArrivalAt:assembled.schedule[index].estimatedArrivalAt,estimatedArrivalTime:assembled.schedule[index].estimatedArrivalTime,transportMode:'walking'} }))
  for(let i=0;i<stops.length-1;i++) stops[i].travelToNext=await getTravel({lat:stops[i].lat,lng:stops[i].lng},{lat:stops[i+1].lat,lng:stops[i+1].lng}).catch(()=>null)
  const words=await polish(template,stops,context)
  return { title:words.title||template.title, summary:words.summary||template.description, reasoning:words.reasoning||`A ${template.title.toLowerCase()} shaped around what is open and nearby.`, tip:words.tip||null, template:{slug:template.slug,title:template.title,score:template.scoring.score,reasons:template.scoring.reasons}, stops, cost:estimatePlanCost(stops), totalDurationMinutes:assembled.estimatedDurationMinutes, source:'experience_template' }
 }
 return { error:'no_template_match',message:`I could not build a complete, open experience in ${context.city} right now.` }
}
module.exports = { buildTemplateExperience }
