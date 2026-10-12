#!/usr/bin/env python3
"""Build a private search-term index from venues' published websites and menus.
No paid provider calls, generated menu claims, or changes to catalogue records.
Readable PDFs require pdftotext. Unreadable/blocked sites are recorded as gaps.
"""
import argparse, concurrent.futures, datetime, hashlib, html, ipaddress, json, os, re, subprocess, tempfile, threading, unicodedata
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

SKIP_HOSTS=('facebook.com','instagram.com','google.com','goo.gl','tripadvisor.com','tripadvisor.co.uk','linktr.ee','youtube.com','tiktok.com','x.com','twitter.com')
lock=threading.Lock(); cache={}; in_flight={}
class Page(HTMLParser):
 def __init__(self):super().__init__();self.text=[];self.links=[];self.excluded=0;self.title='';self.in_title=False
 def handle_starttag(self,tag,attrs):
  attrs=dict(attrs)
  if tag in ('script','style','nav','footer'):self.excluded+=1
  if tag=='title':self.in_title=True
  if tag=='a' and attrs.get('href'):self.links.append((attrs['href'],attrs.get('title') or ''))
  if tag=='meta' and attrs.get('name','').lower()=='description':self.text.append(attrs.get('content',''))
 def handle_endtag(self,tag):
  if tag in ('script','style','nav','footer'):self.excluded=max(0,self.excluded-1)
  if tag=='title':self.in_title=False
 def handle_data(self,text):
  if self.in_title:self.title+=text
  if not self.excluded:self.text.append(text)
def normalise(value):
 return re.sub(r'[^a-z0-9]+',' ',unicodedata.normalize('NFKD',str(value)).encode('ascii','ignore').decode().lower()).strip()
def url(value,base=None):
 try:
  value=urljoin(base,value) if base else value
  p=urlsplit(value)
  if p.scheme not in ('http','https') or not p.hostname or p.username or p.password:return None
  host=p.hostname.lower()
  if host=='localhost' or host.endswith(('.local','.internal')) or any(host==h or host.endswith('.'+h) for h in SKIP_HOSTS):return None
  try:
   if not ipaddress.ip_address(host).is_global:return None
  except ValueError:pass
  query='&'.join(q for q in p.query.split('&') if q and not q.lower().startswith(('utm_','fbclid=','gclid=')))
  return urlunsplit((p.scheme,p.netloc,p.path or '/',query,''))
 except Exception:return None
def fetch(address):
 with lock:
  if address in cache:return cache[address]
  if address in in_flight:wait=in_flight[address]
  else:wait=None;in_flight[address]=threading.Event()
 if wait:
  wait.wait(20)
  with lock:return cache.get(address)
 try:
  out=subprocess.run(['curl','-fsSL','--proto','=http,https','--proto-redir','=http,https','--max-redirs','3','--connect-timeout','3','--max-time','7','--max-filesize','2097152','-A','SAPPO/1.0 venue-search (+https://sappo-frontend.vercel.app)','-w','\nSAPPO_FINAL_URL:%{url_effective}',address],capture_output=True,timeout=9)
  if out.returncode:result=None
  else:
   body,_,final=out.stdout.rpartition(b'\nSAPPO_FINAL_URL:');final_url=url(final.decode(errors='replace'))
   if not final_url:result=None
   elif body.startswith(b'%PDF'):
    with tempfile.TemporaryDirectory(prefix='sappo-menu-') as tmp:
     pdf=Path(tmp)/'menu.pdf';pdf.write_bytes(body)
     parsed=subprocess.run(['pdftotext','-layout',str(pdf),'-'],capture_output=True,timeout=8)
     text=parsed.stdout.decode(errors='replace') if parsed.returncode==0 else ''
    result={'url':final_url,'title':'Published menu PDF','kind':'menu','text':text,'links':[]}
   else:
    page=Page();page.feed(body.decode(errors='replace'));result={'url':final_url,'title':html.unescape(page.title).strip()[:160],'kind':'website','text':' '.join(page.text),'links':page.links}
 except Exception:result=None
 with lock:cache[address]=result;in_flight.pop(address).set()
 return result

def document(page,kind):
 if not page:return None
 text=normalise(page['text']);terms=sorted(set(text.split()))
 # Empty JS shells and image-only PDFs are gaps, not food evidence.
 if len(terms)<15 or re.search(r'just a moment|access denied|attention required|captcha',page['title'],re.I):return None
 return {'url':page['url'],'title':page['title'],'kind':kind if page['kind']!='menu' else 'menu','terms':terms[:4500], 'text_hash':hashlib.sha256(text.encode()).hexdigest()}
def process(venue):
 home=url(venue.get('website'));menu=url(venue.get('menu_url'),home) if venue.get('menu_url') else None
 pages=[];first=fetch(home) if home else None
 if first:
  doc=document(first,'website')
  if doc:pages.append(doc)
 # Prefer the venue's recorded menu, then published links on its own site.
 candidates=[]
 if menu and menu!=home:candidates.append(menu)
 if first:
  for href,title in first['links']:
   candidate=url(href,first['url'])
   if candidate and candidate!=first['url'] and re.search(r'menu|food|drink|brunch|breakfast',href+' '+title,re.I) and not re.search(r'login|cart|basket|privacy|wp-json|facebook|instagram',candidate,re.I):candidates.append(candidate)
 for candidate in sorted(dict.fromkeys(candidates),key=lambda address:0 if re.search(r'menu|\.pdf',address,re.I) else 1):
  page=fetch(candidate)
  doc=document(page,'menu' if page and re.search(r'menu|\.pdf',page['url'],re.I) else 'website')
  if doc and not any(p['url']==doc['url'] for p in pages):pages.append(doc)
  # One readable menu per venue. Follow one PDF if the menu page links to it.
  if page and not any(p['kind']=='menu' and p['url'].lower().endswith('.pdf') for p in pages):
   pdf=next((url(href,page['url']) for href,_ in page['links'] if re.search(r'\.pdf(?:\?|$)',href,re.I) and re.search(r'menu|food|main|brunch',href,re.I)),None)
   if pdf:
    parsed=document(fetch(pdf),'menu')
    if parsed and not any(p['url']==parsed['url'] for p in pages):pages.append(parsed)
  break
 return {'id':venue['id'],'name':venue['name'],'category_slug':venue.get('category_slug'),'website':home,'documents':pages,'status':'indexed' if pages else 'unreadable_or_unavailable'}

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--catalogue',required=True);parser.add_argument('--output',default='data/venue-search-index.json');parser.add_argument('--workers',type=int,default=16);parser.add_argument('--limit',type=int);parser.add_argument('--refresh',action='store_true');args=parser.parse_args()
 rows=json.loads(Path(args.catalogue).read_text());venues=rows['venues'] if isinstance(rows,dict) else rows
 venues=[v for v in venues if v.get('business_status')!='CLOSED_PERMANENTLY' and (url(v.get('website')) or v.get('menu_url'))]
 if args.limit:venues=venues[:args.limit]
 output=Path(args.output);checked=datetime.datetime.now(datetime.timezone.utc).date().isoformat();previous=json.loads(output.read_text()) if output.exists() else {};done=previous.get('venues',[]) if previous.get('checked_at')==checked and not args.refresh else [];existing={v['id'] for v in done};venues=[v for v in venues if v['id'] not in existing]
 def save():
  payload={'checked_at':checked,'method':'Published venue website and readable menu term extraction','venues':sorted(done,key=lambda v:v['id'])};temporary=output.with_suffix('.tmp');temporary.write_text(json.dumps(payload,separators=(',',':'),ensure_ascii=False));temporary.replace(output)
 print('Indexing',len(venues),'remaining venue websites; existing',len(done),'workers',args.workers,flush=True)
 with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
  for future in concurrent.futures.as_completed([pool.submit(process,venue) for venue in venues]):
   try:result=future.result()
   except Exception as error:print('Skipped unreadable site:',str(error)[:120],flush=True);continue
   done.append(result)
   if len(done)%25==0:save();print('Processed',len(done),'/',len(venues),'indexed',sum(bool(v['documents']) for v in done),flush=True)
 save();print('Finished:',len(done),'checked;',sum(bool(v['documents']) for v in done),'indexed;',len(done)-sum(bool(v['documents']) for v in done),'gaps',flush=True)
if __name__=='__main__':main()
