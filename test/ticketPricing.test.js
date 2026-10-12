const test=require('node:test'),assert=require('node:assert/strict')
const {amount,apiPricing,pagePricing,trustedListing,withTicketPricing}=require('../src/services/ticketPricing')

test('unknown prices are not free and provider currencies and zero amounts are retained',()=>{
  for(const value of [null,'',false,'TBC','£10 - £20'])assert.equal(amount(value),null)
  assert.equal(amount('£12.50'),12.5)
  assert.equal(apiPricing('ticketmaster',{priceRanges:[{min:0,currency:'GBP',type:'standard'}]}).min_price,0)
  assert.equal(apiPricing('ticketmaster',{priceRanges:[{min:50,currency:'EUR'}]}).currency,'EUR')
  assert.equal(apiPricing('skiddle',{entryprice:'Free entry'}).min_price,0)
  assert.equal(apiPricing('skiddle',{entryprice:'£12 + booking fee'}).display_text,'£12 + booking fee')
  assert.equal(apiPricing('skiddle',{}),null)
})

test('listing prices exclude sold-out and expired tiers and retain group and entry conditions',()=>{
  const offers=[
    {name:'Presale',price:'10',priceCurrency:'GBP',availability:'SoldOut'},
    {name:'Group Ticket',price:'17.10',priceCurrency:'GBP',availability:'InStock'},
    {name:'Early Entry Ticket',price:'22.50',priceCurrency:'GBP',availability:'https://schema.org/InStock'},
    {name:'Final Release',price:'28.50',priceCurrency:'GBP',availability:'InStock'},
    {name:'Expired Tier',price:'5',priceCurrency:'GBP',availability:'InStock',validThrough:'2026-01-01'},
  ].map(offer=>({'@type':'Offer',...offer}))
  const html='<script type="application/ld+json">'+JSON.stringify({'@type':'MusicEvent',offers})+'</script>'
  const result=pagePricing(html,'https://www.skiddle.com/event/1',Date.parse('2026-10-12'))
  assert.equal(result.min_price,22.5);assert.equal(result.offer_name,'Early Entry Ticket')
  assert.equal(result.offers.length,3)
  assert.equal(pagePricing('<html>Blocked</html>','https://www.ticketmaster.co.uk'),null)
})

test('only official HTTPS listings may be fetched; internal price source data is not returned',()=>{
  for(const url of ['http://www.skiddle.com','https://localhost/','https://www.skiddle.com.evil.test/','https://user:pass@www.skiddle.com/','https://www.skiddle.com:8443/'])assert.equal(trustedListing(url),null)
  assert.equal(trustedListing('https://www.skiddle.com/whats-on/Event/1/'),'https://www.skiddle.com/whats-on/Event/1/')
  const e=withTicketPricing({id:1,min_price:null,is_free:true,_ticket_pricing:{status:'priced',min_price:22.5,currency:'GBP'},_price_source:{},_price_checked_at:'today'})
  assert.equal(e.min_price,22.5);assert.equal(e.is_free,false);assert.ok(!('_price_source' in e))
})
