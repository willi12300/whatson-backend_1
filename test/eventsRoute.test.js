const test = require('node:test')
const assert = require('node:assert/strict')

test('city discovery refreshes without GPS even with stored events, then searches ampersand artist names', async () => {
  const db = require('../src/db/pool')
  const refresh = require('../src/services/eventRefresh')
  const originalQuery = db.query, originalRefresh = refresh.ensureCityEvents
  let refreshed = false, receivedParams
  refresh.ensureCityEvents = async city => {
    assert.equal(city, 'Liverpool'); refreshed = true
    return { status: 'ready', saved: 601 }
  }
  db.query = async (sql, params) => {
    assert.equal(refreshed, true, 'refresh must start before selecting stored events')
    assert.ok(sql.includes('e.status=')); receivedParams = params
    return { rows: Array.from({length: 2}, (_, i) => ({ id: 123 + i, name: 'Above & Beyond presents Anjunabeats Liverpool', venue_name: 'Blackstone Street Warehouse', starts_at: '2026-10-17T13:00:00Z' })) }
  }
  const router = require('../src/routes/events')
  const handler = router.stack.find(layer => layer.route?.path === '/').route.stack[0].handle
  try {
    let result
    await handler({ query: { city: 'Liverpool', q: 'above and beyond', limit: '1', offset: '100' } }, { json: value => { result = value } }, error => { throw error })
    assert.equal(result.events[0].name, 'Above & Beyond presents Anjunabeats Liverpool')
    assert.equal(result.refresh.status, 'ready')
    assert.equal(result.events.length, 1)
    assert.equal(result.has_more, true)
    assert.equal(result.next_offset, 101)
    assert.ok(receivedParams.includes('%above%') && receivedParams.includes('%beyond%'))
    assert.ok(!receivedParams.includes('%above and beyond%'))
  } finally {
    db.query = originalQuery; refresh.ensureCityEvents = originalRefresh
  }
})
