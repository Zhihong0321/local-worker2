export const meta={task:'MY-myehalal.halal.gov.my',want:'w1',tier:2,method:'other',input:'exact registered company name',fields:['name','address','scope','expiry_dates','detail_url'],canary:{found:'SECRET RECIPE CAKES & CAFE SDN BHD',not_found:'O2O Digital'}};
const root='https://www.halal.gov.my/';
const data='ZGlyZWN0b3J5L2luZGV4X2RpcmVjdG9yeTs7Ozs=';
const clean=s=>String(s).replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
const norm=s=>clean(s).toUpperCase().replace(/\b(SDN|BHD|BERHAD)\b/g,'').replace(/[^A-Z0-9]/g,'');
let last=0;
export default async function lookup(keyword){
 let source_url=root;
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  async function search(category){
   const url=root+'index.php?'+new URLSearchParams({data,category,cari:keyword});source_url=url;
   await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
   const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});
   const s=await r.text();if(r.status===403||/cf-chl-|g-recaptcha|Just a moment/i.test(s))throw {reason:'blocked'};
   if(!r.ok)throw {reason:'http_error'};
   const count=s.match(/Total Record\s*:\s*(\d+)\s*-\s*Page\s*(\d+)\s*From\s*(\d+)/i);
   if(!count||!s.includes('Nama & Alamat Syarikat')||!s.includes('Expiry date'))throw {reason:'layout_changed'};
   if(Number(count[3])>1)throw {reason:'other',message:'More search pages require inspection; no definitive absence.'};
   const rows=[];
   for(const m of s.matchAll(/<tr\b[^>]*onclick="openModal\('([^']+)'[^>]*>([\s\S]*?)<\/tr>/gi)){
    const name=m[2].match(/class="company-name">([\s\S]*?)<\/span>/i)?.[1];
    const address=m[2].match(/class="company-address">([\s\S]*?)<\/span>/i)?.[1];
    const cells=[...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if(!name||!address||cells.length!==3)throw {reason:'layout_changed'};
    rows.push({name:clean(name),address:clean(address),expiry_dates:clean(cells[2][1]).match(/\d{2}\/\d{2}\/\d{4}/g)||[],detail_url:new URL(m[1],root).href});
   }
   if(Number(count[1])!==rows.length)throw {reason:'layout_changed'};
   return rows.filter(x=>norm(x.name)===norm(keyword));
  }
  const initial=await search('');const initialUrl=source_url;
  if(!initial.length)return {status:'not_found',reason:'',records:[],source_url,excerpt:'Total Record search verified across all categories; no exact normalized company match.'};
  const scopes=[];
  for(const [code,label] of Object.entries({BG:'Barang Gunaan',FM:'Farmaseutikal',IN:'International',KO:'Kosmetik dan Dandanan Diri',MD:'Peranti Perubatan',OEM:'Pengilangan Kontrak / OEM',PE:'Premis Makanan',PL:'Logistik',PR:'Produk Makanan / Minuman',PS:'Rumah Sembelihan'})){
   if((await search(code)).length)scopes.push(label);
  }
  const today=new Date().toISOString().slice(0,10);
  const records=initial.filter(x=>x.expiry_dates.some(d=>d.split('/').reverse().join('-')>=today)).map(x=>({...x,scope:scopes}));
  return {status:records.length?'found':'not_found',reason:'',records,source_url:initialUrl,excerpt:JSON.stringify(records).slice(0,500)};
 }catch(e){return fail(e.reason||(e.name==='TimeoutError'?'timeout':'other'),e.message||String(e));}
}
