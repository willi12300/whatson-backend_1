const test=require('node:test'),assert=require('node:assert/strict')
const {extractVenueDescription,identity,excerpt}=require('../src/services/profileDescriptions')
test('venue descriptions require matching source identity and exclude blocked/cookie text',()=>{
  const description='Maray serves sharing plates inspired by Middle Eastern flavours, with a selection of wines and cocktails on its own published menu.'
  const html=`<title>Maray</title><meta name="description" content="${description}">`
  assert.deepEqual(extractVenueDescription(html,'Maray'),[description])
  assert.deepEqual(extractVenueDescription(html,'Another Restaurant'),[])
  assert.deepEqual(extractVenueDescription('<title>Maray</title><meta name="description" content="Accept cookies to enable Javascript and read all the information published on our website about this venue.">','Maray'),[])
})
test('renaming or changing the website invalidates just the source excerpt identity',()=>{
  const venue={id:7041,name:'Maray',website:'https://maray.co.uk/'}
  assert.notEqual(identity(venue),identity({...venue,website:'https://new.example/'}))
  assert.notEqual(identity(venue),identity({...venue,name:'New restaurant'}))
  assert.equal(identity(venue),identity({...venue,photos:['new-photo'],rating:4.8}))
  assert.ok(excerpt(Array(200).fill('word').join(' ')).split(' ').length<=100)
})

test('a cache hit avoids requests, while website changes and expiry refresh only the excerpt',async()=>{
  const db=require('../src/db/pool'),axios=require('axios')
  const originalQuery=db.query,originalGet=axios.get
  const venue={id:7041,name:'Maray',website:'https://maray.co.uk/',photos:['keep-photo']}
  let cached=null,expired=false,requests=0
  db.query=async(sql,params)=>{
    if(sql.startsWith('SELECT id,name,website'))return {rows:[venue]}
    if(sql.startsWith('SELECT source_url'))return {rows:cached&&!expired&&cached.identity===params[1]?[cached]:[]}
    assert.ok(sql.startsWith('INSERT INTO venue_description_sources'),'no canonical profile may be changed')
    cached={identity:params[1],source_url:params[2],paragraphs:JSON.parse(params[3]),checked_at:new Date()}
    expired=false;return {rows:[]}
  }
  axios.get=async()=>{requests++;return {status:200,data:'<title>Maray</title><meta name="description" content="Maray serves sharing plates inspired by Middle Eastern flavours, with wines and cocktails offered on its own published menu.">'} }
  delete require.cache[require.resolve('../src/services/profileDescriptions')]
  try{
    const {venueDescription}=require('../src/services/profileDescriptions')
    assert.equal((await venueDescription(7041)).status,'ready')
    await venueDescription(7041);assert.equal(requests,1)
    venue.website='https://maray.co.uk/book/'
    await venueDescription(7041);assert.equal(requests,2)
    expired=true;await venueDescription(7041);assert.equal(requests,3)
    assert.deepEqual(venue.photos,['keep-photo'])
  }finally{db.query=originalQuery;axios.get=originalGet}
})

test('source snapshots reject renamed venues, changed branches and stale checks',()=>{
 const {sourceFor,distance}=require('../src/services/descriptionSources')
 const now=Date.parse('2026-10-12T12:00:00Z')
 const venue={id:121,name:'The Otterspool Promenade',website:null,address:'Otterspool Dr'}
 const source={...venue,paragraphs:['A riverside promenade along the Mersey with views over the water and adjoining woodland paths for a longer walk.'],source_url:'https://www.creativetourist.com/venue/otterspool-promenade/',source_label:'Creative Tourist',checked_at:'2026-10-12T11:00:00Z'}
 assert.equal(sourceFor(venue,[source],now).source_label,'Creative Tourist')
 for(const changed of [{name:'Other place'},{address:'Different branch'},{website:'https://new.example/'}])assert.equal(sourceFor({...venue,...changed},[source],now),null)
 assert.equal(sourceFor(venue,[{...source,checked_at:'2026-08-01T00:00:00Z'}],now),null)
 assert.equal(sourceFor(venue,[{...source,checked_at:'invalid'}],now),null)
 assert.equal(distance(null,0,0,0),Infinity)
 assert.ok(distance(53.36347,-2.93428,53.36441,-2.93573)<200)
 assert.ok(distance(53.36347,-2.93428,53.48,-2.24)>30000)
})
test('non-descriptive listing boilerplate and schedules do not count as introductions',()=>{
 const {usable}=require('../src/services/descriptionSources')
 assert.equal(usable(['List entry 1000999. Grade I Park and Garden: Sefton Park. May include summary, reasons for designation and history.']),false)
 assert.equal(usable(['Come down to our restaurant which is now open every day from 12:00 to 23:00.']),false)
})

test('indexed landmarks describe the place rather than repeating a broad category',()=>{
 const sources=require('../data/venue-descriptions.json').venues
 const obelisk=sources.find(v=>v.id===6250),promenade=sources.find(v=>v.id===121)
 assert.match(obelisk.paragraphs.join(' '),/Samuel Smith/)
 assert.match(obelisk.paragraphs.join(' '),/1909/)
 assert.doesNotMatch(obelisk.paragraphs.join(' '),/is a park on/)
 assert.match(promenade.paragraphs.join(' '),/Mersey/)
 assert.match(promenade.paragraphs.join(' '),/Wirral/)
 assert.equal(require('../src/services/profileDescriptions').text('John&#039;s and Liverpool&#x27;s'),'John\'s and Liverpool\'s')
})

test('missing website descriptions can use published source summaries without inventing review-based copy',()=>{
 const {recordedDescription}=require('../src/services/profileDescriptions'),now=Date.parse('2026-10-13T12:00:00Z')
 const venue={id:1,name:'Example Cafe',address:'Liverpool',google_place_id:'real-place'}
 const row={provider:'google',provider_id:'real-place',created_at:'2026-10-12T12:00:00Z',raw:{displayName:{text:'Example Cafe'},editorialSummary:{text:'A cafe serving seasonal dishes and freshly baked pastries in a restored building in the centre of Liverpool.'}}}
 assert.equal(recordedDescription(venue,[row],now).source_label,'Google Maps published summary')
 assert.equal(recordedDescription({...venue,name:'Different',google_place_id:'other'},[row],now),null)
 assert.equal(recordedDescription(venue,[{...row,created_at:'2020-01-01'}],now),null)
 assert.equal(recordedDescription(venue,[{...row,raw:{reviews:[{text:'Best cafe in the world'}]}}],now),null)
})
