#!/usr/bin/env node
// Complete public-catalogue audit. Does not infer ownership from HTTP 200 alone.
const fs=require('node:fs'),dns=require('node:dns').promises,net=require('node:net')
const BASE='https://whatson-backend1-production.up.railway.app'
const FIELDS=['website','menu_url','instagram','facebook','booking_url']
const normal=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim()
const generic=new Set('the and of at in on de la el le restaurant restaurants bar bars pub pubs cafe coffee shop bistro italian hotel inn ltd limited liverpool manchester wales barcelona united kingdom'.split(' '))
const directories=['tripadvisor.com','tripadvisor.co.uk','camra.org.uk','restaurantguru.com','restaurantguru.co.uk','placejuice.com','yell.com','facebook.com','instagram.com','google.com','goo.gl']
const key=s=>{try{const u=new URL(s);u.hash='';return u.href.replace(/\/$/,'')}catch{return String(s||'')}}
const host=s=>{try{return new URL(s).hostname.replace(/^www\./,'')}catch{return ''}}
const social=(field,s)=>['instagram','facebook'].includes(field)&&/^@?[a-z0-9._]+$/i.test(s)&&!s.includes(field+'.com')?'https://www.'+field+'.com/'+s.replace(/^@/,''):s
const strip=s=>String(s||'').replace(/<script\b[\s\S]*?<\/script>/gi,' ').replace(/<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&#39;|&apos;/g,"'").replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim()
function publicIP(ip){if(ip==='::1'||ip==='::'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80:')||ip.includes('::ffff:'))return false;if(net.isIP(ip)===4){const [a,b]=ip.split('.').map(Number);return a!==0&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b>=16&&b<=31)&&!(a===192&&b===168)&&!(a===100&&b>=64&&b<=127)}return net.isIP(ip)===6}
async function safe(s){try{const u=new URL(s);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||!u.hostname.includes('.')||u.hostname.endsWith('.local')||u.hostname.endsWith('.internal'))return false;const found=await dns.lookup(u.hostname,{all:true});return found.length&&found.every(x=>publicIP(x.address))}catch{return false}}
async function page(url){
 const out={url,final_url:url,http_status:null,title:'',heading:'',text:'',links:[],pdf:false,checked_at:new Date().toISOString()}
 try{
  const signal=AbortSignal.timeout(10000)
  for(let i=0;i<5;i++){
   if(!await safe(url)){out.error='unsafe_or_unresolvable_host';return out}
   const r=await fetch(url,{redirect:'manual',signal,headers:{'User-Agent':'SAPPO-LinkAudit/1.0 (+https://sappo-frontend.vercel.app)'}})
   if([301,302,303,307,308].includes(r.status)){url=new URL(r.headers.get('location'),url).href;await r.body?.cancel();continue}
   out.http_status=r.status;out.final_url=url
   if(r.status!==200){out.error='http_error';await r.body?.cancel();return out}
   const reader=r.body.getReader();let size=0,parts=[]
   while(size<800000){const {value,done}=await reader.read();if(done)break;size+=value.length;parts.push(Buffer.from(value))}
   await reader.cancel().catch(()=>{})
   const data=Buffer.concat(parts);if(data.subarray(0,4).toString()==='%PDF'){out.pdf=true;return out}
   const html=data.toString('utf8')
   out.title=strip(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]||'').slice(0,500)
   out.heading=[...html.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)].map(m=>strip(m[1])).join(' ').slice(0,2500)
   out.text=strip(html).slice(0,70000)
   for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){try{out.links.push([new URL(m[1].replace(/&amp;/g,'&'),url).href,strip(m[2]).slice(0,100)])}catch{}if(out.links.length>=350)break}
   return out
  }
  out.error='redirect_limit'
 }catch(e){out.error=e.name}
 return out
}
function owner(v,p){
 if(p?.http_status!==200||p.pdf)return [false,'Page could not establish venue ownership']
 const h=host(p.final_url)
 if(directories.some(d=>h===d||h.endsWith('.'+d)))return [false,'Directory/social page is not a confirmed venue-owned website']
 const words=normal(v.name).split(' ').filter(w=>w.length>2&&!generic.has(w))
 if(!words.length)return [false,'Name too generic for automated ownership verification']
 const title=normal(p.title+' '+p.heading),domain=normal(h.split('.')[0]).replace(/ /g,''),body=normal(p.text)
 const strong=words.some(w=>w.length>=5&&title.split(' ').includes(w)&&domain.includes(w))
 const full=words.every(w=>title.split(' ').includes(w)),whole=words.join(''),postcode=normal(v.address).match(/\b[a-z]{1,2}[0-9][a-z0-9]? [0-9][a-z]{2}\b/)?.[0]
 if(strong||full&&whole.length>=5&&domain.includes(whole))return [true,'Distinctive venue name agrees with owner domain and prominent heading']
 if(full&&postcode&&body.includes(postcode))return [true,'Venue name and exact catalogue postcode agree with page']
 return [false,'No sufficient venue-ownership evidence; manual review required']
}
function account(s){try{const u=new URL(s);return u.hostname.replace(/^(www|m)\./,'')+u.pathname.replace(/\/$/,'').toLowerCase()}catch{return ''}}
function check(v,field,url,pages,web){
 const p=pages.get(key(url))||{},out={fields:[field],url,status:'needs_review',reason:'Ownership not confirmed',http_status:p.http_status,final_url:p.final_url||url}
 if(field==='website'){const [ok,reason]=owner(v,p);return {...out,status:ok?'verified':'needs_review',reason}}
 const wp=pages.get(key(v.website))||{},official=web?.status==='verified',links=wp.links||[]
 if(['instagram','facebook','booking_url'].includes(field)){if(official&&links.some(([u])=>account(u)===account(url)))return {...out,status:'verified',reason:'Exact account/booking URL is published by identity-confirmed venue website'};return {...out,reason:'Account/booking URL not corroborated by confirmed venue website'}}
 if(key(url)===key(v.website))return {...out,reason:'Homepage duplicated into menu field, not a confirmed menu'}
 const linked=links.some(([u,label])=>key(u)===key(url)&&/menu|food|drink/i.test(u+' '+label))
 if(official&&p.http_status===200&&host(p.final_url)===host(wp.final_url)&&(linked||/menu|food|drink/i.test(url))&&(p.pdf||/menu|food|drink|breakfast|brunch|dishes/i.test(p.title+' '+p.heading)))return {...out,status:'verified',reason:'Explicit menu evidence on an identity-confirmed venue domain'}
 return {...out,reason:'Menu ownership not sufficiently corroborated'}
}
async function catalogue(){
 const rows=[];let after=0,extended=true
 for(;;){
  let r=await fetch(BASE+'/venue-link-audit/catalogue?limit=2000&after='+after+'&_audit='+Date.now(),{signal:AbortSignal.timeout(30000)})
  if(!r.ok&&after===0){extended=false;console.log('Extended audit snapshot not deployed; checking every website/menu in public catalogue; social/booking completeness not certified');break}
  if(!r.ok)throw Error('Complete snapshot unavailable: '+r.status)
  const d=await r.json();rows.push(...d.venues);if(!d.has_more)break;after=d.next_after
 }
 if(!extended){let offset=0;for(;;){const r=await fetch(BASE+'/venues?limit=2000&offset='+offset+'&_audit='+Date.now(),{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('Public catalogue unavailable: '+r.status);const d=await r.json();rows.push(...d.venues);if(!d.has_more)break;offset=d.next_offset}}
 console.log('Extended social/booking snapshot',extended);return rows
}
async function main(){
 const rows=await catalogue()
 for(const v of rows)for(const f of FIELDS)if(v[f])v[f]=social(f,v[f])
 const urls=new Map();for(const v of rows)for(const f of FIELDS)if(v[f])urls.set(key(v[f]),v[f])
 const tasks=[...urls.values()],pages=new Map();let cursor=0,done=0
 fs.mkdirSync('audit-results',{recursive:true});fs.writeFileSync('audit-results/catalogue.json',JSON.stringify(rows))
 console.log('Complete snapshot:',rows.length,'venues;',tasks.length,'unique URLs')
 await Promise.all(Array.from({length:32},async()=>{for(;;){const i=cursor++;if(i>=tasks.length)return;const p=await page(tasks[i]);pages.set(key(p.url),p);fs.appendFileSync('audit-results/observations.jsonl',JSON.stringify(p)+'\n');if(++done%100===0)console.log('URL progress',done,'/',tasks.length)}}))
 const records=[],report=[],counts={venues:rows.length,unique_links:tasks.length,link_fields:0,verified:0,needs_review:0,blocked:0,no_links:0,quarantined:0}
 for(const v of rows){
  const website=v.website?check(v,'website',v.website,pages,null):null,links=website?[website]:[]
  for(const f of FIELDS)if(f!=='website'&&v[f])links.push(check(v,f,v[f],pages,website))
  const rec={id:v.id,name:v.name,city:v.city,links}
  if(v.id===7253){rec.quarantine_identity=true;rec.reason='Ferraiolos original OSM listing wrongly enriched as Villa Romana; no correct replacement link confirmed'}
  const src=v.provider_identity||{}
  if(src.name&&src.lat!=null&&src.lng!=null&&v.lat!=null&&v.lng!=null){
   const distance=Math.hypot((v.lat-src.lat)*111320,(v.lng-src.lng)*111320*Math.cos(v.lat*Math.PI/180)),a=normal(v.name),b=normal(src.name),aw=a.split(' ').filter(w=>w.length>2&&!generic.has(w)),bw=new Set(b.split(' ').filter(w=>w.length>2&&!generic.has(w)))
   if(distance>200&&aw.length&&bw.size&&!aw.some(w=>bw.has(w))&&!a.includes(b)&&!b.includes(a)){rec.quarantine_identity=true;rec.reason='Provider business name and coordinates contradict catalogue identity';rec.provider_name=src.name;rec.provider_distance_m=Math.round(distance)}
  }
  if(rec.quarantine_identity){counts.quarantined++;for(const l of links){l.status='blocked';l.reason=rec.reason}}
  if(!links.length)counts.no_links++
  for(const l of links){counts.link_fields++;counts[l.status]++;report.push({id:v.id,name:v.name,city:v.city,...l})}
  records.push(rec)
 }
 const payload={version:1,enforce_verified:true,checked_at:new Date().toISOString(),method:'Automated ownership evidence audit; HTTP availability alone is never verification; unresolved links require manual review',counts,venues:records}
 fs.writeFileSync('audit-results/venue-link-audit.json',JSON.stringify(payload))
 fs.writeFileSync('audit-results/report.json',JSON.stringify(report))
 const quote=s=>'"'+String(s??'').replace(/"/g,'""')+'"'
 fs.writeFileSync('audit-results/report.csv','id,name,city,field,url,status,http_status,reason\n'+report.map(r=>[r.id,r.name,r.city,r.fields[0],r.url,r.status,r.http_status,r.reason].map(quote).join(',')).join('\n'))
 console.log('AUDIT COMPLETE',JSON.stringify(counts))
 console.log('Needs-review examples',JSON.stringify(report.filter(r=>r.status!=='verified').slice(0,15)))
 if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,'# Complete venue link audit\n\n'+Object.entries(counts).map(([k,v])=>'- '+k+': '+v).join('\n')+'\n\nUnresolved links are NOT certified. Download the report for every venue.\n')
}
main().catch(e=>{console.error(e);process.exitCode=1})
