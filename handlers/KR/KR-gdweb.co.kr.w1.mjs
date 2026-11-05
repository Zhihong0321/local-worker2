export const meta={task:'KR-gdweb.co.kr',want:'w1',tier:1,method:'static_list',input:'company name',fields:['name','rank','points','website','profile_url'],canary:{found:'플러스엑스',not_found:'삼성전자'}};
const text=s=>s.replace(/<!--[\s\S]*?-->/g,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.replace(/주식회사|\(주\)|㈜|[^\p{L}\p{N}]/gu,'').toLowerCase();
export default async function lookup(keyword){const source_url='https://www.gdweb.co.kr/sub/agency.asp';const out=(status,reason='',records=[],excerpt='')=>({status,reason,records,source_url,excerpt});try{
await new Promise(r=>setTimeout(r,1100));const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const h=await r.text();if(/captcha|cf-chl-|just a moment/i.test(h))return out('couldnt_check','blocked');if(!r.ok)return out('couldnt_check','http_error');
if(!h.includes('agency-tb')||!h.includes('적용순위'))return out('couldnt_check','layout_changed');
const records=[...h.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(m=>{const c=m[1];const val=k=>text(c.match(new RegExp('<td class="'+k+'"[^>]*>([\\s\\S]*?)<\\/td>'))?.[1]||'');return {name:val('name'),rank:val('no'),points:val('total'),website:val('url'),profile_url:new URL(c.match(/href="([^\"]*portfolio.asp[^\"]*)"/)?.[1]||source_url,source_url).href}}).filter(x=>x.name);
if(!records.length)return out('couldnt_check','layout_changed');const hits=records.filter(x=>norm(x.name)===norm(keyword));return out(hits.length?'found':'not_found','',hits,hits.length?JSON.stringify(hits).slice(0,500):`${records.length} agency ranking rows inspected`);
}catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other')}}
