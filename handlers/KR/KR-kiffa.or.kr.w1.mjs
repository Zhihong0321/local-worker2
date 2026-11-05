export const meta={task:'KR-kiffa.or.kr',want:'w1',tier:1,method:'url_template',input:'company name',fields:['region','name','english_name','representative'],canary:{found:'그린월드라인',not_found:'제이엘무역'}};
let last=0;const clean=s=>s.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export default async function lookup(keyword){
 const url='https://www.kiffa.or.kr/sub02/sub03.php?findtype=com_name&findword='+encodeURIComponent(keyword);
 const out=(status,reason,records,excerpt)=>({status,reason,records,source_url:url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,last+1100-Date.now())));last=Date.now();
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const t=await r.text();
  if(r.status===403||/captcha|cf-chl-|verify you are human/i.test(t))return out('couldnt_check','blocked',[],clean(t));
  if(!r.ok)return out('couldnt_check','http_error',[],String(r.status));
  const table=t.match(/<table class="tbl01">([\s\S]*?)<\/table>/)?.[1];
  if(!table||!table.includes('업체명')||!table.includes('대표자명'))return out('couldnt_check','layout_changed',[],clean(t));
  const rows=[];for(const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)){const cells=[...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x=>clean(x[1]));if(cells.length===4)rows.push(Object.fromEntries(meta.fields.map((f,i)=>[f,cells[i]])));}
  if(rows.length)return out('found','',rows,JSON.stringify(rows));
  if(!/<td\b/.test(table)&&t.includes('name="findword" value="'+keyword+'"'))return out('not_found','',[],'Filtered member table has zero rows for '+keyword);
  return out('couldnt_check','layout_changed',[],clean(table));
 }catch(e){return out('couldnt_check',e.name==='TimeoutError'?'timeout':'other',[],String(e));}
}
