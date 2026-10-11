const {test}=require('node:test'),assert=require('node:assert/strict')
const {sameVenue,identityName,canonicalVenueId}=require('../src/services/venueIdentity')
const {mergeProfileRows}=require('../src/services/mergeVenues')
const {deduplicate}=require('../src/services/dedup')
test('matching separates branches, embedded cafes and near-name neighbours',()=>{
 const a={name:'The Farmers Arms',lat:53.4,lng:-2.98,category_slug:'pub',address:'12 Duke Street'}
 assert(sameVenue(a,{...a,name:'Farmers Arms',lng:-2.9801}))
 assert(!sameVenue(a,{...a,address:'14 Duke Street'}))
 assert(!sameVenue(a,{...a,lat:53.402}))
 assert(!sameVenue({...a,name:'Museum'}, {...a,name:'Museum Cafe',category_slug:'cafe'}))
 assert(!sameVenue(a,{...a,name:'The Farm Arms'}))
 assert.notEqual(identityName('鸿运来酒家'),identityName('另一家餐厅'))
})
test('provider clustering does not chain across distinct nearby sites',()=>{
 const a={name:'Example',lat:53.4,lng:-2.98,category:'cafe',provider:'osm'}
 const clusters=deduplicate([a,{...a,lat:53.4002,provider:'google'},{...a,lat:53.4004,provider:'foursquare'}])
 assert.equal(clusters.length,2)
})
test('merge preserves galleries, fills missing menus, keeps rating counts rather than doubling them',()=>{
 const a={id:1,name:'Cafe',city:'Liverpool',photos:[{url:'https://example.com/a'}],rating:4.5,rating_count:100,google_place_id:'same',claimed:false}
 const b={...a,id:2,city:'Liverpool Area',photos:[{url:'https://example.com/a'},{url:'https://example.com/b'}],menu_url:'https://example.com/menu',claimed:true}
 const merged=mergeProfileRows(a,b,1)
 assert.equal(merged.id,1);assert.equal(merged.city,'Liverpool');assert.equal(merged.photos.length,2);assert.equal(merged.menu_url,b.menu_url);assert.equal(merged.rating_count,100);assert(merged.claimed)
 const conflict=mergeProfileRows(a,{...b,claimed:false,google_place_id:'unrelated',photos:[{url:'wrong'}],website:'https://wrong.com'},1)
 assert.equal(mergeProfileRows({...a,claimed:true},{...b,name:'Unclaimed import',claimed:false},2).name,'Cafe')
 assert.equal(conflict.photos.length,1);assert.equal(conflict.website,undefined)
})
test('old profile IDs resolve without changing valid IDs or querying for absent IDs',async()=>{
 const query=async(_,[id])=>({rows:id===2?[{canonical_id:1}]:[]})
 assert.equal(await canonicalVenueId(2,query),1);assert.equal(await canonicalVenueId(3,query),3);assert.equal(await canonicalVenueId(null,()=>{throw Error('query')}),null)
})
