const axios = require('axios')
const { query } = require('../db/pool')
const { config } = require('../config')
let sourceCache={prices:{}}
try{sourceCache=require('../../data/ticket-prices.json')}catch{}

function cachedListingPrice(url) {
  const price=sourceCache.prices[trustedListing(url)]
  if(!price)return null
  const age=Date.now()-Date.parse(price.checked_at)
  return age<6*3600000 ? price : age<7*86400000 ? {...price,status:'stale'} : null
}

function amount(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(String(value).replace(/[£,$€\s]/g, ''))
  return Number.isFinite(n) && n >= 0 ? n : null
}

function apiPricing(provider, raw = {}) {
  if (provider === 'ticketmaster') {
    const ranges = (raw.priceRanges || []).filter(range => amount(range.min) != null && /^[A-Z]{3}$/.test(range.currency || ''))
    const standard = ranges.filter(range => !range.type || range.type === 'standard')
    const range = (standard.length ? standard : ranges).sort((a,b) => amount(a.min) - amount(b.min))[0]
    return range ? { min_price: amount(range.min), currency: range.currency, source_kind: 'api', status: 'priced' } : null
  }
  const numeric = amount(raw.MinPrice ?? raw.minprice)
  if (numeric != null) return { min_price: numeric, currency: 'GBP', source_kind: 'api', status: 'priced' }
  const text = String(raw.entryprice || '').trim()
  if (/^(free|free entry|free admission)$/i.test(text)) return {min_price:0,currency:'GBP',source_kind:'api',status:'priced'}
  // Advertised text with currencies/conditions is displayed verbatim, never guessed.
  if (/£\s*\d/.test(text)) return { min_price: null, display_text: text.slice(0,160), currency:'GBP',source_kind:'api',status:'advertised' }
  return null
}

function pagePricing(html, sourceUrl, now = Date.now()) {
  const offers = []
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (!node || typeof node !== 'object') return
    if (String(node['@type'] || '').includes('Event')) {
      const types = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : []
      for (const offer of types) {
        if (offer['@type'] !== 'Offer' || !/^(?:https?:\/\/schema.org\/)?(?:InStock|LimitedAvailability)$/.test(offer.availability || '')) continue
        if (offer.validFrom && Date.parse(offer.validFrom) > now) continue
        if (offer.validThrough && Date.parse(offer.validThrough) < now) continue
        const price = amount(offer.price)
        if (price == null || !/^[A-Z]{3}$/.test(offer.priceCurrency || '')) continue
        offers.push({price,currency:offer.priceCurrency,name:String(offer.name || 'Ticket').slice(0,160)})
      }
    }
    if (node['@graph']) visit(node['@graph'])
  }
  const scripts = html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const match of scripts) { try { visit(JSON.parse(match[1])) } catch {} }
  // Don't headline restricted group/child/resale offers as a normal single ticket.
  const ordinary = offers.filter(offer => !/group|bundle|family|child|concession|student|resale|\d+\s*for\s*(?:the\s*price\s*of\s*)?\d+/i.test(offer.name))
  const selected = (ordinary.length ? ordinary : offers).sort((a,b) => a.price - b.price)[0]
  if (!selected) return null
  return { status:'priced',min_price:selected.price,currency:selected.currency,offer_name:selected.name,source_kind:'listing',source_url:sourceUrl,checked_at:new Date(now).toISOString(),offers:offers.filter(offer=>offer.currency===selected.currency).sort((a,b)=>a.price-b.price).slice(0,15) }
}

function trustedListing(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null
    return ['www.skiddle.com','skiddle.com','www.ticketmaster.co.uk','www.ticketmaster.com','ticketmaster.co.uk','ticketmaster.com'].includes(url.hostname) ? url.href : null
  } catch { return null }
}

const inFlight = new Map()
let active = 0
const queue = []
async function runLimited(fn) {
  if (active >= 3) await new Promise(resolve => queue.push(resolve))
  else active++
  try { return await fn() } finally { const next=queue.shift(); if(next) next(); else active-- }
}

async function refreshTicketPrice(event) {
  if (inFlight.has(event.id)) return inFlight.get(event.id)
  const work = runLimited(async () => {
    const url = trustedListing(event.ticket_url)
    let pricing = {status:'unavailable',reason:'no_published_price',checked_at:new Date().toISOString()}
    if (url) {
      try {
        let target=url,response
        for(let redirects=0;redirects<4;redirects++) {
          response=await axios.get(target,{timeout:6000,maxRedirects:0,maxContentLength:2*1024*1024,validateStatus:status=>status<400,headers:{'User-Agent':'SAPPO/1.0 (event ticket price lookup)'}})
          if(response.status<300)break
          target=trustedListing(new URL(response.headers.location,target).href)
          if(!target)throw new Error('unsupported_redirect')
        }
        pricing = pagePricing(String(response.data),url) || pricing
      } catch(error) {pricing.reason=error.response?.status?'listing_http_'+error.response.status:'listing_unavailable'}
      // The provider's detail API may publish a price omitted from search results.
      const skiddleId=new URL(url).hostname.includes('skiddle.com') && new URL(url).pathname.match(/\/(\d+)\/?$/)?.[1]
      if(pricing.status==='unavailable' && skiddleId && config.skiddle.key) {
        try {
          const response=await axios.get(`https://www.skiddle.com/api/v1/events/${skiddleId}/`,{params:{api_key:config.skiddle.key},timeout:6000})
          const raw=Array.isArray(response.data.results)?response.data.results[0]:response.data.results
          const fromApi=apiPricing('skiddle',raw||{})
          if(fromApi)pricing={...fromApi,source_url:url,checked_at:new Date().toISOString()}
        }catch{} // No key-bearing request details are logged or returned.
      }
    }
    await query('INSERT INTO event_ticket_prices(event_id,pricing,checked_at) VALUES($1,$2,now()) ON CONFLICT(event_id) DO UPDATE SET pricing=EXCLUDED.pricing,checked_at=now()', [event.id,JSON.stringify(pricing)])
    return pricing
  }).finally(() => inFlight.delete(event.id))
  inFlight.set(event.id,work)
  return work
}

function withTicketPricing(event) {
  const raw = event._price_source || {}
  const snapshots=[event._ticket_pricing,cachedListingPrice(event.ticket_url)].filter(price=>price?.status==='priced').sort((a,b)=>Date.parse(b.checked_at||0)-Date.parse(a.checked_at||0))
  const pricing = snapshots[0] || apiPricing(raw.provider,raw.data) || cachedListingPrice(event.ticket_url) || event._ticket_pricing
  const clean = {...event}; delete clean._price_source; delete clean._ticket_pricing; delete clean._price_checked_at
  if (pricing) {
    clean.pricing = pricing
    if (pricing.min_price != null) { clean.min_price=pricing.min_price;clean.is_free=pricing.min_price===0 }
  }
  return clean
}

const priceSelect = `ep.pricing AS _ticket_pricing,ep.checked_at AS _price_checked_at,
 (SELECT jsonb_build_object('provider',es.provider,'data',jsonb_build_object('MinPrice',es.raw->'MinPrice','minprice',es.raw->'minprice','entryprice',es.raw->'entryprice','priceRanges',es.raw->'priceRanges')) FROM event_sources es WHERE es.event_id=e.id LIMIT 1) AS _price_source`
const priceJoin = `LEFT JOIN event_ticket_prices ep ON ep.event_id=e.id AND ep.checked_at > now()-interval '6 hours' AND (ep.pricing->>'status'<>'unavailable' OR ep.pricing ? 'reason')`

module.exports = { amount,apiPricing,pagePricing,trustedListing,refreshTicketPrice,withTicketPricing,priceSelect,priceJoin }
