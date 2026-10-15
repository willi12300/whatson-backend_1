// An explicit Places boolean can establish pet access, but not indoor/outdoor rules.
function googleDogPolicy(sources, mapsUrl, now=Date.now()) {
 const source=sources.find(s=>s.provider==='google'&&typeof s.allows_dogs==='boolean')
 const at=Date.parse(source?.dog_checked_at||'')
 if(!source||!Number.isFinite(at)||now-at<0||now-at>90*86400000)return {status:'unknown'}
 return {status:source.allows_dogs?'welcome':'no',evidence:'Google Places',sourceUrl:mapsUrl,checkedAt:source.dog_checked_at}
}
module.exports={googleDogPolicy}
