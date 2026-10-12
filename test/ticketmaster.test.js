const test = require('node:test')
const assert = require('node:assert/strict')
const axios = require('axios')
const { config } = require('../src/config')
const { fetchEvents } = require('../src/clients/ticketmaster')
const event = id => ({ id, name: 'Ticketmaster event ' + id, dates: { start: { dateTime: '2026-11-01T20:00:00Z' } }, _embedded: { venues: [{ name: 'Liverpool venue', location: { latitude: '53.4', longitude: '-3' } }] } })

test('automatic Ticketmaster refresh includes pages beyond the old five-page cap', async () => {
  const original = axios.get, key = config.ticketmaster.key; config.ticketmaster.key = 'test-key'
  const pages = []
  axios.get = async (_, { params }) => {
    assert.equal(params.startDateTime, '2026-10-12T00:00:00Z')
    assert.equal(params.endDateTime, '2026-12-11T23:59:59Z')
    pages.push(params.page)
    return { data: { page: { totalPages: 6, totalElements: 501 }, _embedded: { events: [event(String(params.page))] } } }
  }
  try {
    const results = await fetchEvents(53.4, -3, 5, 60, { strict: true, minDate: '2026-10-12', maxDate: '2026-12-11' })
    assert.equal(results.length, 6); assert.deepEqual(pages, [0, 1, 2, 3, 4, 5])
  } finally { axios.get = original; config.ticketmaster.key = key }
})

test('busy Ticketmaster windows split before the provider deep-paging limit', async () => {
  const original = axios.get, key = config.ticketmaster.key; config.ticketmaster.key = 'test-key'
  const calls = []
  axios.get = async (_, { params }) => {
    calls.push(params)
    if (calls.length === 1) return { data: { page: { totalPages: 20, totalElements: 2000 } } }
    return { data: { page: { totalPages: 1, totalElements: 1 }, _embedded: { events: [event(String(calls.length))] } } }
  }
  try {
    const results = await fetchEvents(53.4, -3, 5, 60, { strict: true, minDate: '2026-10-12', maxDate: '2026-12-11' })
    assert.equal(results.length, 2); assert.equal(calls.length, 3)
    assert.equal(Date.parse(calls[1].endDateTime) + 1000, Date.parse(calls[2].startDateTime))
    assert.equal(calls[1].startDateTime, calls[0].startDateTime)
    assert.equal(calls[2].endDateTime, calls[0].endDateTime)
  } finally { axios.get = original; config.ticketmaster.key = key }
})

test('Ticketmaster auth failures report a safe reason instead of succeeding with zero events', async () => {
  const original = axios.get, key = config.ticketmaster.key; config.ticketmaster.key = 'test-key'
  axios.get = async () => { throw Object.assign(new Error('secret request URL'), { response: { status: 401 } }) }
  try {
    await assert.rejects(fetchEvents(53.4, -3, 5, 60, { strict: true }), error => error.reason === 'http_401' && !error.message.includes('secret'))
  } finally { axios.get = original; config.ticketmaster.key = key }
})
