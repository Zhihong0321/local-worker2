export const meta={task:'KR-innobiz.net',want:'w1',tier:1,method:'url_template',input:'company name',fields:['name','representative','region','evaluation','industry','expiry_date'],canary:{found:'해신솔루션',not_found:'세무법인 혜움'}};
let last=0;
const clean=s=>s.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim();
export default async function lookup(keyword){
 const url='https://www.innobiz.net/company/company2_list.asp?SearchKey=c&Co_Name='+encodeURIComponent(keyword);
 const result=(status,reason,records,excerpt)=>({status,reason,records,source_url:url,excerpt:excerpt.slice(0,500)});
 try{
  await new Promise(r=>setTimeout(r,Math.max(0,last+1100-Date.now())));last=Date.now();
  const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'},signal:AbortSignal.timeout(30000)});const t=await r.text();
  if(r.status===403||/captcha|cf-chl-|verify you are human/i.test(t))return result('couldnt_check','blocked',[],clean(t));
  if(!r.ok)return result('couldnt_check','http_error',[],String(r.status));
  if(!t.includes('이노비즈만료일')||!t.includes('대표자')||!t.includes('name="Co_Name"'))return result('couldnt_check','layout_changed',[],clean(t));
  const html=t.replace(/<!--[\s\S]*?-->/g,'');const tbody=html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1];
  if(!tbody)return result('couldnt_check','layout_changed',[],'Missing table body');
  const records=[];
  for(const tr of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)){
   const cells=[...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x=>clean(x[1]));
   if(cells.length===7&&/^\d+$/.test(cells[0]))records.push(Object.fromEntries(meta.fields.map((f,i)=>[f,cells[i+1]])));
  }
  if(records.length)return result('found','',records,JSON.stringify(records));
  const echoed=t.match(/name="Co_Name"\s+value="([^"]*)"/)?.[1];
  if(echoed===keyword&&(!tbody.trim()||/등록된.*없|검색.*없|자료.*없|데이터.*없/.test(clean(tbody))))return result('not_found','',[],'Valid filtered company table has no rows for '+keyword);
  return result('couldnt_check','layout_changed',[],clean(tbody));
 }catch(e){return result('couldnt_check',e.name==='TimeoutError'?'timeout':'other',[],String(e));}
}
