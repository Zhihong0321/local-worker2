export const meta={task:'KR-jobkorea.co.kr',want:'w1',tier:2,method:'other',input:'company name',fields:['name','business_number','address','industry','company_type'],canary:{found:'지텍에스',not_found:'테일러커피 연남점'}};
let last=0;
const norm=s=>s.replace(/주식회사|유한회사|\(주\)|㈜|\s|[()]/g,'').toLowerCase();
export default async function lookup(keyword){
 const source_url='https://www.jobkorea.co.kr/Search/?stext='+encodeURIComponent(keyword);
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
  const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(25000)});const html=await r.text();
  if(/captcha|cf-chl-|verify you are human/i.test(html))return fail('blocked');if(!r.ok)return fail('http_error',String(r.status));
  let flight='';for(const m of html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)){try{const a=JSON.parse(m[1]);if(a[0]===1&&typeof a[1]==='string')flight+=a[1];}catch{}}
  let query;function visit(v){if(!v||typeof v!=='object')return;if(v.queryKey?.[0]==='COMPANY_LIST'&&v.queryKey.at(-1)===keyword)query=v;for(const x of Object.values(v))if(x&&typeof x==='object')visit(x);}
  for(const line of flight.split('\n')){try{visit(JSON.parse(line.slice(line.indexOf(':')+1)));}catch{}}
  if(!query)for(const m of flight.matchAll(/"queryKey":\["COMPANY_LIST"/g)){
   const start=flight.lastIndexOf('{"dehydratedAt":',m.index);if(start<0)continue;
   let depth=0,quoted=false,escaped=false;
   for(let i=start;i<flight.length;i++){const c=flight[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else{if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{visit(JSON.parse(flight.slice(start,i+1)));}catch{}break;}}}
  }
  const d=query?.state?.data;if(query?.state?.status!=='success'||!d||!Array.isArray(d.content)||!Number.isInteger(d.totalElements))return fail('layout_changed','Company search hydration data missing');
  const records=d.content.filter(c=>typeof c.name==='string'&&norm(c.name)===norm(keyword)).map(c=>({name:c.name,business_number:c.businessNo,address:c.address,industry:c.companyTypeInfo?.industry,company_type:c.companyTypeInfo?.name}));
  if(!records.length&&d.totalPages>1)return fail('other','More company results exist; cannot establish absence from first page');
  return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:JSON.stringify({total:d.totalElements,records}).slice(0,500)};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'http_error',String(e));}
}
