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
