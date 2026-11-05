export const meta={task:'KR-soomgo.com',want:'w1',tier:2,method:'json_api',input:'company name',fields:['name','description','address','rating','review_count','user_id','profile_url'],canary:{found:'나미에스엔티',not_found:'애드이피션시'}};
let last=0;const norm=s=>s.normalize('NFKC').replace(/\(주\)|주식회사|[\s.,]/g,'').toLowerCase();
export default async function lookup(keyword){
 const base='https://api.soomgo.com/v2/search/pro';let source=base;const out=(status,reason,records,excerpt)=>({status,reason,records,source_url:source,excerpt:excerpt.slice(0,500)});
 try{
  let cursor='',seen=new Set(),ids=new Set();
  for(let page=0;page<60;page++){
   await new Promise(r=>setTimeout(r,Math.max(0,last+1100-Date.now())));last=Date.now();
   const q=new URLSearchParams({keyword:keyword.trim().replace(/\s+/g,'+'),sort:'review_count',limit:'200'});if(cursor)q.set('cursor',cursor);source=base+'?'+q;
   const r=await fetch(source,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const t=await r.text();
   if(r.status===401||r.status===403||/cf-chl-|verify you are human|captcha/i.test(t))return out('couldnt_check','blocked',[],t);
   if(!r.ok)return out('couldnt_check','http_error',[],String(r.status));
   let j;try{j=JSON.parse(t);}catch{return out('couldnt_check','layout_changed',[],t);}
   const d=j.response;if(j.code!==0||!Array.isArray(d?.results)||!Number.isInteger(d.totalCount))return out('couldnt_check','layout_changed',[],t);
   if(d.results.some(x=>!x.user?.name||!x.user?.id))return out('couldnt_check','layout_changed',[],t);
   const matches=d.results.filter(x=>norm(x.user.name)===norm(keyword)||norm(x.companyName||'')===norm(keyword));
   if(matches.length){const records=matches.map(x=>({name:x.user.name,description:x.companyName,address:x.address,rating:x.score?.review_rate,review_count:x.score?.review_count,user_id:x.user.id,profile_url:'https://soomgo.com/profile/users/'+x.user.id}));return out('found','',records,JSON.stringify(records));}
   for(const x of d.results)ids.add(x.user.id);
   if(!d.cursor||d.results.length===0){if(d.totalCount>=10000)return out('couldnt_check','other',[],'Search count capped at 10000; absence cannot be proven');if(ids.size<d.totalCount)return out('couldnt_check','layout_changed',[],'Search ended before stated count was inspected');return out('not_found','',[],'Exhausted fuzzy search: '+ids.size+' profiles inspected, no exact company-name match for '+keyword);}
   if(seen.has(d.cursor))return out('couldnt_check','layout_changed',[],'Repeated pagination cursor');seen.add(d.cursor);cursor=d.cursor;
  }
  return out('couldnt_check','other',[],'Pagination safety limit reached; no absence inferred');
 }catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other',[],String(e));}
}
