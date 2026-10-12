const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const { config } = require('../src/config')
const { fetchEvents, eventStart, eventEnd } = require('../src/clients/skiddle')

test('Skiddle uses documented date bounds, stable date order, and every result page', async () => {
  const original = axios.get, originalKey = config.skiddle.key
  config.skiddle.key = 'test-key'
  const calls = []
  axios.get = async (_, { params }) => {
    calls.push(params)
    const count = params.offset < 200 ? 100 : 1
    return { data: { results: Array.from({ length: count }, (_, i) => ({
      id: params.offset + i, eventname: params.offset === 200 ? 'Above & Beyond' : `Event ${params.offset + i}`,
      startdate: '2026-10-17', openingtimes: { doorsopen: '14:00' }, MinPrice: '35',
    })) } }
  }
  try {
    const events = await fetchEvents(53.4, -3, 5, 60, { minDate: '2026-10-12', maxDate: '2026-12-11', strict: true })
    assert.equal(events.length, 201)
    assert.equal(events[200].name, 'Above & Beyond')
    assert.deepEqual(calls.map(call => call.offset), [0, 100, 200])
    assert.ok(calls.every(call => call.minDate === '2026-10-12' && call.maxDate === '2026-12-11' && call.order === 'date' && !('daterange' in call)))
    assert.equal(events[200].startsAt.toISOString(), '2026-10-17T13:00:00.000Z')
  } finally { axios.get = original; config.skiddle.key = originalKey }
})

test('failed or malformed Skiddle responses are not treated as a complete refresh', async () => {
  const original = axios.get, originalKey = config.skiddle.key
  config.skiddle.key = 'test-key'
  try {
    axios.get = async () => ({ data: { error: 'invalid key' } })
    await assert.rejects(fetchEvents(53.4, -3, 5, 60, { strict: true }), /Skiddle request failed/)
    axios.get = async () => { throw new Error('network failure with secret URL') }
    await assert.rejects(fetchEvents(53.4, -3, 5, 60, { strict: true }), /Skiddle request failed/)
  } finally { axios.get = original; config.skiddle.key = originalKey }
})

test('UK-local doors times use the offset on the event date, including winter', () => {
  assert.equal(eventStart({ startdate: '2026-10-17', openingtimes: { doorsopen: '14:00' } }).toISOString(), '2026-10-17T13:00:00.000Z')
  assert.equal(eventStart({ startdate: '2026-12-12', openingtimes: { doorsopen: '14:00' } }).toISOString(), '2026-12-12T14:00:00.000Z')
  assert.equal(eventStart({ startdate: '2026-10-17T13:00:00Z' }).toISOString(), '2026-10-17T13:00:00.000Z')
  assert.equal(eventStart({ startdate: '2026-10-17T14:00:00' }).toISOString(), '2026-10-17T13:00:00.000Z')
  assert.equal(eventStart({ startdate: '2026-12-12T14:00:00' }).toISOString(), '2026-12-12T14:00:00.000Z')
  assert.equal(eventEnd({ enddate: '2026-10-17T23:00:00' }).toISOString(), '2026-10-17T22:00:00.000Z')
  assert.equal(eventEnd({ enddate: '2026-10-17' }), null)
  assert.equal(eventStart({ startdate: '2026-10-17T14:00:00+00:00', openingtimes: { doorsopen: '14:00' } }).toISOString(), '2026-10-17T13:00:00.000Z')
  assert.equal(eventEnd({ enddate: '2026-10-17T23:00:00+00:00', openingtimes: { end: '23:00' } }).toISOString(), '2026-10-17T22:00:00.000Z')
  assert.equal(eventEnd({ startdate: '2026-10-17T23:00:00+00:00', enddate: '2026-10-17T02:00:00+00:00', openingtimes: { doorsopen: '23:00', end: '02:00' } }).toISOString(), '2026-10-18T01:00:00.000Z')
})
