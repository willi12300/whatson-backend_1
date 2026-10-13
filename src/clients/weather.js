// src/clients/weather.js
// Open-Meteo weather client with in-memory cache + rate-limit cooldown.
// Prevents homepage/plan/roulette from hammering weather API and causing 429 spam.

const axios = require('axios')
const logger = require('../utils/logger')

const FRESH_MS = 20 * 60 * 1000       // 20 mins fresh cache
const STALE_MS = 6 * 60 * 60 * 1000   // 6 hours stale fallback
const COOLDOWN_MS = 15 * 60 * 1000    // after 429/timeout, avoid live calls for 15 mins

const cache = new Map()       // key -> { data, fetchedAt }
const inFlight = new Map()    // key -> Promise
const cooldown = new Map()    // key -> timestamp until live calls are blocked
let globalCooldownUntil = 0

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
const code = (c,isDay) => {
  const result=WMO[c] || { label: 'Unknown', icon: '🌡️', indoor: false }
  if(isDay===0||isDay===false){
    const icon=[0,1,2].includes(Number(c))?'🌙':[51,53,61,80].includes(Number(c))?'🌧️':result.icon
    return {...result,icon}
  }
  return result
}

function weatherKey(lat, lng) {
  // Round to ~1km-ish. Prevents one moving phone from creating endless cache keys.
  const la = Number(lat).toFixed(2)
  const lo = Number(lng).toFixed(2)
  return `${la},${lo}`
}

function withMeta(data, meta) {
  return {
    ...data,
    meta: {
      ...(data.meta || {}),
      ...meta,
    },
  }
}

function fallbackWeather(lat, lng, reason = 'fallback') {
  // Safe soft fallback so UI works even when provider is rate limited before any cache exists.
  const temp = 15
  const condition = 'Weather updating'
  const data = {
    current: {
      temp,
      condition,
      icon: '🌡️',
      windSpeed: null,
      precipitation: null,
    },
    hourly: [],
    insight: 'Weather is updating — recommendations still use your location.',
    planningHint: { mode: 'neutral', note: 'weather unavailable, so recommendations stay balanced', temp, condition },
  }
  return withMeta(data, {
    source: 'fallback',
    reason,
    cached: false,
    stale: false,
    key: weatherKey(lat, lng),
  })
}

async function getWeather(lat, lng, opts = {}) {
  const key = weatherKey(lat, lng)
  const now = Date.now()
  const cached = cache.get(key)

  if (!opts.force && cached && now - cached.fetchedAt < FRESH_MS) {
    return withMeta(cached.data, { source: 'cache', cached: true, stale: false, key })
  }

  const blockedUntil = Math.max(cooldown.get(key) || 0, globalCooldownUntil || 0)
  if (!opts.force && blockedUntil > now) {
    if (cached && now - cached.fetchedAt < STALE_MS) {
      return withMeta(cached.data, { source: 'cache', cached: true, stale: true, key, cooldownUntil: blockedUntil })
    }
    return fallbackWeather(lat, lng, 'weather_provider_cooldown')
  }

  if (!opts.force && inFlight.has(key)) {
    return inFlight.get(key)
  }

  const promise = fetchWeatherLive(lat, lng)
    .then(data => {
      cache.set(key, { data, fetchedAt: Date.now() })
      return withMeta(data, { source: 'live', cached: false, stale: false, key })
    })
    .catch(err => {
      const status = err?.response?.status
      const msg = err?.message || 'weather error'
      // Avoid repeated live weather calls after provider rate-limit/timeout/network problems.
      if (status === 429 || /timeout|ECONN|ENOTFOUND|rate/i.test(msg)) {
        const until = Date.now() + COOLDOWN_MS
        cooldown.set(key, until)
        if (status === 429) globalCooldownUntil = Math.max(globalCooldownUntil, until)
        logger.warn(`[weather] provider unavailable (${status || msg}); using cache/fallback for ${key}`)
      } else {
        logger.warn(`[weather] provider error (${status || msg}); using cache/fallback for ${key}`)
      }

      const latest = cache.get(key)
      if (latest && Date.now() - latest.fetchedAt < STALE_MS) {
        return withMeta(latest.data, { source: 'cache', cached: true, stale: true, key, error: status || msg })
      }
      return fallbackWeather(lat, lng, status === 429 ? 'rate_limited' : msg)
    })
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, promise)
  return promise
}

async function fetchWeatherLive(lat, lng) {
  const url = 'https://api.open-meteo.com/v1/forecast'
  const res = await axios.get(url, {
    params: {
      latitude: lat, longitude: lng,
      current: 'temperature_2m,weather_code,wind_speed_10m,precipitation,is_day',
      hourly: 'temperature_2m,weather_code,precipitation_probability,wind_speed_10m,precipitation,is_day',
      daily: 'sunrise,sunset',
      timeformat: 'unixtime',
      forecast_days: 7, timezone: 'auto',
    },
    timeout: 8000,
  })
  return normaliseForecast(res.data)
}

function normaliseForecast(d) {
  const cur=d.current,curCode=code(cur.weather_code,cur.is_day),timeZone=d.timezone||'Europe/London'
  const times=d.hourly.time
  const timestamp=value=>typeof value==='number'?new Date(value*1000).toISOString():value
  const currentAt=typeof cur.time==='number'?cur.time:Date.parse(cur.time)/1000
  const hourly=[]
  for(let i=0;i<times.length;i++){
    if(typeof times[i]==='number'&&times[i]<currentAt-3600)continue
    const wc=code(d.hourly.weather_code[i],d.hourly.is_day?.[i]),time=timestamp(times[i])
    hourly.push({time,isDay:d.hourly.is_day?.[i]===0?false:d.hourly.is_day?.[i]===1?true:null,hour:Number(new Intl.DateTimeFormat('en-GB',{timeZone,hour:'2-digit',hourCycle:'h23'}).format(new Date(time))),temp:Math.round(d.hourly.temperature_2m[i]),condition:wc.label,icon:wc.icon,indoor:wc.indoor,rainChance:d.hourly.precipitation_probability?.[i]??null,windSpeed:d.hourly.wind_speed_10m?.[i]??null,precipitation:d.hourly.precipitation?.[i]??null})
  }
  return {timezone:timeZone,fetched_at:new Date().toISOString(),current:{time:timestamp(cur.time),isDay:cur.is_day===0?false:cur.is_day===1?true:null,temp:Math.round(cur.temperature_2m),condition:curCode.label,icon:curCode.icon,windSpeed:Math.round(cur.wind_speed_10m),precipitation:cur.precipitation},hourly,sunrises:(d.daily?.sunrise||[]).map(timestamp),sunsets:(d.daily?.sunset||[]).map(timestamp),insight:buildInsight(cur,curCode,hourly.slice(0,12)),planningHint:buildPlanningHint(cur,curCode,hourly.slice(0,12))}
}

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
  return null
}

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

module.exports = { getWeather, normaliseForecast }
