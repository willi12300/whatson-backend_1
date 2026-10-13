const test=require('node:test'),assert=require('node:assert/strict')
const {normaliseForecast}=require('../src/clients/weather')
test('hourly forecasts retain UTC timestamps and destination timezone for event planning',()=>{
 const t=Date.parse('2026-10-13T19:00:00Z')/1000
 const w=normaliseForecast({timezone:'Europe/London',current:{time:t,temperature_2m:12,weather_code:0,wind_speed_10m:10,precipitation:0},hourly:{time:[t,t+3600,t+2*86400],temperature_2m:[12,11,10],weather_code:[0,61,3],precipitation_probability:[0,80,10],wind_speed_10m:[10,20,5]},daily:{sunset:[t-7200]}})
 assert.equal(w.hourly[0].time,'2026-10-13T19:00:00.000Z');assert.equal(w.hourly[0].hour,20);assert.equal(w.hourly[1].rainChance,80);assert.equal(w.hourly[1].windSpeed,20);assert.equal(w.hourly.length,3);assert.match(w.sunsets[0],/Z$/)
})
