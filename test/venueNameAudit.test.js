const {test}=require('node:test'),assert=require('node:assert/strict')
const {providerIdentity}=require('../src/services/providerIdentity')
const {assessVenue,refreshVenueNameAudit}=require('../src/services/venueNameAudit')
const {applyVenueLinkPolicy}=require('../src/services/venueLinkPolicy')
test('Cabin and Cavern cannot match just because they share Club, even at the same location',()=>{
 assert.equal(providerIdentity({name:'The Cabin Club',lat:53.4,lng:-2.9},{name:'The Cavern Club',lat:53.4,lng:-2.9}).matched,false)
 assert.equal(providerIdentity({name:'The Cavern Pub',lat:53.4,lng:-2.9},{name:'The Cavern Club',lat:53.4,lng:-2.9}).matched,false)
})
test('every cached source is checked and missing evidence is never certified',()=>{
 const venue={id:9999,name:'Real Place',lat:53.4,lng:-2.9}
 assert.equal(assessVenue(venue).status,'needs_review')
 assert.equal(assessVenue({...venue,provider_identities:[{name:'Real Place',lat:53.4,lng:-2.9},{name:'Unrelated Place',lat:53.4,lng:-2.9}]}).status,'identity_conflict')
 assert.equal(assessVenue({...venue,provider_identities:[{name:'Real Place'}]}).status,'needs_review')
})
test('full database scan quarantines contaminated cache without changing original business identity',async()=>{
 const v={id:9999,name:'Real Place',lat:53.4,lng:-2.9,provider_identities:[{name:'Unrelated Place',provider:'google',lat:53.4,lng:-2.9}]}
 const report=await refreshVenueNameAudit(async()=>({rows:[v,{id:10000,name:'No evidence'}]}))
 assert.equal(report.counts.venues,2);assert.equal(report.counts.identity_conflict,1);assert.equal(report.counts.needs_review,1)
 const result=applyVenueLinkPolicy({...v,photos:['wrong'],rating:5,facebook:'https://facebook.com/wrong'})
 assert.equal(result.name,'Real Place');assert.deepEqual(result.photos,[]);assert.equal(result.rating,null);assert.equal(result.facebook,null)
 assert.equal(applyVenueLinkPolicy({...v,name:'Repurposed ID',rating:5}).rating,5)
})
test('known Cabin record never shows Cavern provider data',()=>{
 const out=applyVenueLinkPolicy({id:7091,name:'The Cabin Club',lat:53.4017584,lng:-2.9761604,cover_photo:'cavern.jpg',website:'https://www.cavernclub.com/',facebook:'https://facebook.com/cavernclubliverpool',instagram:'https://instagram.com/CavernLiverpool',google_place_id:'ChIJydGcNC4he0gROPWMqQwzUDs'})
 assert.equal(out.name,'The Cabin Club');assert.equal(out.cover_photo,null);assert.equal(out.website,null);assert.equal(out.facebook,null);assert.equal(out.instagram,null);assert.equal(out.google_place_id,null)
})
test('catalogue screening finds reused Google photos across different venue names',()=>{
 const {auditNames}=require('../scripts/audit-venue-names')
 const rows=[{id:1,name:'Real Club',photos:['https://api.example/media/google-photo?name=places%2Fabc%2Fphotos%2Fxyz']},{id:2,name:'Wrong Business',cover_photo:'https://api.example/media/google-photo?name=places%2Fabc%2Fphotos%2Fother'},{id:3,name:'No provider evidence'}]
 const result=auditNames(rows,false)
 assert.deepEqual(result[0].shared_identity_venue_ids,[2]);assert.equal(result[0].flagged,true)
 assert.equal(result[2].status,'needs_review');assert.equal(result[2].flagged,false)
 assert.match(result[2].provider_coverage,/not available/)
})
test('sync cannot rename an existing venue through a contaminated Google association',async()=>{
 const {pool}=require('../src/db/pool'),original=pool.connect;const statements=[]
 pool.connect=async()=>({release(){},async query(sql){statements.push(sql);if(sql.startsWith('SELECT venue_id'))return {rows:[{venue_id:7091}]};if(sql.startsWith('SELECT id,name'))return {rows:[{id:7091,name:'The Cabin Club',lat:53.4017584,lng:-2.9761604}]};return {rows:[]}}})
 try{await assert.rejects(require('../src/services/sync').upsertVenue({name:'The Cavern Club',lat:53.4062,lng:-2.988,sources:[{provider:'google',providerId:'bad-existing-association'}]},'Liverpool'),/identity conflicts/);assert.equal(statements.some(s=>s.startsWith('UPDATE venues')),false);assert.equal(statements.includes('ROLLBACK'),true)}finally{pool.connect=original}
})
