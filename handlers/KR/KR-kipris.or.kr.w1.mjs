export const meta={task:'KR-kipris.or.kr',want:'w1',tier:2,method:'form_post',input:'company name',fields:['name','title','application_number','registration_number','status','applicants','owners'],canary:{found:'삼성전자',not_found:'한국동지무역(주)'}};
const source='https://www.kipris.or.kr/khome/search/searchResult.do?tab=trademark';
let last=0;const norm=s=>s.replace(/주식회사|유한회사|\(주\)|㈜|\s|[()]/g,'').toLowerCase();
async function request(url,options={}){await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();return fetch(url,{...options,headers:{'user-agent':'Mozilla/5.0',...options.headers},signal:AbortSignal.timeout(25000)});}
export default async function lookup(keyword){
 const source_url=source;const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  const r=await request(source);const html=await r.text();if(/cf-chl-|verify you are human|<title>[^<]*captcha/i.test(html))return fail('blocked');if(!r.ok)return fail('http_error',String(r.status));
  const form=html.match(/<form id="ktmSearchForm"[\s\S]*?<\/form>/)?.[0];if(!form)return fail('layout_changed');
  const body=new URLSearchParams();for(const m of form.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g))body.set(m[1],m[2]);
  body.set('queryText',norm(keyword));body.set('expression',norm(keyword));
  const endpoint=new URL(form.match(/action="([^"]+)"/)[1].replace(/&amp;/g,'&'),source).href;
  const cookies=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  const response=await request(endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',cookie:cookies,referer:source},body});const text=await response.text();
  if(/captchaImage|cf-chl-|verify you are human/i.test(text))return fail('blocked');if(!response.ok)return fail('http_error',String(response.status));
  let d;try{d=JSON.parse(text);}catch{return fail('layout_changed',text.slice(0,200));}
  if(d.resultCode==='98')return {status:'not_found',reason:'',records:[],source_url,excerpt:'KIPRIS resultCode 98: DataNotFound'};
  if(d.resultCode!=='00'||!Array.isArray(d.resultList)||!Number.isFinite(+d.countInfo?.totalcount))return fail('layout_changed',JSON.stringify(d).slice(0,200));
  const records=d.resultList.filter(v=>[v.APNM,v.TRH].some(s=>(s||'').split('|').some(n=>norm(n)===norm(keyword)))).map(v=>({name:(v.APNM||'').split('|').find(n=>norm(n)===norm(keyword))||(v.TRH||'').split('|').find(n=>norm(n)===norm(keyword)),title:v.TTL_SUB,application_number:v.ANN,registration_number:v.RNN,status:v.LAS,applicants:v.APNM,owners:v.TRH}));
  if(!records.length&&+d.countInfo.totalcount>d.resultList.length)return fail('other','Additional search pages exist; no absence inferred');
  return {status:records.length?'found':'not_found',reason:'',records,source_url,excerpt:JSON.stringify({total:d.countInfo.totalcount,records:records.slice(0,2)}).slice(0,500)};
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':'http_error',String(e));}
}
