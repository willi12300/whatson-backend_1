const test=require('node:test'),assert=require('node:assert/strict')
const {DESTINATIONS,destinationName,inWales}=require('../src/services/destinations')
test('only four supported destinations; legacy locality labels consolidate',()=>{
 assert.deepEqual(DESTINATIONS.map(d=>d.name),['Liverpool','Manchester','Barcelona','Wales'])
 for(const name of ['Liverpool Area','liverpool-area','Waterloo','Frodsham'])assert.equal(destinationName(name),'Liverpool')
 assert.equal(destinationName('Dolgellau Area'),'Wales');assert.equal(destinationName('nearby',{lat:51.52,lng:-3.49}),'Wales')
})
test('Wales boundary includes Welsh towns and excludes nearby English cities',()=>{
 for(const [lat,lng] of [[52.75,-3.89],[53.045,-2.993],[51.4816,-3.1791],[53.2274,-4.1291]])assert.equal(inWales(lat,lng),true)
 for(const [lat,lng] of [[53.4084,-2.9916],[53.4808,-2.2426],[53.19,-2.89],[51.61,-2.65]])assert.equal(inWales(lat,lng),false)
 assert.equal(destinationName('Unknown place',{lat:53.44,lng:-2.98}),'Liverpool');assert.equal(destinationName('London',{lat:51.5,lng:-.1}),'London')
})
