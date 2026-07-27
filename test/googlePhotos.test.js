const test = require('node:test')
const assert = require('node:assert/strict')
const { repairPhotoUrl, repairGooglePhotoUrls } = require('../src/utils/helpers')

const googlePhoto = 'https://places.googleapis.com/v1/places/ChIJ123/photos/AUacShh/media?maxWidthPx=600&key=old-browser-key'
const fakeRequest = { protocol: 'https', get: name => name === 'host' ? 'api.sappo.test' : undefined }

test('Google Place images are served through SAPPO and never expose a key', () => {
  const repaired = repairPhotoUrl(googlePhoto, null, fakeRequest)
  assert.equal(repaired, 'https://api.sappo.test/media/google-photo?name=places%2FChIJ123%2Fphotos%2FAUacShh&width=600')
  assert.equal(repaired.includes('key='), false)
})

test('nested plan, venue and event image fields are all proxied', () => {
  const payload = { heroImage: googlePhoto, stops: [{ venue: { cover_photo: googlePhoto } }], external: 'https://example.com/image.jpg' }
  const repaired = repairGooglePhotoUrls(payload, fakeRequest)
  assert.match(repaired.heroImage, /^https:\/\/api\.sappo\.test\/media\/google-photo/)
  assert.match(repaired.stops[0].venue.cover_photo, /^https:\/\/api\.sappo\.test\/media\/google-photo/)
  assert.equal(repaired.external, payload.external)
})
