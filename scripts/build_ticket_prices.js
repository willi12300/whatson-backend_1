// Public listing facts only; no provider keys or customer/ticket-holder data.
const fs=require('fs'),path=require('path'),axios=require('axios')
const {pagePricing,trustedListing}=require('../src/services/ticketPricing')

async function build() {
  const endpoint='https://whatson-backend1-production.up.railway.app/events'
  const venues=[];let offset=0
  const to=new Date(Date.now()+60*86400000).toISOString()
  async function catalogue(params) {
    for(let attempt=0;attempt<12;attempt++) {
      try {return await axios.get(endpoint,{params,timeout:15000})}
      catch(error){if(attempt===11)throw error;await new Promise(resolve=>setTimeout(resolve,5000))}
    }
  }
  for(;;){
    const {data}=await catalogue({city:'Liverpool',limit:500,offset,to})
    if(!Array.isArray(data.events))throw new Error('Event catalogue unavailable')
    venues.push(...data.events)
    if(!data.has_more)break
    offset=data.next_offset
  }
  const urls=[...new Set(venues.map(event=>trustedListing(event.ticket_url)).filter(Boolean))]
  const prices={};let cursor=0,checked=0,ticketmasterDenied=false
  await Promise.all(Array.from({length:4},async()=>{
    while(cursor<urls.length) {
      const url=urls[cursor++]
      if(new URL(url).hostname.includes('ticketmaster') && ticketmasterDenied)continue
      try {
        const {data}=await axios.get(url,{timeout:6000,maxRedirects:0,maxContentLength:2*1024*1024,headers:{'User-Agent':'SAPPO/1.0 (event ticket price lookup)'}})
        const price=pagePricing(String(data),url)
        if(price)prices[url]=price
      }catch(error){if(new URL(url).hostname.includes('ticketmaster') && [401,403].includes(error.response?.status))ticketmasterDenied=true}
      checked++
      if(checked%100===0)console.log(`Checked ${checked}; ${Object.keys(prices).length} priced listings`)
      await new Promise(resolve=>setTimeout(resolve,250))
    }
  }))
  const target=path.join(__dirname,'../data/ticket-prices.json')
  // Keep still-fresh records through temporary provider failures.
  try {
    const previous=JSON.parse(fs.readFileSync(target,'utf8')).prices||{}
    for(const [url,price] of Object.entries(previous))if(!prices[url] && Date.now()-Date.parse(price.checked_at)<6*3600000)prices[url]=price
  }catch{}
  fs.writeFileSync(target,JSON.stringify({checked_at:new Date().toISOString(),checked,prices},null,2)+'\n')
  console.log(`Saved ${Object.keys(prices).length} source-backed ticket prices`)
}
build().catch(error=>{console.error('Ticket price index failed:',error.response?.status||error.code||error.message);process.exit(1)})
