const test = require('node:test')
const assert = require('node:assert/strict')
const { scoreTemplate, rankTemplates } = require('../src/services/templateScoringService')
const { validateExperience } = require('../src/services/experienceValidationService')
const { assembleExperience } = require('../src/services/experienceAssembler')
const { selectFirstBuildableTemplate } = require('../src/services/templateSelectionService')

const hours = { periods:[{open:{day:0,hour:0},close:{day:6,hour:23,minute:59}}] }
const base = { id:1, category_slug:'cafe', lat:53.4, lng:-2.9, opening_hours:hours }

test('template scoring favours a rainy date-night template for a couple', () => {
 const date={title:'Date Night',ideal_time:['evening'],ideal_weather:['indoor'],budget:['moderate'],audience:['couple'],duration_minutes:180,energy_level:'relaxed',walking_preference:'low'}
 const generic={title:'Waterfront',ideal_time:['morning'],ideal_weather:['outdoor'],budget:['cheap'],audience:['family'],duration_minutes:480,energy_level:'high',walking_preference:'high'}
 assert.equal(rankTemplates([generic,date],{now:new Date('2026-08-02T19:00:00'),weather:{mode:'indoor'},budget:'moderate',audience:'couple',availableMinutes:240,energy:'relaxed',walkingPreference:'low'})[0].title,'Date Night')
})
test('assembler swaps to the next open candidate and excludes duplicates', async () => {
 const template={duration_minutes:240,stops:[{role:'Coffee',required:true,duration_minutes:30},{role:'Lunch',required:true,duration_minutes:30}]}
 const result=await assembleExperience(template,{city:'Liverpool',now:new Date('2026-08-02T10:00:00')},async(role,ctx,{excludeIds})=> role.role==='Coffee'?[base]:[{...base,id:2,name:'Lunch',category_slug:'restaurant'}].filter(v=>!excludeIds.includes(v.id)))
 assert.equal(result.valid,true); assert.deepEqual(result.stops.map(s=>s.id),[1,2])
})
test('validation rejects a closed stop and permits a complete open experience', () => {
 const template={duration_minutes:240,stops:[{required:true}]}
 const open=validateExperience(template,[base],{city:'Liverpool',now:new Date('2026-08-02T10:00:00')})
 const closed=validateExperience(template,[{...base,id:3,opening_hours:{periods:[{open:{day:1,hour:9},close:{day:1,hour:10}}]}}],{city:'Liverpool',now:new Date('2026-08-02T10:00:00')})
 assert.equal(open.valid,true); assert.equal(closed.valid,false); assert.match(closed.issues.join(','),/closed/)
})
test('template selection falls back when the best-scoring template cannot be assembled', async () => {
 const ranked=[{title:'Best but unavailable'},{title:'Fallback that works'}]
 const result=await selectFirstBuildableTemplate(ranked, async t => t.title.startsWith('Best') ? {valid:false} : {valid:true,stops:[]})
 assert.equal(result.template.title,'Fallback that works')
})
