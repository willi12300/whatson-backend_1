const { distanceMeters } = require('../utils/helpers')
const manifest=require('../../data/reviewed-venue-merges.json')
const { identityName } = require('./venueIdentity')
const logger=require('../utils/logger')
const quote=s=>'"'+String(s).replace(/"/g,'""')+'"'
const blank=v=>v==null||v===''||(Array.isArray(v)&&!v.length)
function photoKey(p){return typeof p==='string'?p:p?.url||p?.name||p?.photo_reference||JSON.stringify(p)}
function mergeProfileRows(canonical,duplicate,preferredId) {
 const preferred=canonical.claimed?canonical:duplicate.claimed?duplicate:preferredId===duplicate.id?duplicate:canonical,other=preferred.id===canonical.id?duplicate:canonical
 const merged={...preferred,id:canonical.id,created_at:canonical.created_at}
 // Keep the established region label so existing city-based lists still work.
 merged.city=canonical.city
 if(!canonical.claimed&&!duplicate.claimed){merged.name=canonical.name;merged.normalised_name=canonical.normalised_name}
 const sameGoogle=!preferred.google_place_id||!other.google_place_id||preferred.google_place_id===other.google_place_id
 for(const [key,value] of Object.entries(other)) {
  if(['id','created_at','updated_at','last_seen_at','city','photos','cover_photo'].includes(key))continue
  // Conflicting Google matches may be historic enrichment errors. Archive their
  // facts rather than blending reviews/photos belonging to another business.
  if(!sameGoogle&&(/^(google_|rating$|rating_count$|opening_hours$|website$|phone$|price_)/.test(key)))continue
  if(blank(merged[key])&&!blank(value))merged[key]=value
 }
 const photos=[...(Array.isArray(preferred.photos)?preferred.photos:[]),...(sameGoogle&&Array.isArray(other.photos)?other.photos:[])]
 const seen=new Set();merged.photos=photos.filter(p=>{const key=photoKey(p);if(!key||seen.has(key))return false;seen.add(key);return true})
 merged.cover_photo=preferred.cover_photo||(sameGoogle?other.cover_photo:null)||merged.photos.find(p=>typeof p==='string'||p?.url)?.url||null
 if(!merged.cover_photo&&typeof merged.photos[0]==='string')merged.cover_photo=merged.photos[0]
 merged.claimed=!!(canonical.claimed||duplicate.claimed)
 if(merged.category_slug==='other'&&other.category_slug!=='other')merged.category_slug=other.category_slug
 return merged
}
async function mergePair(client,pair) {
 const {rows}=await client.query('SELECT * FROM venues WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[pair.canonicalId,pair.duplicateId]])
 if(rows.length!==2)return {status:'already_merged_or_missing',duplicateId:pair.duplicateId}
 const canonical=rows.find(v=>v.id===pair.canonicalId),duplicate=rows.find(v=>v.id===pair.duplicateId)
 // Fail closed if a reviewed ID has moved or been repurposed since the audit.
 for(const expected of pair.expected) {
  const actual=rows.find(v=>v.id===expected.id)
  if(identityName(actual.name)!==identityName(expected.name)||distanceMeters(actual.lat,actual.lng,expected.lat,expected.lng)>50)return {status:'changed_since_review',duplicateId:pair.duplicateId}
 }
 if(duplicate.claimed&&canonical.claimed)return {status:'both_claimed_review_required',duplicateId:duplicate.id}
 const refs=await client.query(`SELECT ns.nspname AS schema, rel.relname AS table, att.attname AS column
 FROM pg_constraint fk JOIN pg_class rel ON rel.oid=fk.conrelid JOIN pg_namespace ns ON ns.oid=rel.relnamespace
 JOIN pg_attribute att ON att.attrelid=fk.conrelid AND att.attnum=fk.conkey[1]
 WHERE fk.contype='f' AND fk.confrelid='venues'::regclass AND array_length(fk.conkey,1)=1`)
 const related={}
 for(const ref of refs.rows){const table=quote(ref.schema)+'.'+quote(ref.table);const r=await client.query(`SELECT to_jsonb(t) AS data FROM ${table} t WHERE ${quote(ref.column)}=ANY($1::int[])`,[[canonical.id,duplicate.id]]);related[ref.table]=r.rows.map(r=>r.data)}
 // Include embedded references in recovery snapshots; these records are private.
 for(const table of ['saved_plans','challenges','roulette_history']){const r=await client.query(`SELECT to_jsonb(t) AS data FROM ${quote(table)} t`);related[table]=r.rows.map(r=>r.data)}
 await client.query(`INSERT INTO venue_merge_archive(duplicate_id,canonical_id,reason,canonical_before,duplicate_before,related_before) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(duplicate_id) DO NOTHING`,[duplicate.id,canonical.id,pair.reason,JSON.stringify(canonical),JSON.stringify(duplicate),JSON.stringify(related)])
 const merged=mergeProfileRows(canonical,duplicate,pair.preferredId)
 const columns=await client.query(`SELECT column_name,data_type,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name='venues' ORDER BY ordinal_position`)
 const fields=columns.rows.filter(c=>!['id','created_at','updated_at','last_seen_at'].includes(c.column_name)&&Object.hasOwn(merged,c.column_name))
 const values=fields.map(c=>c.udt_name==='jsonb'?JSON.stringify(merged[c.column_name]):merged[c.column_name]);values.push(canonical.id)
 await client.query(`UPDATE venues SET ${fields.map((c,i)=>quote(c.column_name)+'=$'+(i+1)).join(',')},updated_at=now() WHERE id=$${values.length}`,values)
 // Do not bind known distant Google enrichment mistakes to the merged venue.
 // Their source records remain in the private recovery archive above.
 for(const source of related.venue_sources||[]){
  const location=source.raw?.location
  if(source.provider!=='google'||source.venue_id!==duplicate.id||location?.latitude==null||location?.longitude==null)continue
  const limit=['park','garden'].includes(merged.category_slug)?1200:200
  if(distanceMeters(merged.lat,merged.lng,location.latitude,location.longitude)>limit)
   await client.query('DELETE FROM venue_sources WHERE id=$1',[source.id])
 }
 // All normal foreign keys (events, offers, sources, check-ins, missions,
 // interaction history) move intact. Aggregate popularity has one row per venue.
 const counters=['times_shown','times_clicked','times_opened','times_added','times_saved','times_shared','times_directions','times_dismissed']
 await client.query(`INSERT INTO venue_popularity_signals(venue_id,${counters.join(',')},last_interaction_at)
 SELECT $1,${counters.join(',')},last_interaction_at FROM venue_popularity_signals WHERE venue_id=$2
 ON CONFLICT(venue_id) DO UPDATE SET ${counters.map(c=>`${c}=venue_popularity_signals.${c}+EXCLUDED.${c}`).join(',')},last_interaction_at=GREATEST(venue_popularity_signals.last_interaction_at,EXCLUDED.last_interaction_at)`,[canonical.id,duplicate.id])
 await client.query('DELETE FROM venue_popularity_signals WHERE venue_id=$1',[duplicate.id])
 for(const ref of refs.rows){if(ref.table==='venue_popularity_signals')continue;await client.query(`UPDATE ${quote(ref.schema)}.${quote(ref.table)} SET ${quote(ref.column)}=$1 WHERE ${quote(ref.column)}=$2`,[canonical.id,duplicate.id])}
 await client.query(`UPDATE user_interactions SET item_id=$1 WHERE item_type='venue' AND item_id=$2`,[String(canonical.id),String(duplicate.id)])
 // Replace only venue ID keys in structured plans, not arbitrary numbers/text.
 const replaceIds=node=>Array.isArray(node)?node.map(replaceIds):node&&typeof node==='object'?Object.fromEntries(Object.entries(node).map(([k,v])=>[k,(['venueId','venue_id','sappoVenueId','internalVenueId'].includes(k)||(k==='id'&&(node.category_slug||node.venueId||node.venue_id||(node.lat!=null&&node.name))&&!node.eventId&&!node.event_id))&&String(v)===String(duplicate.id)?(typeof v==='string'?String(canonical.id):canonical.id):replaceIds(v)])):node
 for(const [table,column] of [['saved_plans','plan'],['challenges','steps']])for(const row of related[table]){const next=replaceIds(row[column]);if(JSON.stringify(next)!==JSON.stringify(row[column]))await client.query(`UPDATE ${quote(table)} SET ${quote(column)}=$1 WHERE id=$2`,[JSON.stringify(next),row.id])}
 await client.query(`UPDATE roulette_history SET result_key=$1 WHERE result_key=$2`,['v:'+canonical.id,'v:'+duplicate.id])
 await client.query(`INSERT INTO venue_aliases(duplicate_id,canonical_id,original_name,original_lat,original_lng,original_address,original_category) VALUES($1,$2,$3,$4,$5,$6,$7)`,[duplicate.id,canonical.id,duplicate.name,duplicate.lat,duplicate.lng,duplicate.address,duplicate.category_slug])
 await client.query('DELETE FROM venues WHERE id=$1',[duplicate.id])
 return {status:'merged',duplicateId:duplicate.id,canonicalId:canonical.id}
}
async function runReviewedVenueMerges(pool,pairs=manifest.merges) {
 const client=await pool.connect();const results=[]
 try {
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(20261011)')
  for(const pair of pairs)results.push(await mergePair(client,pair))
  await client.query('COMMIT');logger.info(`[venue-merge] ${results.filter(r=>r.status==='merged').length} merged; original records archived, old IDs aliased.`)
  return results
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
module.exports={mergeProfileRows,mergePair,runReviewedVenueMerges}
