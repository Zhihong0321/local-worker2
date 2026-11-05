export const meta={task:'KR-dea.or.kr',want:'w1',tier:1,method:'static_list',input:'company name',fields:['name','representative','address'],canary:{found:'더크림유니언',not_found:'삼성전자'}};
const clean=s=>s.replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
const norm=s=>s.replace(/주식회사|\(주\)|㈜|[^\p{L}\p{N}]/gu,'').toLowerCase();
export default async function lookup(keyword){
 const source_url='https://www.dea.or.kr/dea/intro/digi_comm.do';
 const out=(status,reason='',records=[],excerpt='')=>({status,reason,records,source_url,excerpt});
 try{
 await new Promise(r=>setTimeout(r,1100));
 const r=await fetch(source_url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)}); const h=await r.text();
 if(/captcha|cf-chl-|just a moment/i.test(h))return out('couldnt_check','blocked');
 if(!r.ok)return out('couldnt_check','http_error');
 const cards=h.split('<div class="b-member-box01">').slice(1);
 if(!h.includes('bn-list-person01')||!cards.length)return out('couldnt_check','layout_changed');
 const records=cards.map(c=>({name:clean(c.match(/<span>업체명<\/span>\s*<span>([\s\S]*?)<\/span>/)?.[1]||''),representative:clean(c.match(/class="b-name-ko">([\s\S]*?)<\/span>/)?.[1]||''),address:clean(c.match(/<span>주소<\/span>\s*<span>([\s\S]*?)<\/span>/)?.[1]||'')}));
 if(records.filter(x=>x.name).length<cards.length*0.9)return out('couldnt_check','layout_changed');
 const matches=records.filter(x=>norm(x.name)===norm(keyword));
 return out(matches.length?'found':'not_found','',matches,matches.length?JSON.stringify(matches).slice(0,500):`${records.length} member cards inspected`);
 }catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other');}
}
