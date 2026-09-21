const DAYPARTS = { morning:[6,12], afternoon:[12,17], evening:[17,22], late_night:[22,30] }
function asArray(value) { return Array.isArray(value) ? value : [] }
function daypartAt(when = new Date()) { const h = when.getHours(); return h < 6 ? 'late_night' : Object.entries(DAYPARTS).find(([,r]) => h >= r[0] && h < r[1])?.[0] || 'late_night' }
function includes(values, value) { return !values.length || !value || values.map(String).includes(String(value)) }
function scoreTemplate(template, context = {}) {
  let score = 0; const reasons = []
  const time = daypartAt(context.now)
  if (includes(asArray(template.ideal_time), time)) { score += 25; reasons.push('fits the time of day') }
  const weatherMode = context.weather?.planningHint?.mode || context.weather?.mode || null
  if (includes(asArray(template.ideal_weather), weatherMode)) { score += 18; reasons.push('works for today’s weather') }
  const budget = context.budget?.budget_level || context.budget || null
  if (includes(asArray(template.budget), budget)) { score += 14; reasons.push('fits the budget') }
  const audience = context.audience || context.who || null
  if (includes(asArray(template.audience), audience)) { score += 14; reasons.push('fits who you are with') }
  if (!context.availableMinutes || template.duration_minutes <= context.availableMinutes) { score += 12; reasons.push('fits the available time') }
  if (!context.energy || !template.energy_level || template.energy_level === context.energy) score += 8
  if (!context.walkingPreference || !template.walking_preference || template.walking_preference === context.walkingPreference) score += 6
  const words = `${context.text || ''} ${context.vibe || ''}`.toLowerCase()
  if (words && `${template.title} ${template.description || ''} ${JSON.stringify(template.metadata || {})}`.toLowerCase().split(/\W+/).some(w => w.length > 3 && words.includes(w))) score += 10
  return { score, reasons }
}
function rankTemplates(templates, context) { return templates.map(t => ({ ...t, scoring: scoreTemplate(t, context) })).sort((a,b) => b.scoring.score - a.scoring.score) }
module.exports = { daypartAt, scoreTemplate, rankTemplates }
