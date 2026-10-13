const boundary=require('./walesBoundary.json')
const {distanceMeters}=require('../utils/helpers')
const DESTINATIONS=[{id:'liverpool',name:'Liverpool',lat:53.4084,lng:-2.9916},{id:'manchester',name:'Manchester',lat:53.4808,lng:-2.2426},{id:'barcelona',name:'Barcelona',lat:41.3851,lng:2.1734},{id:'wales',name:'Wales',lat:52.2757,lng:-3.5882}]
const aliases={liverpool:'Liverpool','liverpool area':'Liverpool',waterloo:'Liverpool',frodsham:'Liverpool',manchester:'Manchester','manchester area':'Manchester','greater manchester':'Manchester',barcelona:'Barcelona','barcelona area':'Barcelona',wales:'Wales','dolgellau area':'Wales',dolgellau:'Wales'}
function inRing(lng,lat,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const [x,y]=ring[i],[px,py]=ring[j];if((y>lat)!==(py>lat)&&lng<(px-x)*(lat-y)/(py-y)+x)inside=!inside}return inside}
function inWales(lat,lng){return Number.isFinite(lat)&&Number.isFinite(lng)&&boundary.coordinates.some(p=>inRing(lng,lat,p[0])&&!p.slice(1).some(h=>inRing(lng,lat,h)))}
function destinationName(name,coords){const text=String(name||'').trim(),known=aliases[text.toLowerCase().replace(/[-_]/g,' ')];if(known)return known;const lat=Number(coords?.lat),lng=Number(coords?.lng);if(coords?.lat!=null&&coords?.lng!=null&&Number.isFinite(lat)&&Number.isFinite(lng)){if(inWales(lat,lng))return 'Wales';const near=DESTINATIONS.filter(d=>d.id!=='wales').find(d=>distanceMeters(lat,lng,d.lat,d.lng)<=35000);if(near)return near.name}return text}
module.exports={DESTINATIONS,destinationName,inWales}
