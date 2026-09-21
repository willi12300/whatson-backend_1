// Source feeds frequently omit photos. Empty data is not an instruction to
// remove the gallery already enriched from Google.
function hasUsablePhotos(photos) {
  if (!Array.isArray(photos) || !photos.length) return false
  return photos.some(photo => {
    const url = typeof photo === 'string' ? photo : photo?.url
    return typeof url === 'string' && url.trim().length > 0
  })
}
module.exports = { hasUsablePhotos }
