// src/clients/weather.js
// Open-Meteo weather client — no API key needed.
// Returns current conditions + next 12 hours, with caching/throttling so the app
// does not hammer the weather API on every homepage render/tab change.

const axios = require('axios')
const logger = require('../utils/logger')

const CACHE_TTL_MS = Number(process.env.WEATHER_CACHE_TTL_MS || 20 * 60 * 1000) // fresh for 20 mins
const STALE_TTL_MS = Number(process.env.WEATHER_STALE_TTL_MS || 6 * 60 * 60 * 1000) // fallback for 6 hours
const REQUEST_TIMEOUT_MS = Number(process.env.WEATHER_TIMEOUT_MS || 8000)

// In-memory cache is enough for Railway single-service runtime and avoids 429s.
// Key is rounded location, so tiny GPS movements don't create new API calls.
const cache = new Map()
const inflight = new Map()

function weatherCacheKey(lat, lng) {
  const safeLat = Number(lat)
  const safeLng = Number(lng)
  if (!Number.isFinite(safeLat) || !Number.isFinite(safeLng)) return null
  return `${safeLat.toFixed(2)},${safeLng.toFixed(2)}`
}

function isFresh(entry) {
  return entry && Date.now() - entry.fetchedAt < CACHE_TTL_MS
}

function isStaleUsable(entry) {
  return entry && Date.now() - entry.fetchedAt < STALE_TTL_MS
}

function withCacheMeta(data, status, fetchedAt) {
  return {
    ...data,
    cache: {
      status, // fresh | stale | live
      fetchedAt: new Date(fetchedAt || Date.now()).toISOString(),
      ttlMinutes: Math.round(CACHE_TTL_MS / 60000),
    },
  }
}

// WMO weather code → { label, icon, indoor } (indoor = leans toward indoor plans)
const WMO = {
  0:  { label: 'Clear', icon: '☀️', indoor: false },
  1:  { label: 'Mostly clear', icon: '🌤️', indoor: false },
  2:  { label: 'Partly cloudy', icon: '⛅', indoor: false },
  3:  { label: 'Overcast', icon: '☁️', indoor: false },
  45: { label: 'Foggy', icon: '🌫️', indoor: true },
  48: { label: 'Foggy', icon: '🌫️', indoor: true },
  51: { label: 'Light drizzle', icon: '🌦️', indoor: true },
  53: { label: 'Drizzle', icon: '🌦️', indoor: true },
  55: { label: 'Heavy drizzle', icon: '🌧️', indoor: true },
  61: { label: 'Light rain', icon: '🌦️', indoor: true },
  63: { label: 'Rain', icon: '🌧️', indoor: true },
  65: { label: 'Heavy rain', icon: '🌧️', indoor: true },
  66: { label: 'Freezing rain', icon: '🌧️', indoor: true },
  67: { label: 'Freezing rain', icon: '🌧️', indoor: true },
  71: { label: 'Light snow', icon: '🌨️', indoor: true },
  73: { label: 'Snow', icon: '❄️', indoor: true },
  75: { label: 'Heavy snow', icon: '❄️', indoor: true },
  77: { label: 'Snow grains', icon: '🌨️', indoor: true },
  80: { label: 'Showers', icon: '🌦️', indoor: true },
  81: { label: 'Showers', icon: '🌧️', indoor: true },
  82: { label: 'Heavy showers', icon: '⛈️', indoor: true },
  85: { label: 'Snow showers', icon: '🌨️', indoor: true },
  86: { label: 'Snow showers', icon: '❄️', indoor: true },
  95: { label: 'Thunderstorm', icon: '⛈️', indoor: true },
  96: { label: 'Thunderstorm', icon: '⛈️', indoor: true },
  99: { label: 'Thunderstorm', icon: '⛈️', indoor: true },
}
const code = c => WMO[c] || { label: 'Unknown', icon: '🌡️', indoor: false }

async function getWeather(lat, lng, opts = {}) {
  const key = weatherCacheKey(lat, lng)
  const force = opts.force === true
  const cached = key ? cache.get(key) : null

  if (!force && isFresh(cached)) {
    return withCacheMeta(cached.data, 'fresh', cached.fetchedAt)
  }

  if (!force && key && inflight.has(key)) {
    return inflight.get(key)
  }

  const requestPromise = fetchWeatherLive(lat, lng)
    .then(data => {
      if (key) cache.set(key, { data, fetchedAt: Date.now() })
      return withCacheMeta(data, 'live', Date.now())
    })
    .catch(err => {
      const status = err.response?.status
      if (isStaleUsable(cached)) {
        logger.warn(`weather: using stale cache for ${key || 'unknown'} after ${status || err.message}`)
        return withCacheMeta(cached.data, 'stale', cached.fetchedAt)
      }
      throw err
    })
    .finally(() => {
      if (key) inflight.delete(key)
    })

  if (key) inflight.set(key, requestPromise)
  return requestPromise
}

async function fetchWeatherLive(lat, lng) {
  const url = 'https://api.open-meteo.com/v1/forecast'
  const res = await axios.get(url, {
    params: {
      latitude: lat, longitude: lng,
      current: 'temperature_2m,weather_code,wind_speed_10m,precipitation',
      hourly: 'temperature_2m,weather_code,precipitation_probability',
      forecast_days: 1, timezone: 'auto',
    },
    timeout: REQUEST_TIMEOUT_MS,
  })
  const d = res.data
  const cur = d.current
  const curCode = code(cur.weather_code)

  // Build next 12 hours starting from the current hour
  const times = d.hourly.time
  const nowIso = cur.time
  let startIdx = times.findIndex(t => t >= nowIso)
  if (startIdx < 0) startIdx = 0
  const hourly = []
  for (let i = startIdx; i < Math.min(startIdx + 12, times.length); i++) {
    const wc = code(d.hourly.weather_code[i])
    hourly.push({
      time: times[i],
      hour: new Date(times[i]).getHours(),
      temp: Math.round(d.hourly.temperature_2m[i]),
      condition: wc.label,
      icon: wc.icon,
      indoor: wc.indoor,
      rainChance: d.hourly.precipitation_probability?.[i] ?? null,
    })
  }

  const insight = buildInsight(cur, curCode, hourly)
  const planningHint = buildPlanningHint(cur, curCode, hourly)

  return {
    current: {
      temp: Math.round(cur.temperature_2m),
      condition: curCode.label,
      icon: curCode.icon,
      windSpeed: Math.round(cur.wind_speed_10m),
      precipitation: cur.precipitation,
    },
    hourly,
    insight,        // short human sentence for UI
    planningHint,   // structured hint for the planner
  }
}

// Find the first upcoming hour with a high rain chance
function firstRainHour(hourly) {
  return hourly.find(h => (h.rainChance != null && h.rainChance >= 50) || h.indoor && /rain|shower|drizzle|thunder/i.test(h.condition))
}

function fmtHour(h) {
  if (h === 0) return '12am'
  if (h === 12) return '12pm'
  return h < 12 ? `${h}am` : `${h - 12}pm`
}

function buildInsight(cur, curCode, hourly) {
  const rain = firstRainHour(hourly)
  if (/rain|shower|drizzle|thunder/i.test(curCode.label)) return 'Raining now — indoor stops are the move.'
  if (rain) return `Rain expected around ${fmtHour(rain.hour)} — plan indoor stops for later.`
  if (cur.temperature_2m <= 5) return 'Cold out — keep plans cosy and indoors.'
  if (cur.wind_speed_10m >= 35) return 'Windy out there — sheltered spots are better.'
  if (/clear/i.test(curCode.label) && cur.temperature_2m >= 16) return 'Lovely out — great for outdoor spots and walks.'
  return null // nothing notable; UI just shows temp + condition
}

// Structured hint the AI planner uses to bias venue choice
function buildPlanningHint(cur, curCode, hourly) {
  const rain = firstRainHour(hourly)
  const rainingNow = /rain|shower|drizzle|thunder/i.test(curCode.label)
  const cold = cur.temperature_2m <= 5
  const windy = cur.wind_speed_10m >= 35
  const nice = /clear|sunny/i.test(curCode.label) && cur.temperature_2m >= 16 && !rain

  let mode = 'neutral', note = ''
  if (rainingNow || rain) {
    mode = 'indoor'
    note = rainingNow ? 'rain now, so this plan keeps you mostly indoors'
                      : `rain expected around ${fmtHour(rain.hour)}, so later stops lean indoors`
  } else if (cold || windy) {
    mode = 'indoor'
    note = cold ? 'cold out, so this plan stays warm and indoors' : 'windy out, so this plan avoids exposed spots'
  } else if (nice) {
    mode = 'outdoor'
    note = 'lovely weather, so this plan makes the most of the outdoors'
  }
  return { mode, note, temp: Math.round(cur.temperature_2m), condition: curCode.label }
}

module.exports = { getWeather, weatherCacheKey }
