function iso(value) { return new Date(value).toISOString() }

function deterministicFallbackPlan(context, shortlist) {
  const candidates = [...(shortlist.all || [])]
  const start = new Date(context.intent.startTime)
  const deadline = new Date(start.getTime() + context.intent.durationMinutes * 60000)
  const stops = []
  let cursor = new Date(start)

  for (const candidate of candidates) {
    if (stops.length >= 3) break
    let stopStart = new Date(cursor)
    if (candidate.type === 'event') {
      const eventStart = new Date(candidate.startsAt)
      if (Number.isNaN(eventStart.getTime()) || eventStart < cursor || eventStart >= deadline) continue
      stopStart = eventStart
    }
    const remaining = Math.floor((deadline - stopStart) / 60000)
    if (remaining < 30) continue
    const durationMinutes = Math.min(candidate.type === 'event' ? 90 : 60, remaining)
    stops.push({
      candidateId: candidate.candidateId,
      startTime: iso(stopStart),
      durationMinutes,
      reason: candidate.scoreReasons?.includes('intent_match')
        ? 'It is one of the strongest grounded matches for what you asked for.'
        : 'It is a well-supported option that fits the available time.',
    })
    cursor = new Date(stopStart.getTime() + durationMinutes * 60000 + 20 * 60000)
  }

  if (!stops.length) return null
  return {
    title: context.intent.mode === 'surprise_me' ? 'A SAPPO pick for you' : 'A practical SAPPO plan',
    summary: 'A grounded route built from the strongest available local options.',
    sappoMessage: 'These are the best-supported choices I can make from the live information available.',
    reasons: [{
      type: 'intent',
      text: 'The plan uses only candidates returned by SAPPO providers and respects the requested time window.',
      source: 'user_request',
      confidence: 'high',
    }],
    stops,
    warnings: ['SAPPO used its deterministic fallback because the AI planner could not produce a fully valid plan.'],
    confidence: 0.62,
  }
}

module.exports = { deterministicFallbackPlan }
