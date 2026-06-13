// src/utils/geo.ts

/**
 * Haversine distance in metres between two lat/lng points
 */
export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000 // Earth radius in metres
  const toRad = (d: number) => d * Math.PI / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Generate a grid of circle centres covering a bounding box
 * Used to scan all of Liverpool with Google's 5km radius circles
 */
export function generateGrid(
  south: number, west: number,
  north: number, east: number,
  radiusMetres: number
): Array<{ lat: number; lng: number }> {
  const stepDeg = (radiusMetres / 111320) * 1.5 // overlap circles 50%
  const centres: Array<{ lat: number; lng: number }> = []
  for (let lat = south; lat <= north; lat += stepDeg) {
    for (let lng = west; lng <= east; lng += stepDeg) {
      centres.push({ lat, lng })
    }
  }
  return centres
}

// Liverpool grid cells
export const LIVERPOOL_GRID = generateGrid(53.30, -3.05, 53.50, -2.85, 5000)

/**
 * Round coordinates for cache key generation
 * ~111m precision at 3dp, ~1.1km at 2dp
 */
export function roundCoords(lat: number, lng: number, dp = 3) {
  return {
    lat: parseFloat(lat.toFixed(dp)),
    lng: parseFloat(lng.toFixed(dp))
  }
}
