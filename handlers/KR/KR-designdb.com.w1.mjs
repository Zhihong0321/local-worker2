export const meta={task:"KR-designdb.com",want:'w1',tier:1,method:'static_list',input:'company name',fields:['name','field','website','category','validity'],canary:{found:'케이비에스 아트비전',not_found:'은민에스엔디'},notes:'Announcement HTML contains the complete 20-company roster; no PDF parsing or individual member pages.'};
const url="https://www.designdb.com/?menuno=780&bbsno=30222&siteno=15&ztag=rO0ABXQAOTxjYWxsIHR5cGU9ImJvYXJkIiBubz0iNTgxIiBza2luPSJwaG90b19iYnNfMjAxOSI%2BPC9jYWxsPg%3D%3D&act=view";
const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.normalize('NFKC').replace(/주식회사|\(주\)|㈜|\s+/g,'').toLowerCase();
export default async function lookup(keyword){const base={records:[],source_url:url,excerpt:''};try{
const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const h=await r.text();
if(/cf-chl-|captcha|verify you are human/i.test(h))return {...base,status:'couldnt_check',reason:'blocked'};
if(!r.ok)return {...base,status:'couldnt_check',reason:'http_error'};
if(!h.includes('[선도 - 10개 기업]')||!h.includes('[유망 - 10개 기업]'))return {...base,status:'couldnt_check',reason:h.includes('로그인')?'blocked':'layout_changed'};
const content=h.slice(h.indexOf('[선도 - 10개 기업]'));const tables=[...content.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].slice(0,2);
const rows=tables.flatMap((t,i)=>[...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row=>{const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];const cell=cells[1]?.[1]||'';const p=[...cell.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(x=>clean(x[1])).filter(Boolean);return {name:p[0],field:p[1],website:cell.match(/href="([^"]+)"/)?.[1]||'',category:i===0?'선도':'유망',validity:'2025.11.14–2027.12.31'};}));
if(rows.length!==20||rows.some(x=>!x.name||!x.field))return {...base,status:'couldnt_check',reason:'layout_changed'};
if(!norm(String(keyword)))return {...base,status:'couldnt_check',reason:'other'};
const records=rows.filter(x=>norm(x.name)===norm(String(keyword)));return {...base,status:records.length?'found':'not_found',reason:'',records,excerpt:records.map(x=>Object.values(x).join(' ')).join(' | ').slice(0,500)};
}catch(e){return {...base,status:'couldnt_check',reason:e.name==='TimeoutError'?'timeout':'other'};}}
