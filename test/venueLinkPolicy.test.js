const {test}=require('node:test'),assert=require('node:assert/strict')
const {providerIdentity}=require('../src/services/providerIdentity')
const {applyVenueLinkPolicy,sanitiseVenueLinks,urlKey}=require('../src/services/venueLinkPolicy')
test('provider enrichment requires both business name and branch location',()=>{
 const v={name:"Ferraiolo's Italian Bistro",lat:53.38345,lng:-2.9390444}
 assert.equal(providerIdentity(v,{name:'Villa Romana',lat:53.4,lng:-2.98}).matched,false)
 const branch={name:"McCooley's Concert Square",lat:53.40329,lng:-2.97993}
 assert.equal(providerIdentity(branch,{name:'McCooley’s Concert Square',lat:53.4033,lng:-2.9799}).matched,true)
 assert.equal(providerIdentity(branch,{name:'McCooley’s',lat:53.4066,lng:-2.98668}).matched,false)
 assert.equal(providerIdentity(v,{name:v.name}).matched,false)
})
test('quarantined Ferraiolos cannot expose Villa Romana links/photos/menu or provider identity anywhere',()=>{
 const v={id:7253,name:"Ferraiolo's Italian Bistro",category_slug:'restaurant',lat:53.38345,lng:-2.9390444,website:'https://www.villaromanaliverpool.co.uk/',menu_url:'https://www.villaromanaliverpool.co.uk/',cover_photo:'wrong.jpg',photos:['wrong.jpg'],google_place_id:'wrong',google_maps_url:'https://google.com/wrong',rating:4.5,description:'Wrong restaurant',opening_hours:{weekday_text:['Wrong hours']},facebook:'https://facebook.com/wrong'}
 const result=applyVenueLinkPolicy(v)
 for(const key of ['website','menu_url','cover_photo','google_place_id','google_maps_url','rating','description','opening_hours','facebook'])assert.equal(result[key],null,key)
 assert.deepEqual(result.photos,[]);assert.equal(result.name,v.name);assert.equal(result.lat,v.lat);assert.equal(result.link_identity_status,'quarantined')
 assert.equal(v.website,'https://www.villaromanaliverpool.co.uk/')
 assert.equal(sanitiseVenueLinks({venues:[v]}).venues[0].website,null)
 assert.notEqual(sanitiseVenueLinks({...v,name:'A different venue'}).link_identity_status,'quarantined')
})
test('malformed unsafe URLs are never returned as venue website actions',()=>{
 assert.equal(urlKey('javascript:alert(1)'),null);assert.equal(urlKey('https://user:pass@example.com/'),null)
 assert.equal(applyVenueLinkPolicy({id:42,name:'Real venue',website:'javascript:alert(1)'}).website,null)
})

test('response filtering preserves source timestamps',()=>{const at=new Date('2026-10-22T00:00:00Z');const result=sanitiseVenueLinks({checked_at:at,venues:[]});assert.equal(result.checked_at,at);assert.equal(JSON.parse(JSON.stringify(result)).checked_at,at.toISOString())})

test('a website/menu-only audit does not falsely certify or remove unaudited social accounts',()=>{
 const audit=require('../data/venue-link-audit.json'),before={enforce_verified:audit.enforce_verified,enforce_verified_fields:audit.enforce_verified_fields}
 try{
  audit.enforce_verified=true;audit.enforce_verified_fields=['website','menu_url']
  const v=applyVenueLinkPolicy({id:999999,name:'A real pub',website:'https://pub.example/',menu_url:'https://pub.example/menu',facebook:'https://facebook.com/pub',instagram:'@pub'})
  assert.equal(v.website,null);assert.equal(v.menu_url,null);assert.equal(v.facebook,'https://facebook.com/pub');assert.equal(v.instagram,'https://www.instagram.com/pub')
  assert.equal(v.link_verification.fields.facebook.status,'not_audited')
 }finally{Object.assign(audit,before)}
})

test('quarantine cannot leak cached photos or ratings through alternate provider fields',()=>{
 const v=applyVenueLinkPolicy({id:7253,name:"Ferraiolo's Italian Bistro",category_slug:'restaurant',photo_url:'wrong-photo',image_url:'wrong-photo',tripadvisorRating:4.9,tripadvisorReviews:100,googleRating:4.8,googleMapsUrl:'https://maps.google.com/wrong',topReview:{text:'Wrong venue'}})
 for(const k of ['photo_url','image_url','tripadvisorRating','tripadvisorReviews','googleRating','googleMapsUrl','topReview'])assert.equal(v[k],null,k)
})
