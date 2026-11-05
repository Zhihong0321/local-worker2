export const meta={task:'KR-i-award.or.kr',want:'w1',tier:2,method:'other',input:'company name',fields:['name','award','category','project','year','rank'],canary:{found:'(주)플랜아이',not_found:'이상한 마케팅'},notes:'Coverage: published Internet specialist DB award histories plus 2025 Web Award best-agency JSON. A negative is absence from these official indexes, not a claim that every historic unindexed candidate page was crawled.'};
const origin='https://www.i-award.or.kr';
const clean=s=>s.replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.normalize('NFKC').replace(/주식회사|\(주\)|㈜|\s+/g,'').toLowerCase();
let last=0; async function get(url){await new Promise(r=>setTimeout(r,Math.max(0,1100-(Date.now()-last))));last=Date.now();const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(20000)});const h=await r.text();if(/cf-chl-|captcha|verify you are human/i.test(h)||r.url.includes('/Login/'))throw Error('blocked');if(!r.ok)throw Error('http_error');return h;}
export default async function lookup(keyword){const base={records:[],source_url:origin+'/Vendor/VendorDBList.aspx',excerpt:''};try{
if(!norm(String(keyword)))throw Error('other');
const h=await get(base.source_url);if(!h.includes('인터넷 전문업체')||!h.includes('company_name'))throw Error('layout_changed');
const companies=[...h.matchAll(/onclick="detailopen\((\d+)\);return false;">([\s\S]*?)<\/a>/g)].map(x=>({id:x[1],name:clean(x[2])}));if(!companies.length)throw Error('layout_changed');
const company=companies.find(x=>norm(x.name)===norm(String(keyword)));const records=[];
if(company){const url=origin+'/Vendor/VendorDBView.aspx?SEQNO='+company.id;const d=await get(url);if(!d.includes('수상내역')||!d.includes('한글 업체명'))throw Error('layout_changed');base.source_url=url;
for(const t of d.matchAll(/<table\b[^>]*summary="([^"]*수상내역[^"]*)"[^>]*>([\s\S]*?)<\/table>/g)){
if(meta.want==='w2'&&!t[1].startsWith('웹어워드'))continue;
for(const row of t[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)){const c=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(x=>clean(x[1]));if(c.length>=3&&c[0])records.push({name:company.name,award:c[0],category:c[1],project:c[2],year:c[0].match(/20\d\d/)?.[0]||'',source_url:url});}}
}
if(meta.want==='w1'){const url=origin+'/Ba/json/ba2025web.json';const data=JSON.parse(await get(url));if(!Array.isArray(data)||!data.length||data.some(x=>!('company'in x)||!('no'in x)))throw Error('layout_changed');for(const x of data)if(norm(x.company)===norm(String(keyword)))records.push({name:x.company,rank:x.no,award:'Web Award Korea best digital agency',category:x.part,year:'2025',source_url:url});}
return {...base,status:records.length?'found':'not_found',reason:'',records,excerpt:(records.length?records.map(x=>Object.values(x).join(' ')).join(' | '):'No match in the published specialist DB award histories'+(meta.want==='w1'?' and 2025 Web Award agency ranking':'')).slice(0,500)};
}catch(e){return {...base,status:'couldnt_check',reason:['blocked','http_error','layout_changed','other'].includes(e.message)?e.message:e.name==='TimeoutError'?'timeout':'other'};}}
