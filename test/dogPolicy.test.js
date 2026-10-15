const test=require('node:test'),assert=require('node:assert/strict')
const {googleDogPolicy}=require('../src/services/dogPolicy')
const now=Date.parse('2026-10-15T12:00Z'),url='https://maps.google.com/'
test('dog policy uses explicit true/false without inferring indoor access',()=>{
 const source={provider:'google',allows_dogs:true,dog_checked_at:'2026-10-15T10:00Z'}
 assert.deepEqual(googleDogPolicy([source],url,now),{status:'welcome',evidence:'Google Places',sourceUrl:url,checkedAt:source.dog_checked_at})
 assert.equal(googleDogPolicy([{...source,allows_dogs:false}],url,now).status,'no')
})
test('missing, undated, stale, future and non-boolean dog data remains unknown',()=>{
 for(const source of [{},{provider:'google',allows_dogs:'true',dog_checked_at:'2026-10-15'},{provider:'google',allows_dogs:true},{provider:'google',allows_dogs:true,dog_checked_at:'2026-01-01'},{provider:'google',allows_dogs:true,dog_checked_at:'2026-10-16'}])assert.deepEqual(googleDogPolicy([source],url,now),{status:'unknown'})
 assert.deepEqual(googleDogPolicy([],url,now),{status:'unknown'})
})
