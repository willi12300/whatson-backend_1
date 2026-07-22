const ALLOWED_MODES = new Set(['tell_sappo', 'guide_me', 'surprise_me', 'refine'])

function list(value) {
  if (!value) return []
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.map(v => String(v).trim().toLowerCase()).filter(Boolean))]
}

function finite(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function durationFromText(text = '') {
  const hours = text.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i)
  if (hours) return Math.round(Number(hours[1]) * 60)
  const mins = text.match(/\b(\d{2,3})\s*(?:minutes?|mins?)\b/i)
  return mins ? Number(mins[1]) : null
}

function explicitCompanions(text = '') {
  if (/\b(partner|couple|date|wife|husband|boyfriend|girlfriend)\b/i.test(text)) return 'couple'
  if (/\b(family|kids?|children|child)\b/i.test(text)) return 'family'
  if (/\b(solo|alone|myself|on my own)\b/i.test(text)) return 'solo'
  if (/\b(friends?|mates?|group)\b/i.test(text)) return 'friends'
  return null
}

function textConstraints(text = '') {
  const avoid = []
  const accessibility = []
  const interests = []
  if (/\b(alcohol[- ]?free|no alcohol|without alcohol|don'?t drink|non[- ]?drinker)\b/i.test(text)) avoid.push('alcohol')
  if (/\b(indoors?|inside|nothing outdoors?)\b/i.test(text)) avoid.push('outdoors')
  if (/\b(wheelchair|step[- ]?free|no stairs?|mobility access)\b/i.test(text)) accessibility.push('step_free')
  if (/\b(child[- ]?friendly|kid[- ]?friendly|children|kids?)\b/i.test(text)) interests.push('family')
  if (/\b(read|reading|book|somewhere quiet)\b/i.test(text)) interests.push('reading')
  return { avoid, accessibility, interests }
}

function deterministicIntent(input = {}, now = new Date()) {
  const message = String(input.message || '').trim()
  const parsed = require('./parseIntent').parseIntent(message)
  const constraints = textConstraints(message)
  const amount = finite(input.budget?.maxPerPerson ?? input.maxPerPerson ?? parsed.budgetPerPerson)
  const level = finite(input.budget?.level) ?? ({ cheap: 1, moderate: 2, premium: 4 }[parsed.budget] || null)
  const location = input.location || {}

  return {
    mode: ALLOWED_MODES.has(input.mode) ? input.mode : 'tell_sappo',
    message,
    location: {
      city: String(location.city || input.city || 'Liverpool').trim(),
      lat: finite(location.lat ?? input.lat),
      lng: finite(location.lng ?? input.lng),
    },
    startTime: input.startTime || now.toISOString(),
    durationMinutes: Math.max(45, Math.min(12 * 60, finite(input.durationMinutes) || durationFromText(message) || 180)),
    radiusMiles: Math.max(0.5, Math.min(25, finite(input.radiusMiles) || 6)),
    companions: String(input.companions || explicitCompanions(message) || parsed.group || 'unspecified').toLowerCase(),
    moods: list(input.moods?.length ? input.moods : parsed.vibe),
    interests: list(input.interests?.length ? input.interests : [...parsed.categories, ...constraints.interests]),
    budget: { level, maxPerPerson: amount },
    transportModes: list(input.transportModes?.length ? input.transportModes : ['walking']),
    avoid: list([...list(input.avoid), ...constraints.avoid]),
    accessibility: list([...list(input.accessibility), ...constraints.accessibility]),
    userId: input.userId || null,
    deviceId: input.deviceId || null,
    currentExperience: input.currentExperience || null,
    source: 'deterministic',
  }
}

function extractionPrompt(message) {
  return `Extract travel-planning intent from the user message below. Return JSON only. Do not invent preferences.

USER MESSAGE:
${message}

Return this shape, using null or [] when not explicit:
{
  "durationMinutes": null,
  "companions": null,
  "moods": [],
  "interests": [],
  "avoid": [],
  "accessibility": [],
  "budget": { "level": null, "maxPerPerson": null },
  "requestedStartTime": null,
  "constraints": []
}`
}

function mergeExtracted(base, extracted = {}) {
  const out = { ...base }
  if (base.durationMinutes === 180 && finite(extracted.durationMinutes)) {
    out.durationMinutes = Math.max(45, Math.min(12 * 60, finite(extracted.durationMinutes)))
  }
  if (base.companions === 'unspecified' && extracted.companions) out.companions = String(extracted.companions).toLowerCase()
  if (!base.moods.length) out.moods = list(extracted.moods)
  if (!base.interests.length) out.interests = list(extracted.interests)
  out.avoid = list([...base.avoid, ...list(extracted.avoid), ...list(extracted.constraints)])
  out.accessibility = list([...base.accessibility, ...list(extracted.accessibility)])
  if (base.budget.level == null && finite(extracted.budget?.level) != null) out.budget = { ...out.budget, level: finite(extracted.budget.level) }
  if (base.budget.maxPerPerson == null && finite(extracted.budget?.maxPerPerson) != null) out.budget = { ...out.budget, maxPerPerson: finite(extracted.budget.maxPerPerson) }
  out.source = 'deterministic+gemini'
  return out
}

async function normaliseRecommendationRequest(input = {}, { generateJSON, now = new Date() } = {}) {
  const base = deterministicIntent(input, now)
  if (!base.message || !generateJSON || !['tell_sappo', 'refine'].includes(base.mode)) return base
  const extracted = await Promise.resolve()
    .then(() => generateJSON(extractionPrompt(base.message), { temperature: 0.1 }))
    .catch(() => null)
  if (!extracted || typeof extracted !== 'object') return base
  const merged = mergeExtracted(base, extracted)
  if (!input.startTime && extracted.requestedStartTime) {
    const requested = new Date(extracted.requestedStartTime)
    if (!Number.isNaN(requested.getTime())) merged.startTime = requested.toISOString()
  }
  return merged
}

module.exports = {
  normaliseRecommendationRequest,
  deterministicIntent,
  mergeExtracted,
  durationFromText,
  textConstraints,
}
