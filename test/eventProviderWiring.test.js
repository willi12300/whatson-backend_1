const test = require('node:test')
const assert = require('node:assert/strict')

test('city refresh invokes both configured providers without GPS', async () => {
  const { config } = require('../src/config')
  const skiddle = require('../src/clients/skiddle'), ticketmaster = require('../src/clients/ticketmaster')
  const original = { skiddle: skiddle.fetchEvents, ticketmaster: ticketmaster.fetchEvents, skiddleKey: config.skiddle.key, ticketmasterKey: config.ticketmaster.key }
  const called = []
  config.skiddle.key = config.ticketmaster.key = 'test-key'
  skiddle.fetchEvents = async () => { called.push('skiddle'); return [] }
  ticketmaster.fetchEvents = async () => { called.push('ticketmaster'); return [] }
  try {
    const { ensureCityEvents } = require('../src/services/eventRefresh')
    const status = await ensureCityEvents('Liverpool')
    assert.deepEqual(called.sort(), ['skiddle', 'ticketmaster'])
    assert.equal(status.providers.skiddle.status, 'ready')
    assert.equal(status.providers.ticketmaster.status, 'ready')
    assert.equal(status.status, 'ready')
    await ensureCityEvents('Liverpool')
    assert.equal(called.length, 2, 'repeated visits should use each provider cache')
  } finally {
    skiddle.fetchEvents = original.skiddle; ticketmaster.fetchEvents = original.ticketmaster
    config.skiddle.key = original.skiddleKey; config.ticketmaster.key = original.ticketmasterKey
  }
})
