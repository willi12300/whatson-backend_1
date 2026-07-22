function compactCandidate(c) {
  return {
    candidateId: c.candidateId,
    type: c.type,
    name: c.name,
    category: c.category,
    address: c.address,
    lat: c.lat,
    lng: c.lng,
    rating: c.rating,
    ratingCount: c.ratingCount,
    priceLevel: c.priceLevel,
    openingHours: c.openingHours,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    isFree: c.isFree,
    minPrice: c.minPrice,
    distanceMeters: c.distanceMeters,
    scoreReasons: c.scoreReasons,
    dataConfidence: c.dataConfidence,
  }
}

function plannerPrompt(context, shortlist, { previousPlan = null, validationErrors = [] } = {}) {
  const intent = context.intent
  const weather = context.weather?.current ? {
    temperatureC: context.weather.current.temp,
    condition: context.weather.current.condition,
    precipitation: context.weather.current.precipitation,
    insight: context.weather.insight || null,
    source: context.weather.meta?.source || 'open_meteo',
  } : null
  const refinement = previousPlan
    ? `\nCURRENT PLAN TO REFINE:\n${JSON.stringify(previousPlan)}\nPreserve valid stops unless the user's refinement requires changing them.`
    : ''
  const correction = validationErrors.length
    ? `\nTHE PREVIOUS PLAN FAILED VALIDATION:\n${validationErrors.join('\n')}\nCorrect these errors once. Do not argue with the validator.`
    : ''

  return `You are SAPPO's experience planner. Build ONE thoughtful local experience, not a search-result list.

NON-NEGOTIABLE RULES:
- Select only candidateId values supplied below. Never invent a venue, event or ID.
- Use one to four stops.
- Respect start time, total duration, transport, budget, companions, avoidances and accessibility constraints.
- Keep the route coherent and avoid repetitive stop types unless the request calls for them.
- Do not claim live availability, crowd levels, queues, wait times, popularity changes or guaranteed opening.
- Weather claims may use only WEATHER below. If WEATHER is null, do not mention weather.
- A nearby event does not prove an entire area is crowded.
- Unknown information must become a warning, not an invented fact.
- Return strict JSON only.

NORMALISED INTENT:
${JSON.stringify({
    mode: intent.mode,
    message: intent.message,
    location: intent.location,
    startTime: intent.startTime,
    durationMinutes: intent.durationMinutes,
    radiusMiles: intent.radiusMiles,
    companions: intent.companions,
    moods: intent.moods,
    interests: intent.interests,
    budget: intent.budget,
    transportModes: intent.transportModes,
    avoid: intent.avoid,
    accessibility: intent.accessibility,
  })}

WEATHER:
${JSON.stringify(weather)}

ALLOWED CANDIDATES:
${JSON.stringify(shortlist.all.map(compactCandidate))}
${refinement}${correction}

Return exactly this shape:
{
  "title": "short title",
  "summary": "one sentence",
  "sappoMessage": "confident but proportionate local advice using only supplied facts",
  "reasons": [
    { "type": "intent|weather|budget|route|event|quality", "text": "grounded reason", "source": "user_request|open_meteo|sappo_route|sappo_estimate|provider name", "confidence": "high|medium|low" }
  ],
  "stops": [
    { "candidateId": "venue:123 or event:456", "startTime": "ISO timestamp", "durationMinutes": 60, "reason": "why this stop fits" }
  ],
  "warnings": [],
  "confidence": 0.0
}`
}

async function planExperienceWithGemini(context, shortlist, options = {}) {
  const generator = options.generateJSON || require('../clients/gemini').generateJSON
  return generator(plannerPrompt(context, shortlist, options), { temperature: options.validationErrors?.length ? 0.25 : 0.65 })
}

module.exports = { planExperienceWithGemini, plannerPrompt, compactCandidate }
