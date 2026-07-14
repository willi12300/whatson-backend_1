// Temporary diagnostic route — remove after checking
const router = require('express').Router()
const { query } = require('../db/pool')

router.get('/near-dolgellau', async (req, res) => {
  const lat = parseFloat(req.query.lat || 52.7447)
  const lng = parseFloat(req.query.lng || -3.8853)
  const label = req.query.label || 'Dolgellau'

  const radii = [5, 10, 20, 35, 50]
  const counts = {}
  for (const km of radii) {
    const { rows } = await query(`
      SELECT COUNT(*) as count FROM venues
      WHERE (6371 * acos(LEAST(1, cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat))))) < $3
    `, [lat, lng, km])
    counts[km + 'km'] = parseInt(rows[0].count)
  }

  const { rows: nearest } = await query(`
    SELECT name, city, lat, lng,
      profile_last_enriched IS NOT NULL as enriched,
      enrichment_status,
      ROUND((6371 * acos(LEAST(1, cos(radians($1)) * cos(radians(lat)) * cos(radians(lng) - radians($2)) + sin(radians($1)) * sin(radians(lat)))))::numeric, 2) as dist_km
    FROM venues
    ORDER BY dist_km ASC LIMIT 20
  `, [lat, lng])

  // Check grid tile coverage
  const north=52.80, south=51.80, west=-4.80, east=-3.00
  const mPerDegLat = 111320
  const midLat = (north+south)/2
  const mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180)
  const spacingLat = 10000 / mPerDegLat
  const spacingLng = 10000 / mPerDegLng
  const coveringTiles = []
  for (let tlat = south + spacingLat/2; tlat < north; tlat += spacingLat) {
    for (let tlng = west + spacingLng/2; tlng < east; tlng += spacingLng) {
      const dkm = Math.sqrt(
        Math.pow((tlat - lat) * 111.32, 2) +
        Math.pow((tlng - lng) * 111.32 * Math.cos(lat * Math.PI / 180), 2)
      )
      if (dkm < 12) coveringTiles.push({ lat: +tlat.toFixed(3), lng: +tlng.toFixed(3), distKm: +dkm.toFixed(1) })
    }
  }

  res.json({
    searchCentre: { label, lat, lng },
    venueCountsByRadius: counts,
    nearest20: nearest,
    midWalesGridTilesNearby: coveringTiles,
    gridNote: coveringTiles.length === 0
      ? 'NO GRID TILES cover this location in mid_wales region — gap in coverage'
      : coveringTiles.length + ' tiles should cover this area (8km radius each)'
  })
})

module.exports = router
