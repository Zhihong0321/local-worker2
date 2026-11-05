export const meta={task:'KR-kosca.or.kr',want:'w1',tier:2,method:'form_post',input:'company name',fields:['name','member_number','representative','address','industry','evaluation_amount'],canary:{found:'은민에스엔디',not_found:'애드이피션시'}};
const base='https://www.kosca.or.kr/const/proconst/search.do';let last=0;
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/주식회사|\(주\)|㈜|\(유\)|유한회사/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const clean=s=>s.replace(/<br\s*\/?\s*>/gi,'; ').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export default async function lookup(keyword){
 let source_url=base;const fail=(reason,excerpt='')=>({status:'couldnt_check',reason,records:[],source_url,excerpt:excerpt.slice(0,500)});
 try{
  const company=String(keyword).normalize('NFKC').replace(/주식회사|\(주\)|㈜|\(유\)|유한회사/g,'').trim();if(!norm(company))return fail('other','Empty keyword');
  const cookies={};
  async function request(url,options={}){
   for(let i=0;i<5;i++){
    await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();
    const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(40000),headers:{'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',cookie:url.startsWith('https:')?Object.entries(cookies).map(([k,v])=>k+'='+v).join('; '):''}});
    for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],idx=pair.indexOf('=');cookies[pair.slice(0,idx)]=pair.slice(idx+1);}
    if(r.status>=300&&r.status<400){const target=new URL(r.headers.get('location'),url);if(target.hostname!=='www.kosca.or.kr'||/login|auth/i.test(target.pathname))throw Error('blocked');url=target.href;options={};continue;}
    source_url=url;if(!r.ok)throw Error('http_error');return await r.text();
   }throw Error('layout_changed');
  }
  let html=await request(base,{method:'POST',body:new URLSearchParams({menuId:'MENU001135',company,name1:'',sido:'00',region:'',gubun:'industry',upjong:'',detailChk:'no',priceFrom:'',priceTo:''})});
  for(let page=1;page<=20;page++){
   if(/captcha|cf-chl-|verify you are human/i.test(html))return fail('blocked');
   const section=html.split('<!-- 결과 리스트 -->')[1]?.split('<!-- 블록 계산 -->')[0];
   const total=section?.match(/class="num text-primary">([\d,]+)<\/span>/);
   const echo=html.match(/id="company"[^>]*value="([^"]*)"/);
   if(!section||!total||!section.includes('<th>상호</th>')||!echo||norm(echo[1])!==norm(company))return fail('layout_changed','Search form did not preserve the submitted company.');
   const count=Number(total[1].replaceAll(',',''));
   const rows=[...section.matchAll(/<tr[^>]*onclick="proConstView\('([^']+)'\)"[^>]*>([\s\S]*?)<\/tr>/g)];
   const all=rows.map(m=>{const t=[...m[2].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x=>clean(x[1]));if(t.length!==5)throw Error('layout_changed');return {name:t[0],member_number:m[1],representative:t[1],address:t[2],industry:t[3],evaluation_amount:t[4]};});
   if(count>0&&!all.length)return fail('layout_changed');
   const records=all.filter(r=>norm(r.name)===norm(company));
   if(records.length)return {status:'found',reason:'',records,source_url,excerpt:records.map(r=>Object.values(r).join(' | ')).join('; ').slice(0,500)};
   if(count<=page*10)return {status:'not_found',reason:'',records:[],source_url,excerpt:clean(section).slice(0,500)};
   const enc=html.match(/const encQuery = "([^"]+)"/);if(!enc)return fail('layout_changed');
   html=await request(base+'?'+enc[1].replaceAll('&amp;','&')+'&recordPage='+(page+1));
  }return fail('other','Search exceeds 20 pages; absence cannot be established.');
 }catch(e){return fail(e.name==='TimeoutError'?'timeout':['blocked','http_error','layout_changed'].includes(e.message)?e.message:'other',e.message);}
}

