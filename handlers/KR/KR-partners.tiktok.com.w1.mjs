export const meta={task:'KR-partners.tiktok.com',want:'w1',tier:2,method:'static_list',input:'company name as listed',fields:['name','id','countries','specialties','website'],canary:{found:'Cafe24 Corp.',not_found:'이상한 마케팅'}};
let last=0;const norm=s=>s.normalize('NFKC').toLowerCase().replace(/[\s.,()]/g,'');
export default async function lookup(keyword){
 const url='https://partners.tiktok.com/directory/pc/en?specialties=7&countries=KR';const out=(status,reason,records,excerpt)=>({status,reason,records,source_url:url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,last+1100-Date.now())));last=Date.now();const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const t=await r.text();
  if(r.status===401||r.status===403||/cf-chl-|verify you are human|<title>[^<]*captcha/i.test(t))return out('couldnt_check','blocked',[],t);
  if(!r.ok)return out('couldnt_check','http_error',[],String(r.status));
  const raw=t.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];let j;try{j=JSON.parse(raw);}catch{return out('couldnt_check','layout_changed',[],'Missing Next data');}
  const p=j.props?.pageProps?.partners;
  if(!Array.isArray(p)||!p.length||!j.gsp||p.some(x=>typeof x.name!=='string'||!Array.isArray(x.countries)||!Array.isArray(x.specialties)||!x.id))return out('couldnt_check','layout_changed',[],'Missing complete static partner dataset/schema');
  const scoped=p.filter(x=>x.countries.includes('KR')&&x.specialties.includes(7));if(!scoped.length)return out('couldnt_check','layout_changed',[],'Empty Korea specialty 7 scope');
  const records=scoped.filter(x=>norm(x.name)===norm(keyword)).map(x=>({name:x.name.trim(),id:x.id,countries:x.countries,specialties:x.specialties,website:x.landingPageUrl}));
  return out(records.length?'found':'not_found','',records,records.length?JSON.stringify(records):'Inspected '+p.length+' static partner records; '+scoped.length+' in KR specialty 7. No name match for '+keyword);
 }catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other',[],String(e));}
}
