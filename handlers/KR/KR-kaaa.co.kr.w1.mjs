export const meta={task:'KR-kaaa.co.kr',want:'w1',tier:1,method:'static_list',input:'company name',fields:['name','website'],canary:{found:'제일기획',not_found:'이상한 마케팅'}};
const url='http://www.kaaa.co.kr/members';
let last=0;
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/주식회사|\(주\)|㈜|유한회사/g,'').replace(/[^\p{L}\p{N}]/gu,'');
export default async function lookup(keyword){
 const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url:url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'},signal:AbortSignal.timeout(25000),redirect:'manual'});
  if(!r.ok)return fail('http_error',`HTTP ${r.status}`);
  const html=await r.text();
  if(/captcha|cf-chl-|verify you are human/i.test(html))return fail('blocked');
  if(!html.includes('회원사 소개')||!html.includes('memberName'))return fail('layout_changed');
  const all=[...html.matchAll(/<div class="memberName"[^>]*onclick="window\.open\('([^']*)'\)"[^>]*>([\s\S]*?)<\/div>/g)].map(m=>({name:clean(m[2]),website:m[1]}));
  if(all.length<5)return fail('layout_changed');
  const q=norm(keyword);if(!q)return fail('other','Empty company name');
  const records=all.filter(x=>norm(x.name)===q);
  return {status:records.length?'found':'not_found',reason:'',records,source_url:url,excerpt:records.length?records.map(x=>x.name+' '+x.website).join('; ').slice(0,500):`회원사 소개: checked ${all.length} listed member records; no exact normalized name match.`};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'other',e.message);}
}
