const test = require('node:test')
const assert = require('node:assert/strict')
const { createEventRefresher, combineProviderStatus } = require('../src/services/eventRefresh')
const city = { name: 'Liverpool', lat: 53.4084, lng: -2.9916, radiusMiles: 5 }

test('simultaneous visitors share a complete refresh, including events after result 500', async () => {
  let time = Date.parse('2026-10-12T10:00:00Z'), fetches = 0, matches = 0
  const saved = []
  const refresh = createEventRefresher({
    now: () => time,
    fetchEvents: async (...args) => {
      fetches++; assert.equal(args[4].strict, true); assert.equal(args[4].maxResults, undefined)
      return Array.from({ length: 601 }, (_, i) => ({ providerId: String(i), venueName: 'Blackstone Street Warehouse', venueLat: 53.4, venueLng: -3 }))
    },
    matchVenue: async () => { matches++; return { method: 'name_proximity', venueId: 96, confidence: 1 } },
    saveEvent: async e => saved.push(e.providerId),
  })
  const first = refresh.refresh(city), second = refresh.refresh(city)
  assert.equal(first.promise, second.promise)
  await first.promise
  assert.equal(fetches, 1); assert.equal(matches, 1); assert.equal(saved.length, 601)
  assert.equal(refresh.status(city).status, 'ready')
  await refresh.refresh(city).promise
  assert.equal(fetches, 1)
  time += 3600001
  await refresh.refresh(city).promise
  assert.equal(fetches, 2)
})

test('provider failures retain stored data, report failure, and retry instead of marking fresh', async () => {
  let time = 1000000, calls = 0, saved = 0
  const refresh = createEventRefresher({ now: () => time, fetchEvents: async () => { calls++; throw new Error('offline') }, saveEvent: async () => saved++, matchVenue: async () => ({}) })
  await refresh.refresh(city).promise
  assert.equal(refresh.status(city).status, 'error')
  assert.equal(refresh.status(city).checked_at, null)
  assert.equal(saved, 0)
  await refresh.refresh(city).promise; assert.equal(calls, 1)
  time += 60001
  await refresh.refresh(city).promise; assert.equal(calls, 2)
})

test('an absent key is reported rather than caching an empty feed as fresh', async () => {
  const refresh = createEventRefresher({ hasKey: () => false, fetchEvents: () => { throw new Error('must not call') } })
  const result = refresh.refresh(city)
  assert.equal(result.state.status, 'unavailable')
  await result.promise
})

test('a failed Ticketmaster refresh keeps successful Skiddle results and exposes provider status', () => {
  const result = combineProviderStatus({ skiddle: { status: 'ready', saved: 1322 }, ticketmaster: { status: 'error', reason: 'http_401' } })
  assert.equal(result.status, 'partial'); assert.equal(result.saved, 1322)
  assert.equal(result.providers.ticketmaster.reason, 'http_401')
  assert.equal(combineProviderStatus({skiddle: {status: 'ready'},ticketmaster: {status: 'refreshing'}}).status, 'refreshing')
  assert.equal(combineProviderStatus({skiddle: {status: 'ready'},ticketmaster: {status: 'ready'}}).status, 'ready')
})
