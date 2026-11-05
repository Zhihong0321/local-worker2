export const meta={task:'KR-sminfo.mss.go.kr',want:'w1',tier:1,method:'url_template',input:'company name',fields:['name','business_number','certificate_number','validity','company_size'],canary:{found:'삼성전자디지털프라자 고현점',not_found:'(주)플랜아이'}};
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
let last=0;
export default async function lookup(keyword){
 let source_url='https://sminfo.mss.go.kr/sc/sy/SSY004R0.do';
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  const to=new Date(),from=new Date(to);from.setUTCMonth(from.getUTCMonth()-15);
  const fmt=d=>d.toISOString().slice(0,10);
  source_url+='?'+new URLSearchParams({searchGubun:'02',searchTxt:keyword,baseDtFrom:fmt(from),baseDtTo:fmt(to),cmPageNo:'1'});
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
  const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});
  if(!r.ok)return fail(r.status===403?'blocked':'http_error',`HTTP ${r.status}`);
  const s=await r.text();if(/captcha|cloudflare|access denied/i.test(s))return fail('blocked');
  const table=s.match(/<table\b[^>]*class="list_table type02"[\s\S]*?<\/table>/i)?.[0];
  if(!table||!table.includes('유효기간')||!table.includes('발급번호')||!s.includes('확인서 발급정보 공개'))return fail('layout_changed');
  const rows=[...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>[...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x=>clean(x[1]))).filter(a=>a.length);
  if(rows.some(a=>a.length!==5))return fail('layout_changed');
  if(!rows.length&&!s.includes('조회된 내용이 없습니다.'))return fail('layout_changed');
  const norm=s=>s.replace(/주식회사|유한회사|\(주\)|㈜|\s|[.,()]/g,'').toLowerCase();
  const records=rows.filter(a=>norm(a[0])===norm(keyword)).map(a=>({name:a[0],business_number:a[1],certificate_number:a[2],validity:a[3],company_size:a[4]}));
  if(!records.length&&/onclick="[^"]*searchByTarget\(/.test(s))return fail('other','Additional search pages need checking; no exact company match on this page.');
  return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:(records.length?JSON.stringify(records):'조회된 내용이 없습니다. Current public SME certificates issued within last 15 months only.').slice(0,500)};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',String(e));}
}
