const test=require('node:test'),assert=require('node:assert/strict')
const {normaliseForecast}=require('../src/clients/weather')
test('hourly forecasts retain UTC timestamps and destination timezone for event planning',()=>{
 const t=Date.parse('2026-10-13T19:00:00Z')/1000
 const w=normaliseForecast({timezone:'Europe/London',current:{time:t,temperature_2m:12,weather_code:0,wind_speed_10m:10,precipitation:0},hourly:{time:[t,t+3600,t+2*86400],temperature_2m:[12,11,10],weather_code:[0,61,3],precipitation_probability:[0,80,10],wind_speed_10m:[10,20,5]},daily:{sunset:[t-7200]}})
 assert.equal(w.hourly[0].time,'2026-10-13T19:00:00.000Z');assert.equal(w.hourly[0].hour,20);assert.equal(w.hourly[1].rainChance,80);assert.equal(w.hourly[1].windSpeed,20);assert.equal(w.hourly.length,3);assert.match(w.sunsets[0],/Z$/)
})
test('daylight flags select moon icons at night for current weather and each forecast hour',()=>{
 const t=Date.parse('2026-10-13T22:00:00Z')/1000
 const d={timezone:'Europe/London',current:{time:t,temperature_2m:12,weather_code:0,is_day:0,wind_speed_10m:10,precipitation:0},hourly:{time:[t,t+3600,t+12*3600],temperature_2m:[12,11,15],weather_code:[0,61,0],is_day:[0,0,1],precipitation_probability:[0,80,0],wind_speed_10m:[10,20,5]},daily:{sunrise:[t-16*3600],sunset:[t-5*3600]}}
 const w=normaliseForecast(d)
 assert.equal(w.current.icon,'🌙');assert.equal(w.current.isDay,false);assert.equal(w.hourly[0].hour,23);assert.equal(w.hourly[0].icon,'🌙');assert.equal(w.hourly[1].icon,'🌧️');assert.equal(w.hourly[2].icon,'☀️');assert.equal(w.hourly[2].isDay,true);assert.equal(w.sunrises.length,1)
})
