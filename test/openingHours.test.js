const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateOpeningHours, estimateItinerarySchedule, isTimeAppropriate, apiHours } = require('../src/services/openingHours')

const weekday = (day, openHour, closeDay, closeHour) => ({ periods: [{ open: { day, hour: openHour, minute: 0 }, ...(closeHour == null ? {} : { close: { day: closeDay, hour: closeHour, minute: 0 } }) }] })

test('accepts a venue open now', () => {
  const result = evaluateOpeningHours(weekday(1, 9, 1, 17), new Date('2026-01-05T10:30:00Z'), { city: 'Liverpool', durationMinutes: 30 })
  assert.equal(result.eligible, true)
  assert.equal(result.status, 'open_at_arrival')
})

test('rejects a venue closed now', () => {
  const result = evaluateOpeningHours(weekday(1, 9, 1, 17), new Date('2026-01-05T18:00:00Z'), { city: 'Liverpool' })
  assert.equal(result.eligible, false)
  assert.equal(result.status, 'closed_at_arrival')
})

test('accepts a venue that opens before the planned arrival', () => {
  const result = evaluateOpeningHours(weekday(1, 17, 1, 22), new Date('2026-01-05T17:15:00Z'), { city: 'Liverpool', durationMinutes: 45 })
  assert.equal(result.eligible, true)
})

test('rejects an itinerary stop that would run past closing time', () => {
  const result = evaluateOpeningHours(weekday(1, 9, 1, 17), new Date('2026-01-05T16:30:00Z'), { city: 'Liverpool', durationMinutes: 60 })
  assert.equal(result.eligible, false)
})

test('supports overnight venues across midnight', () => {
  const hours = weekday(6, 20, 0, 2)
  assert.equal(evaluateOpeningHours(hours, new Date('2026-01-10T23:30:00Z'), { city: 'Liverpool' }).eligible, true)
  assert.equal(evaluateOpeningHours(hours, new Date('2026-01-11T01:00:00Z'), { city: 'Liverpool' }).eligible, true)
})

test('supports 24-hour venues', () => {
  const result = evaluateOpeningHours(weekday(1, 0, null, null), new Date('2026-01-05T23:00:00Z'), { city: 'Liverpool', durationMinutes: 90 })
  assert.equal(result.eligible, true)
})

test('rejects missing opening hours rather than assuming a venue is open', () => {
  const result = evaluateOpeningHours(null, new Date('2026-01-05T12:00:00Z'), { city: 'Liverpool' })
  assert.equal(result.eligible, false)
  assert.equal(result.status, 'unknown_hours')
})

test('does not treat a late-open cafe as an appropriate 9pm recommendation', () => {
  assert.equal(isTimeAppropriate({ category_slug: 'cafe' }, new Date('2026-01-05T21:00:00Z'), { city: 'Liverpool' }), false)
  assert.equal(isTimeAppropriate({ category_slug: 'bar' }, new Date('2026-01-05T21:00:00Z'), { city: 'Liverpool' }), true)
})

test('normalises Google Places hours for the API response', () => {
  const result = apiHours({ openNow: true, nextOpenTime: '2026-01-06T09:00:00Z', weekdayDescriptions: ['Monday: 09:00 – 17:00'], periods: weekday(1, 9, 1, 17).periods }, { city: 'Liverpool' })
  assert.equal(result.isOpenNow, true)
  assert.equal(result.timezone, 'Europe/London')
  assert.deepEqual(result.openingHours, ['Monday: 09:00 – 17:00'])
})

test('estimates arrival independently for every itinerary stop', () => {
  const hours = weekday(1, 9, 1, 23)
  const schedule = estimateItinerarySchedule([
    { id: 1, category_slug: 'cafe', lat: 53.4, lng: -2.99, opening_hours: hours },
    { id: 2, category_slug: 'restaurant', lat: 53.401, lng: -2.99, opening_hours: hours },
  ], { startAt: new Date('2026-01-05T10:00:00Z'), origin: { lat: 53.4, lng: -2.99 }, city: 'Liverpool' })
  assert.equal(schedule.length, 2)
  assert.ok(new Date(schedule[1].estimatedArrivalAt) > new Date(schedule[0].estimatedArrivalAt))
  assert.equal(schedule.every(stop => stop.availability.eligible), true)
})
