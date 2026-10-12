const {test}=require('node:test')
const assert=require('node:assert/strict')
const {withFoodEvidence,venueSearchClause,searchWords}=require('../src/services/venueSearch')
test('checked food evidence is tied to the actual venue identity',()=>{
  const hippo=withFoodEvidence({id:7515,name:'Fat Hippo'})
  assert.deepEqual(hippo.food_keywords,['burger'])
  assert.equal(hippo.food_sources[0].url,'https://fathippo.co.uk/locations/liverpool/')
  assert.equal(withFoodEvidence({id:7515,name:'Unrelated restaurant'}).food_sources.length,0)
  assert.equal(withFoodEvidence({id:99,name:'Fat Hippo'}).food_keywords.length,0)
})
test('burger searches match metadata and reviewed venues without interpolating query text',()=>{
  const params=['Liverpool'],sql=venueSearchClause('burgers',params)
  assert(sql.includes('cuisine_type,menu_summary,dietary_options'))
  assert(sql.includes('unnest($3::integer[],$4::text[])'))
  assert.equal(params[1],'%burger%')
  assert(params.flat().includes(7515));assert(params.flat().includes(7064));assert(params.flat().includes(42))
  const injected=[],clause=venueSearchClause("burger' OR 1=1 --",injected)
  assert(!clause.includes("burger' OR"));assert(!clause.includes('--'))
  assert.equal(venueSearchClause('%___',[]),'FALSE')
  assert.deepEqual(searchWords('Burgers burgers'),['burger'])
})

test('the website/menu index supports arbitrary terms beyond the original burger list',()=>{
 const index=require('../data/venue-search-index.json')
 const catalogue=index.venues
 for(const term of ['pizza','curry','vegan','brunch']){
  const matched=catalogue.map(venue=>withFoodEvidence(venue,term)).filter(venue=>venue.food_keywords.includes(term))
  assert(matched.length>5,term)
  assert(matched.some(venue=>venue.search_evidence?.url&&venue.search_evidence.checked_at))
 }
 const params=[];const sql=venueSearchClause('pizzas',params)
 assert(params[1].length>20);assert(sql.includes('unnest'))
})
