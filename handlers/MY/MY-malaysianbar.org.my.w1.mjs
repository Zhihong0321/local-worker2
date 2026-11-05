export const meta={task:'MY-malaysianbar.org.my',want:'w1',tier:2,method:'form_post',input:'law firm name',fields:['name','status','state','city','address','phone','fax','email','website'],canary:{found:'SKRINE',not_found:'O2O Digital'}};
let last=0;
const clean=s=>String(s||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
const norm=s=>clean(s).toUpperCase().replace(/[^A-Z0-9]/g,'');
export default async function lookup(keyword){
 const source_url='https://legaldirectory.malaysianbar.org.my/a/Lawyer/getSearchResult';
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
  const body=new URLSearchParams({'searchtype[]':'Firm',name:keyword,alphabet:'',state:'',city:'',keyword:'',aop_filter:''});
  const r=await fetch(source_url,{method:'POST',body,headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});
  const s=await r.text();if(r.status===403||/cf-chl-|captcha|Just a moment/i.test(s))return fail('blocked',s);
  if(!r.ok)return fail('http_error',`HTTP ${r.status}`);
  let j;try{j=JSON.parse(s);}catch{return fail('layout_changed',s);}
  const f=j.data?.firms;
  if(Number(j.status)!==1||!f||!Array.isArray(f.data)||!Number.isFinite(Number(f.numrow)))return fail('layout_changed',s);
  if(f.data.some(x=>typeof x.name!=='string'||typeof x.status!=='string'))return fail('layout_changed');
  const records=f.data.filter(x=>norm(x.name)===norm(keyword)).map(x=>({name:x.name,status:x.status,state:x.state,city:x.city,address:[x.add1,x.add2,x.add3,x.postcode,x.city,x.state].map(clean).filter(Boolean).join(', '),phone:x.tel1,fax:x.fax,email:x.email,website:x.website}));
  if(!records.length&&Number(f.numpage)>1)return fail('other','Multiple result pages; exact match not yet verified.');
  return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:(records.length?JSON.stringify(records):`Done; ${f.numrow} firm search results; no exact normalized name match.`).slice(0,500)};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',String(e));}
}
