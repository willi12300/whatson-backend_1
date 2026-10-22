const {test}=require('node:test'),assert=require('node:assert/strict')
const {owner,check,publicIP}=require('../scripts/audit-venue-links')
const p={http_status:200,final_url:'https://boldstreetcoffee.co.uk/',title:'Bold Street Coffee',heading:'Bold Street Coffee',text:'Liverpool',links:[]}
test('link audit requires venue identity, not merely HTTP 200 or one shared word',()=>{
 assert.equal(owner({name:'Bold Street Coffee'},p)[0],true)
 assert.equal(owner({name:'Other Street Kitchen'},p)[0],false)
 assert.equal(owner({name:"Ferraiolo's Italian Bistro"},{...p,final_url:'https://www.villaromanaliverpool.co.uk/',title:'Villa Romana',heading:'Villa Romana'})[0],false)
 assert.equal(owner({name:'Bold Street Coffee'},{...p,http_status:503})[0],false)
})
test('a menu is not fabricated by relabelling a homepage',()=>{
 const venue={name:'Bold Street Coffee',website:'https://boldstreetcoffee.co.uk/'},pages=new Map([['https://boldstreetcoffee.co.uk',p]])
 assert.equal(check(venue,'menu_url',venue.website,pages,{status:'verified'}).status,'needs_review')
})
test('audit crawler rejects private and local network addresses',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','192.168.1.1','172.16.0.1','::1','fc00::1'])assert.equal(publicIP(ip),false)
 assert.equal(publicIP('8.8.8.8'),true)
})
