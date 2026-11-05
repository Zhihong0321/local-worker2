export const meta={"task":"KR-kacpta.or.kr","want":"w1","tier":2,"method":"static_list","input":"company name","fields":["name","regional_tax_office","phone"],"canary":{"found":"나래세무법인","not_found":"삼일회계법인"}};
const clean=s=>s.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
const norm=s=>s.replace(/주식회사|\(주\)|㈜|[^\p{L}\p{N}]/gu,'').toLowerCase();
export default async function lookup(keyword){const source_url="https://www.kacpta.or.kr/kacpta_view/kac_taxbiz/taxAccountantSearch_n_Proc.asp?keyfield=2";const out=(status,reason='',records=[],excerpt='')=>({status,reason,records,source_url,excerpt});try{
await new Promise(r=>setTimeout(r,1100));const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const h=new TextDecoder('euc-kr').decode(await r.arrayBuffer());if(/captcha|cf-chl-|just a moment/i.test(h))return out('couldnt_check','blocked');if(!r.ok)return out('couldnt_check','http_error');
if(!h.includes("소속지방회명")||!h.includes("법인명"))return out('couldnt_check','layout_changed');
const rows=[...h.matchAll(/<tr align="Center" height="32">([\s\S]*?)<\/tr>/gi)].map(m=>[...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(t=>clean(t[1])));
if(!rows.length||rows.some(c=>c.length!==9))return out('couldnt_check','layout_changed');
const records=rows.map(c=>({name:c[3],regional_tax_office:c[1],phone:c[5]})).filter(x=>norm(x.name)===norm(keyword));
return out(records.length?'found':'not_found','',records,records.length?JSON.stringify(records).slice(0,500):'Full corporation list inspected');
}catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other')}}