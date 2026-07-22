const test = require('node:test')
const assert = require('node:assert/strict')
const { createRecommendationEngine } = require('../src/services/recommendationEngine')
const { validateExperience } = require('../src/services/recommendationValidator')
const { filterAndShortlist } = require('../src/services/recommendationScoring')
const { textConstraints } = require('../src/services/recommendationIntent')

const START = '2026-07-25T17:00:00.000Z'

function dailyHours(openHour = 9, closeHour = 23) {
  return { periods: Array.from({ length: 7 }, (_, day) => ({
    open: { day, hour: openHour, minute: 0 },
    close: { day, hour: closeHour, minute: 0 },
  })) }
}

function venue(id, name, overrides = {}) {
  return {
    candidateId: `venue:${id}`,
    type: 'venue',
    venueId: Number(id),
    source: 'sappo_database',
    name,
    category: 'restaurant',
    lat: 53.405,
    lng: -2.991,
    address: `${id} Liverpool Street`,
    rating: 4.5,
    ratingCount: 500,
    priceLevel: 2,
    openingHours: dailyHours(),
    scoreReasons: ['intent_match'],
    dataConfidence: 1,
    ...overrides,
  }
}

function context(overrides = {}) {
  return {
    intent: {
      mode: 'tell_sappo',
      message: 'Food and culture for three hours',
      location: { city: 'Liverpool', lat: 53.405, lng: -2.991 },
      startTime: START,
      durationMinutes: 180,
      companions: 'couple',
      moods: ['relaxed'],
      interests: ['food', 'culture'],
      budget: { level: 2, maxPerPerson: 50 },
      transportModes: ['walking'],
      avoid: [],
      accessibility: [],
    },
    weather: null,
    userSignals: { categoryBoost: {} },
    history: [],
    venues: [venue(1, 'Mersey Kitchen'), venue(2, 'Liverpool Gallery', { category: 'gallery', lat: 53.407 })],
    events: [],
    providerAudit: { dbVenues: { count: 2 } },
    ...overrides,
  }
}

const travel = async () => ({
  primary: 'walking',
  walking: { durationSeconds: 600, distanceMeters: 700 },
})
const silentLogger = { info() {}, warn() {}, error() {} }

test('natural-language safety constraints are preserved before Gemini planning', () => {
  const parsed = textConstraints('A wheelchair-friendly afternoon with the kids, indoors, and no alcohol please')
  assert.deepEqual(parsed.avoid.sort(), ['alcohol', 'outdoors'])
  assert.deepEqual(parsed.accessibility, ['step_free'])
  assert.deepEqual(parsed.interests, ['family'])
})

function validPlan() {
  return {
    title: 'Liverpool, nicely paced',
    summary: 'Food followed by culture.',
    sappoMessage: 'This keeps the route compact and matches your food and culture request.',
    reasons: [{ type: 'intent', text: 'Both stops match the request.', source: 'user_request', confidence: 'high' }],
    stops: [
      { candidateId: 'venue:1', startTime: START, durationMinutes: 60, reason: 'A strong food match.' },
      { candidateId: 'venue:2', startTime: '2026-07-25T18:10:00.000Z', durationMinutes: 60, reason: 'Adds culture nearby.' },
    ],
    warnings: [],
    confidence: 0.86,
  }
}

function engineWith(planner) {
  const ctx = context()
  return createRecommendationEngine({
    normaliseRecommendationRequest: async () => ctx.intent,
    gatherRecommendationContext: async () => ctx,
    planExperienceWithGemini: planner,
    getTravel: travel,
    ensureInternalVenueId: async c => c.venueId,
    logger: silentLogger,
  })
}

test('builds a validated multi-stop Liverpool experience from supplied candidates', async () => {
  const recommend = engineWith(async () => validPlan())
  const result = await recommend({ mode: 'tell_sappo', location: { city: 'Liverpool' } })
  assert.equal(result.meta.strategy, 'gemini')
  assert.equal(result.experience.stops.length, 2)
  assert.deepEqual(result.experience.stops.map(s => s.venueId), [1, 2])
  assert.equal(result.experience.travelLegs[0].source, 'google_routes')
})

test('rejects an invented venue and gives the planner exactly one repair attempt', async () => {
  let calls = 0
  const recommend = engineWith(async () => {
    calls++
    if (calls === 1) return { ...validPlan(), stops: [{ candidateId: 'venue:invented', startTime: START, durationMinutes: 60 }] }
    return validPlan()
  })
  const result = await recommend({ mode: 'tell_sappo', location: { city: 'Liverpool' } })
  assert.equal(calls, 2)
  assert.equal(result.meta.strategy, 'gemini_repair')
  assert.equal(result.experience.stops[0].venueId, 1)
})

test('uses the deterministic fallback when both Gemini plans fail validation', async () => {
  let calls = 0
  const recommend = engineWith(async () => { calls++; return null })
  const result = await recommend({ mode: 'surprise_me', location: { city: 'Liverpool' } })
  assert.equal(calls, 2)
  assert.equal(result.meta.strategy, 'deterministic_fallback')
  assert.ok(result.experience.stops.length >= 1)
  assert.ok(result.experience.warnings.some(w => w.includes('deterministic fallback')))
})

test('returns an honest no-plan response when no grounded candidates exist', async () => {
  const empty = context({ venues: [], events: [] })
  const recommend = createRecommendationEngine({
    normaliseRecommendationRequest: async () => empty.intent,
    gatherRecommendationContext: async () => empty,
    logger: silentLogger,
  })
  const result = await recommend({ mode: 'guide_me', location: { city: 'Liverpool' } })
  assert.equal(result.experience, null)
  assert.equal(result.meta.strategy, 'none')
})

test('hard filtering removes closed, alcohol-avoided and duplicate candidates', () => {
  const ctx = context()
  ctx.intent.avoid = ['alcohol']
  ctx.venues = [
    venue(1, 'Good Cafe', { category: 'cafe' }),
    venue(2, 'Closed Museum', { category: 'museum', openingHours: dailyHours(9, 10) }),
    venue(3, 'Local Pub', { category: 'pub' }),
    venue(4, 'Good Cafe', { category: 'cafe' }),
  ]
  const shortlist = filterAndShortlist(ctx)
  assert.deepEqual(shortlist.all.map(c => c.name), ['Good Cafe'])
  assert.deepEqual(new Set(shortlist.rejected.map(r => r.reason)), new Set(['closed_during_window', 'alcohol_avoided', 'duplicate']))
})

test('validator does not retain a travel leg to a later rejected stop', async () => {
  const ctx = context()
  const shortlist = { all: ctx.venues, venues: ctx.venues, events: [] }
  const plan = validPlan()
  plan.stops[1].durationMinutes = 180
  const result = await validateExperience(plan, ctx, shortlist, {
    getTravel: travel,
    ensureInternalVenueId: async c => c.venueId,
  })
  assert.equal(result.valid, false)
  assert.equal(result.experience.stops.length, 1)
  assert.equal(result.experience.travelLegs.length, 0)
})

test('validator strips unsupported live crowd and queue claims', async () => {
  const ctx = context()
  const shortlist = { all: ctx.venues, venues: ctx.venues, events: [] }
  const plan = validPlan()
  plan.summary = 'Both places are quiet and not busy.'
  plan.sappoMessage = 'There will definitely be no queue.'
  plan.stops[0].reason = 'It is guaranteed quiet with no wait time.'
  plan.reasons = [{ type: 'quality', text: 'It is not busy tonight.', source: 'sappo_database', confidence: 'high' }]
  const result = await validateExperience(plan, ctx, shortlist, {
    getTravel: travel,
    ensureInternalVenueId: async c => c.venueId,
  })
  assert.equal(result.valid, true)
  assert.doesNotMatch(JSON.stringify(result.experience), /quiet and not busy|no queue|no wait time|not busy tonight/i)
})

test('rainy family planning ranks an indoor museum above an outdoor park', () => {
  const ctx = context()
  ctx.intent.companions = 'family'
  ctx.intent.interests = ['family']
  ctx.weather = { current: { temp: 15 }, planningHint: { mode: 'indoor' } }
  ctx.venues = [
    venue(1, 'World Museum', { category: 'museum' }),
    venue(2, 'Riverside Park', { category: 'park' }),
  ]
  const result = filterAndShortlist(ctx)
  assert.equal(result.venues[0].name, 'World Museum')
})

test('good-weather outdoor planning ranks a park above an unrelated indoor venue', () => {
  const ctx = context()
  ctx.intent.interests = ['outdoors', 'walk']
  ctx.weather = { current: { temp: 20, condition: 'clear' }, planningHint: { mode: 'outdoor' } }
  ctx.venues = [
    venue(1, 'Sefton Park', { category: 'park' }),
    venue(2, 'Indoor Restaurant', { category: 'restaurant' }),
  ]
  const result = filterAndShortlist(ctx)
  assert.equal(result.venues[0].name, 'Sefton Park')
})

test('a solo one-hour quiet request favours a cafe and respects the hour', async () => {
  const ctx = context()
  ctx.intent.durationMinutes = 60
  ctx.intent.companions = 'solo'
  ctx.intent.interests = ['quiet', 'reading']
  ctx.venues = [venue(1, 'Quiet Reading Cafe', { category: 'cafe' })]
  const shortlist = filterAndShortlist(ctx)
  const result = await validateExperience({
    ...validPlan(),
    stops: [{ candidateId: 'venue:1', startTime: START, durationMinutes: 60, reason: 'A cafe matching the quiet request.' }],
  }, ctx, shortlist, { getTravel: travel, ensureInternalVenueId: async c => c.venueId })
  assert.equal(result.valid, true)
  assert.equal(result.experience.totalDurationMinutes, 60)
})

test('friends asking for food and live music retain both relevant candidate types', () => {
  const ctx = context()
  ctx.intent.companions = 'friends'
  ctx.intent.interests = ['food', 'music']
  ctx.events = [{
    candidateId: 'event:gig-1', type: 'event', eventId: 'gig-1', source: 'ticketmaster',
    name: 'Liverpool Live Session', category: 'music', lat: 53.406, lng: -2.99,
    startsAt: '2026-07-25T18:30:00.000Z', endsAt: '2026-07-25T20:00:00.000Z', isFree: false,
  }]
  const result = filterAndShortlist(ctx)
  assert.ok(result.venues.some(c => c.category === 'restaurant'))
  assert.ok(result.events.some(c => c.candidateId === 'event:gig-1'))
})

test('a low-budget alcohol-free date excludes pubs', () => {
  const ctx = context()
  ctx.intent.companions = 'couple'
  ctx.intent.interests = ['food']
  ctx.intent.budget = { level: 1, maxPerPerson: 25 }
  ctx.intent.avoid = ['alcohol']
  ctx.venues = [
    venue(1, 'Affordable Bistro', { priceLevel: 1 }),
    venue(2, 'Date Night Pub', { category: 'pub', priceLevel: 1 }),
  ]
  const result = filterAndShortlist(ctx)
  assert.deepEqual(result.venues.map(c => c.name), ['Affordable Bistro'])
})

test('a late request filters a venue already closed for the requested window', () => {
  const ctx = context()
  ctx.intent.startTime = '2026-07-25T22:30:00.000Z'
  ctx.intent.durationMinutes = 90
  ctx.venues = [
    venue(1, 'Daytime Cafe', { category: 'cafe', openingHours: dailyHours(8, 18) }),
    venue(2, 'Late Gallery', { category: 'gallery', openingHours: dailyHours(18, 24) }),
  ]
  const result = filterAndShortlist(ctx)
  assert.deepEqual(result.venues.map(c => c.name), ['Late Gallery'])
})

test('a 90-minute before-train request rejects an overlong second stop', async () => {
  const ctx = context()
  ctx.intent.durationMinutes = 90
  const shortlist = { all: ctx.venues, venues: ctx.venues, events: [] }
  const result = await validateExperience(validPlan(), ctx, shortlist, {
    getTravel: travel,
    ensureInternalVenueId: async c => c.venueId,
  })
  assert.equal(result.valid, false)
  assert.equal(result.experience.stops.length, 1)
  assert.ok(result.errors.some(error => error.includes('duration exceeds')))
})

test('a thin live Google result receives a real internal venue ID before return', async () => {
  const ctx = context()
  const live = venue('google-place', 'Live Google Fallback', {
    venueId: null,
    externalId: 'places/live-google',
    googlePlaceId: 'places/live-google',
    source: 'google_places',
  })
  ctx.venues = [live]
  const shortlist = { all: [live], venues: [live], events: [] }
  const result = await validateExperience({
    ...validPlan(),
    stops: [{ candidateId: live.candidateId, startTime: START, durationMinutes: 60, reason: 'Verified live fallback.' }],
  }, ctx, shortlist, {
    getTravel: travel,
    ensureInternalVenueId: async () => 901,
  })
  assert.equal(result.valid, true)
  assert.equal(result.experience.stops[0].venueId, 901)
})

test('a total context-provider failure returns an honest recoverable response', async () => {
  const ctx = context()
  const recommend = createRecommendationEngine({
    normaliseRecommendationRequest: async () => ctx.intent,
    gatherRecommendationContext: async () => { throw new Error('providers down') },
    logger: silentLogger,
  })
  const result = await recommend({ mode: 'surprise_me', location: { city: 'Liverpool' } })
  assert.equal(result.experience, null)
  assert.match(result.message, /could not check enough live local information/i)
})
