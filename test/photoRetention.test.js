const test = require('node:test')
const assert = require('node:assert/strict')
const { hasUsablePhotos } = require('../src/services/photoData')

test('empty source photo data cannot replace an enriched Google gallery', () => {
  assert.equal(hasUsablePhotos([]), false)
  assert.equal(hasUsablePhotos(null), false)
  assert.equal(hasUsablePhotos([{ url: '' }]), false)
  assert.equal(hasUsablePhotos([{ url: 'https://places.googleapis.com/v1/places/x/photos/y/media' }]), true)
  assert.equal(hasUsablePhotos(['https://example.com/photo.jpg']), true)
})
